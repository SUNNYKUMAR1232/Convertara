import { EventEmitter } from 'node:events';
import { Redis } from 'ioredis';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

export interface JobEvent {
  jobId: string;
  type: 'queued' | 'planned' | 'progress' | 'stage' | 'succeeded' | 'failed';
  progress?: number;
  stage?: string;
  message?: string;
  data?: unknown;
  at: string;
}

const CHANNEL = 'convertara:events';

/**
 * Progress events for SSE. In-process by default; when Redis is configured the
 * same events are fanned out through pub/sub so a queue worker in another
 * container can drive a stream held open by any API replica.
 */
class EventBus {
  private readonly local = new EventEmitter();
  private publisher: Redis | undefined;
  private subscriber: Redis | undefined;

  constructor() {
    this.local.setMaxListeners(0);
  }

  async connect(): Promise<void> {
    const url = config().REDIS_URL;
    if (!url || this.publisher) return;

    this.publisher = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    this.subscriber = new Redis(url, { maxRetriesPerRequest: null, lazyConnect: true });
    await this.publisher.connect();
    await this.subscriber.connect();
    await this.subscriber.subscribe(CHANNEL);

    this.subscriber.on('message', (_channel, payload) => {
      try {
        const event = JSON.parse(payload) as JobEvent;
        this.local.emit(event.jobId, event);
      } catch (error) {
        logger.warn({ err: error }, 'dropped malformed event');
      }
    });
    logger.info('event bus attached to redis');
  }

  publish(event: Omit<JobEvent, 'at'>): void {
    const full: JobEvent = { ...event, at: new Date().toISOString() };
    if (this.publisher) void this.publisher.publish(CHANNEL, JSON.stringify(full));
    else this.local.emit(full.jobId, full);
  }

  subscribe(jobId: string, handler: (event: JobEvent) => void): () => void {
    this.local.on(jobId, handler);
    return () => this.local.off(jobId, handler);
  }

  async close(): Promise<void> {
    await this.publisher?.quit().catch(() => undefined);
    await this.subscriber?.quit().catch(() => undefined);
    this.publisher = undefined;
    this.subscriber = undefined;
  }
}

export const bus = new EventBus();
