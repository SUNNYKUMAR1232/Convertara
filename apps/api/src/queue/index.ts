import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { runJob } from '../execution/pipeline.js';

const QUEUE_NAME = 'convertara-jobs';

export interface JobQueue {
  readonly driver: 'redis' | 'inline';
  enqueue(jobId: string): Promise<void>;
  startWorker(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * Redis-backed queue. The API only ever enqueues; a separate worker process
 * (or several) consumes. That is the warm pool - scaling processing means
 * `docker compose up --scale worker=4`, not a code change.
 */
class RedisQueue implements JobQueue {
  readonly driver = 'redis' as const;
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker: Worker | undefined;

  constructor(url: string) {
    this.connection = new Redis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue(QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add(
      'process',
      { jobId },
      {
        jobId,
        attempts: 2,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 500 },
        removeOnFail: { age: 24 * 3600 },
      },
    );
  }

  async startWorker(): Promise<void> {
    const concurrency = config().WORKER_CONCURRENCY;
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data as { jobId: string };
        await runJob(jobId);
      },
      { connection: this.connection.duplicate(), concurrency },
    );

    this.worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err: err.message }, 'worker job failed'));
    this.worker.on('ready', () => logger.info({ concurrency }, 'queue worker ready'));
  }

  async ping(): Promise<boolean> {
    return (await this.connection.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    this.connection.disconnect();
  }
}

/**
 * No-Redis fallback: run the job in this process, bounded so a burst cannot
 * spawn unbounded concurrent encodes. Fine for a single container and for dev.
 */
class InlineQueue implements JobQueue {
  readonly driver = 'inline' as const;
  private running = 0;
  private readonly pending: string[] = [];

  async enqueue(jobId: string): Promise<void> {
    this.pending.push(jobId);
    this.drain();
  }

  private drain(): void {
    const limit = config().WORKER_CONCURRENCY;
    while (this.running < limit && this.pending.length > 0) {
      const jobId = this.pending.shift();
      if (!jobId) return;
      this.running += 1;
      void runJob(jobId)
        .catch((err) => logger.error({ jobId, err: (err as Error).message }, 'inline job failed'))
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  async startWorker(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }

  /**
   * Deploys happen constantly and this is where work gets lost. Stop taking new
   * jobs, let the running ones finish, then exit.
   */
  async close(): Promise<void> {
    this.pending.length = 0;
    const deadline = Date.now() + 30_000;
    while (this.running > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.running > 0) logger.warn({ running: this.running }, 'shutting down with jobs still in flight');
  }
}

let queue: JobQueue | undefined;

export function jobQueue(): JobQueue {
  if (!queue) {
    const url = config().REDIS_URL;
    queue = url ? new RedisQueue(url) : new InlineQueue();
    logger.info({ driver: queue.driver }, 'job queue ready');
  }
  return queue;
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  queue = undefined;
}
