import { resolveConstraints } from '../constraints/engine.js';
import type { Evaluation } from '../constraints/engine.js';
import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type { Plan } from '../core/plan.js';
import { bus } from '../events/bus.js';
import { estimateCost, resolvePlan } from '../router/capability-router.js';
import { registry } from '../router/registry.js';
import type { EngineContext, WorkFile } from '../router/types.js';
import { buildZip } from '../engines/archive/index.js';
import { validateOutputs } from '../validation/validator.js';
import { solveSizeTarget } from './optimizer.js';
import type { Attempt } from './optimizer.js';

export interface ExecuteOptions {
  jobId: string;
  plan: Plan;
  files: WorkFile[];
  signal?: AbortSignal;
}

export interface ExecuteResult {
  files: WorkFile[];
  evaluation: Evaluation;
  satisfied: boolean;
  attempts: Attempt[];
  timings: Record<string, number>;
}

export function domainForMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'archive';
  return 'unknown';
}

/**
 * Runs a resolved plan end to end: operations, then the deterministic size
 * search, then validation. No LLM is reachable from here - by the time control
 * arrives the plan is already a fixed list of capability calls.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteResult> {
  const cfg = config();
  const timings: Record<string, number> = {};
  const started = Date.now();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.EXECUTION_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;

  try {
    const constraints = resolveConstraints(options.plan.constraints);
    const operations = await resolvePlan(options.plan, options.files);
    timings.resolve = Date.now() - started;

    let files = options.files;
    const totalOps = operations.length;

    for (const [index, { capability, params }] of operations.entries()) {
      const opStarted = Date.now();
      signal.throwIfAborted();

      bus.publish({
        jobId: options.jobId,
        type: 'stage',
        stage: capability.name,
        progress: index / (totalOps + 1),
        message: capability.title,
      });

      const ctx: EngineContext = {
        logger: logger.child({ jobId: options.jobId, op: capability.name }),
        signal,
        constraints,
        progress: (fraction) => {
          bus.publish({
            jobId: options.jobId,
            type: 'progress',
            progress: (index + Math.min(1, Math.max(0, fraction))) / (totalOps + 1),
            stage: capability.name,
          });
        },
      };

      try {
        files = await capability.run({ files, params: params as never, ctx });
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (signal.aborted) throw new AppError('EXECUTION_TIMEOUT', `${capability.name} exceeded the time limit`);
        throw new AppError('EXECUTION_FAILED', `${capability.name} failed: ${(error as Error).message}`);
      }

      if (files.length === 0) throw new AppError('EXECUTION_FAILED', `${capability.name} produced no output`);
      timings[capability.name] = Date.now() - opStarted;
    }

    // Deterministic size search, once the pipeline has settled on a format.
    const attempts: Attempt[] = [];
    if (constraints.size) {
      const optimiseStarted = Date.now();
      bus.publish({
        jobId: options.jobId,
        type: 'stage',
        stage: 'optimize',
        progress: totalOps / (totalOps + 1),
        message: 'Hitting the size target',
      });

      // Bounded on purpose: an unbounded Promise.all over a 64-file batch is up
      // to 15 encodes each, all at once, and the box dies before the queue
      // notices. Peak memory is roughly this limit x largest input x 3.
      files = await mapWithLimit(files, cfg.WORKER_CONCURRENCY, async (file) => {
        const optimizer = registry.optimizerFor(domainForMime(file.mime));
        if (!optimizer?.supports(file)) return file;

        const ctx: EngineContext = {
          logger: logger.child({ jobId: options.jobId, op: 'optimize' }),
          signal,
          constraints,
          progress: (fraction) =>
            bus.publish({
              jobId: options.jobId,
              type: 'progress',
              progress: (totalOps + fraction) / (totalOps + 1),
              stage: 'optimize',
            }),
        };

        const solution = await solveSizeTarget(file, constraints, optimizer, ctx);
        attempts.push(...solution.attempts);
        return solution.file;
      });
      timings.optimize = Date.now() - optimiseStarted;
    }

    const evaluation = await validateOutputs(files, constraints);
    files = await bundle(files, options.plan);

    timings.total = Date.now() - started;
    timings.cost = estimateCost(operations, options.files.reduce((n, f) => n + f.data.length, 0));

    return { files, evaluation, satisfied: evaluation.pass, attempts, timings };
  } finally {
    clearTimeout(timeout);
  }
}

/** Promise.all with a ceiling, preserving input order. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item !== undefined) results[index] = await fn(item);
    }
  });

  await Promise.all(workers);
  return results;
}

async function bundle(files: WorkFile[], plan: Plan): Promise<WorkFile[]> {
  const mode = plan.output.bundle;
  const alreadyZipped = files.length === 1 && files[0]?.mime === 'application/zip';
  if (files.length <= 1 || mode === 'single' || alreadyZipped) return files;
  if (mode === 'auto' || mode === 'zip') {
    const name = plan.output.filename ?? 'convertara-results.zip';
    return [await buildZip(files, 6, name.endsWith('.zip') ? name : `${name}.zip`)];
  }
  return files;
}
