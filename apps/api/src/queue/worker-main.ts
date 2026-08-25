import { bootstrap } from '../bootstrap.js';
import { logger } from '../core/logger.js';
import { closeRepository } from '../db/index.js';
import { bus } from '../events/bus.js';
import { closeQueue, jobQueue } from './index.js';

/**
 * Standalone worker process. Same code, same engines, no HTTP surface - scale
 * it independently of the API when processing is the bottleneck.
 */
async function main(): Promise<void> {
  await bootstrap();

  const queue = jobQueue();
  if (queue.driver === 'inline') {
    logger.error('REDIS_URL is required to run a standalone worker');
    process.exit(1);
  }

  await queue.startWorker();
  logger.info('convertara worker started');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutting down');
    await closeQueue();
    await bus.close();
    await closeRepository();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
