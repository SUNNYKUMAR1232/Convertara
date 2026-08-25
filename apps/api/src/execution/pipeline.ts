import { createHash } from 'node:crypto';
import { decidePlan } from '../agent/router.js';
import { describeWindow, resolveConstraints } from '../constraints/engine.js';
import { config } from '../core/config.js';
import { AppError, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { formatBytes } from '../core/units.js';
import { repository } from '../db/index.js';
import type { FileRecord, JobRecord } from '../db/types.js';
import { bus } from '../events/bus.js';
import { objectKey, objectStore } from '../storage/index.js';
import type { WorkFile } from '../router/types.js';
import { safeFilename, sniffAndAssert } from '../security/sniff.js';
import { estimateCost, resolvePlan } from '../router/capability-router.js';
import { execute } from './executor.js';
import { narrowForPlan } from './selection.js';

export interface Upload {
  filename: string;
  data: Buffer;
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** Validates, stores and records an upload. Nothing reaches an engine unsniffed. */
export async function ingest(ownerId: string, uploads: Upload[]): Promise<FileRecord[]> {
  const cfg = config();
  if (uploads.length === 0) throw new AppError('BAD_REQUEST', 'No files were uploaded');
  if (uploads.length > cfg.MAX_FILES_PER_REQUEST) {
    throw new AppError('BAD_REQUEST', `At most ${cfg.MAX_FILES_PER_REQUEST} files per request`);
  }

  // Per-file limits do not bound a request: 64 files just under the cap is
  // still 12.8GB of heap at the shipped defaults.
  const requestBytes = uploads.reduce((n, u) => n + u.data.length, 0);
  if (requestBytes > cfg.MAX_REQUEST_BYTES) {
    throw new AppError(
      'FILE_TOO_LARGE',
      `That request totals ${formatBytes(requestBytes)}, over the ${formatBytes(cfg.MAX_REQUEST_BYTES)} limit for one request`,
    );
  }

  const records: FileRecord[] = [];
  for (const upload of uploads) {
    const filename = safeFilename(upload.filename);
    if (upload.data.length > cfg.MAX_UPLOAD_BYTES) {
      throw new AppError('FILE_TOO_LARGE', `${filename} is ${formatBytes(upload.data.length)}, over the limit`);
    }

    const mime = await sniffAndAssert(upload.data, filename);
    const id = newId();
    const key = objectKey('original', id, filename);
    await objectStore().put(key, upload.data, mime);

    records.push(
      await repository().createFile({
        id,
        ownerId,
        jobId: null,
        kind: 'original',
        filename,
        mime,
        bytes: upload.data.length,
        storageKey: key,
        checksum: sha256(upload.data),
        meta: {},
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + cfg.ARTIFACT_TTL_SECONDS * 1000),
      }),
    );
  }
  return records;
}

async function loadWorkFiles(records: FileRecord[]): Promise<WorkFile[]> {
  return Promise.all(
    records.map(async (record) => {
      const object = await objectStore().get(record.storageKey);
      return { name: record.filename, data: object.data, mime: record.mime, meta: { ...record.meta } };
    }),
  );
}

export interface SubmitOptions {
  ownerId: string;
  fileIds: string[];
  prompt?: string | undefined;
  plan?: unknown;
  /** Force a lane instead of letting the cost estimator choose. */
  mode?: 'auto' | 'sync' | 'async';
}

export interface SubmitResult {
  job: JobRecord;
  lane: 'sync' | 'async';
  planReason: string;
}

/**
 * Plan the work, then decide which lane it runs in. Small jobs finish inside
 * the request; anything expensive is queued so a slow PDF cannot hold an HTTP
 * connection hostage.
 */
export async function submit(options: SubmitOptions): Promise<SubmitResult> {
  const cfg = config();
  const repo = repository();

  const records = await Promise.all(
    options.fileIds.map(async (id) => {
      const record = await repo.getFile(id);
      if (!record) throw notFound(`File not found: ${id}`);
      if (record.ownerId !== options.ownerId) throw notFound(`File not found: ${id}`);
      return record;
    }),
  );
  if (records.length === 0) throw new AppError('BAD_REQUEST', 'Attach at least one file');

  const files = await loadWorkFiles(records);
  const decision = await decidePlan({
    ownerId: options.ownerId,
    files,
    prompt: options.prompt,
    plan: options.plan,
  });

  const jobId = newId();
  const now = new Date();
  const job = await repo.createJob({
    id: jobId,
    ownerId: options.ownerId,
    status: 'queued',
    prompt: options.prompt ?? null,
    plan: decision.plan,
    planSource: decision.plan.source,
    inputFileIds: records.map((r) => r.id),
    outputFileIds: [],
    progress: 0,
    stage: 'planned',
    evaluation: null,
    selection: null,
    error: null,
    timings: { plan: decision.latencyMs },
    createdAt: now,
    updatedAt: now,
  });

  bus.publish({ jobId, type: 'planned', message: decision.reason, data: decision.plan });

  // Cost is estimated against the resolved plan, so an unknown capability fails
  // here - before anything is queued - rather than inside a worker.
  // Estimate against the files the plan will actually touch, not everything
  // that was attached.
  const working = narrowForPlan(files, decision.plan).files;
  const operations = await resolvePlan(decision.plan, working);
  const totalBytes = working.reduce((n, f) => n + f.data.length, 0);
  const cost = estimateCost(operations, totalBytes);

  const lane: 'sync' | 'async' =
    options.mode === 'sync'
      ? 'sync'
      : options.mode === 'async'
        ? 'async'
        : totalBytes <= cfg.SYNC_MAX_BYTES && cost <= cfg.SYNC_MAX_COST
          ? 'sync'
          : 'async';

  logger.info({ jobId, lane, cost, totalBytes, route: decision.route }, 'job accepted');
  return { job, lane, planReason: decision.reason };
}

/** Runs a job to completion and persists everything about it. Used by both lanes. */
export async function runJob(jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  const repo = repository();
  const cfg = config();

  const job = await repo.getJob(jobId);
  if (!job) throw notFound(`Job not found: ${jobId}`);
  if (!job.plan) throw new AppError('INTERNAL', `Job ${jobId} has no plan`);

  await repo.updateJob(jobId, { status: 'running', stage: 'running', progress: 0 });

  try {
    const records = await Promise.all(
      job.inputFileIds.map(async (id) => {
        const record = await repo.getFile(id);
        if (!record) throw notFound(`Input file disappeared: ${id}`);
        return record;
      }),
    );

    // SSE is the good path, but a client that polls /v1/jobs/:id would see 0%
    // for the whole run and read it as hung. Mirror progress into the row,
    // throttled so a five-encode search is not five extra writes.
    let lastWrite = 0;
    const unsubscribe = bus.subscribe(jobId, (event) => {
      if (typeof event.progress !== 'number') return;
      const now = Date.now();
      if (now - lastWrite < 1000) return;
      lastWrite = now;
      void repo
        .updateJob(jobId, { progress: event.progress, stage: event.stage ?? null })
        .catch(() => undefined);
    });

    let result;
    try {
      result = await execute({
        jobId,
        plan: job.plan,
        files: await loadWorkFiles(records),
        ...(signal ? { signal } : {}),
      });
    } finally {
      unsubscribe();
    }

    const outputs: FileRecord[] = [];
    for (const file of result.files) {
      const id = newId();
      const key = objectKey('result', id, file.name);
      await objectStore().put(key, file.data, file.mime);
      outputs.push(
        await repo.createFile({
          id,
          ownerId: job.ownerId,
          jobId,
          kind: 'result',
          filename: file.name,
          mime: file.mime,
          bytes: file.data.length,
          storageKey: key,
          checksum: sha256(file.data),
          meta: file.meta,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + cfg.ARTIFACT_TTL_SECONDS * 1000),
        }),
      );
    }

    // Results are kept either way: a near miss is usually more useful to the
    // user than nothing at all, so the constraint failure is reported next to
    // the file rather than instead of it.
    const constraints = resolveConstraints(job.plan.constraints);
    const window = describeWindow(constraints);
    const failed = !result.satisfied;

    const updated = await repo.updateJob(jobId, {
      // `partial`, not `failed`: the run completed and the file is attached.
      status: failed ? 'partial' : 'succeeded',
      progress: 1,
      stage: 'done',
      outputFileIds: outputs.map((o) => o.id),
      evaluation: result.evaluation,
      selection: result.selection ?? null,
      timings: {
        ...job.timings,
        ...result.timings,
        attempts: result.attempts.length,
      },
      error: failed
        ? {
            code: 'CONSTRAINT_UNSATISFIABLE',
            message: window
              ? `Could not land ${window} without going below the quality floor. Closest result is attached.`
              : 'The output did not satisfy every constraint. Closest result is attached.',
          }
        : null,
    });

    bus.publish({
      jobId,
      type: failed ? 'partial' : 'succeeded',
      progress: 1,
      data: { outputs: outputs.map((o) => ({ id: o.id, filename: o.filename, bytes: o.bytes, mime: o.mime })) },
      ...(failed ? { message: updated.error?.message } : {}),
    });

    return updated;
  } catch (error) {
    const appError =
      error instanceof AppError ? error : new AppError('EXECUTION_FAILED', (error as Error).message);
    logger.error({ jobId, err: appError.message, code: appError.code }, 'job failed');

    const updated = await repo.updateJob(jobId, {
      status: 'failed',
      stage: 'failed',
      error: { code: appError.code, message: appError.message },
    });
    bus.publish({ jobId, type: 'failed', message: appError.message });
    return updated;
  }
}
