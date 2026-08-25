import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../core/errors.js';
import { repository } from '../../db/index.js';
import type { JobRecord } from '../../db/types.js';
import { bus } from '../../events/bus.js';
import { ingest, runJob, submit } from '../../execution/pipeline.js';
import type { Upload } from '../../execution/pipeline.js';
import { jobQueue } from '../../queue/index.js';
import { ownerOf } from '../context.js';

const processBody = z.object({
  fileIds: z.array(z.string().uuid()).min(1).max(64),
  prompt: z.string().max(2000).optional(),
  /** Skip planning entirely by supplying the plan yourself. */
  plan: z.unknown().optional(),
  mode: z.enum(['auto', 'sync', 'async']).default('auto'),
});

const idParams = z.object({ id: z.string().uuid() });

export async function processRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The main entry point. Small work is finished inside this request; large
   * work comes back `queued` and is followed on the SSE stream.
   */
  app.post('/v1/process', async (request, reply) => {
    const owner = ownerOf(request);
    const body = processBody.parse(request.body);

    const { job, lane, planReason } = await submit({
      ownerId: owner,
      fileIds: body.fileIds,
      prompt: body.prompt,
      plan: body.plan,
      mode: body.mode,
    });

    if (lane === 'sync') {
      const finished = await runJob(job.id);
      return reply.code(finished.status === 'failed' ? 200 : 200).send(await present(finished, planReason, lane));
    }

    await jobQueue().enqueue(job.id);
    bus.publish({ jobId: job.id, type: 'queued', message: 'Queued for processing' });
    return reply.code(202).send(await present(job, planReason, lane));
  });

  /** Upload and process in one round trip - what the web UI uses. */
  app.post('/v1/process/upload', async (request, reply) => {
    const owner = ownerOf(request);
    const uploads: Upload[] = [];
    let prompt = '';
    let mode: 'auto' | 'sync' | 'async' = 'auto';

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        uploads.push({ filename: part.filename || 'upload', data: await part.toBuffer() });
      } else if (part.fieldname === 'prompt') {
        prompt = String(part.value).slice(0, 2000);
      } else if (part.fieldname === 'mode') {
        const value = String(part.value);
        if (value === 'sync' || value === 'async' || value === 'auto') mode = value;
      }
    }

    const records = await ingest(owner, uploads);
    const { job, lane, planReason } = await submit({
      ownerId: owner,
      fileIds: records.map((r) => r.id),
      prompt,
      mode,
    });

    if (lane === 'sync') {
      const finished = await runJob(job.id);
      return reply.code(200).send(await present(finished, planReason, lane));
    }

    await jobQueue().enqueue(job.id);
    bus.publish({ jobId: job.id, type: 'queued', message: 'Queued for processing' });
    return reply.code(202).send(await present(job, planReason, lane));
  });

  app.get('/v1/jobs', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);
    const jobs = await repository().listJobs(ownerOf(request), query.limit);
    return { jobs: await Promise.all(jobs.map((job) => present(job))) };
  });

  app.get('/v1/jobs/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const job = await repository().getJob(id);
    if (!job || job.ownerId !== ownerOf(request)) throw notFound(`Job not found: ${id}`);
    return present(job);
  });

  /** Server-sent progress. Closes as soon as the job reaches a terminal state. */
  app.get('/v1/jobs/:id/events', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = idParams.parse(request.params);
    const job = await repository().getJob(id);
    if (!job || job.ownerId !== ownerOf(request)) throw notFound(`Job not found: ${id}`);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ jobId: id, type: 'snapshot', data: await present(job), at: new Date().toISOString() });

    if (job.status === 'succeeded' || job.status === 'failed') {
      reply.raw.end();
      return reply;
    }

    const unsubscribe = bus.subscribe(id, (event) => {
      send(event);
      if (event.type === 'succeeded' || event.type === 'failed') {
        unsubscribe();
        clearInterval(heartbeat);
        reply.raw.end();
      }
    });

    // Keeps proxies from reaping an idle connection mid-job.
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

    request.raw.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
    });

    return reply;
  });
}

async function present(job: JobRecord, planReason?: string, lane?: 'sync' | 'async') {
  const outputs = await Promise.all(
    job.outputFileIds.map(async (id) => {
      const record = await repository().getFile(id);
      return record
        ? {
            id: record.id,
            filename: record.filename,
            mime: record.mime,
            bytes: record.bytes,
            meta: record.meta,
            downloadUrl: `/v1/files/${record.id}/content`,
          }
        : null;
    }),
  );

  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    prompt: job.prompt,
    plan: job.plan,
    planSource: job.planSource,
    planReason,
    lane,
    evaluation: job.evaluation,
    error: job.error,
    timings: job.timings,
    inputs: job.inputFileIds,
    outputs: outputs.filter((o) => o !== null),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
