import { bootstrap } from './bootstrap.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { closeRepository } from './db/index.js';
import { bus } from './events/bus.js';
import { buildServer } from './gateway/server.js';
import { closeQueue, jobQueue } from './queue/index.js';
import { startRetentionSweeper } from './storage/retention.js';

const cfg = config();

async function main(): Promise<void> {
  await bootstrap();

  const app = await buildServer();

  // With Redis the API only enqueues and a separate worker process consumes.
  // Without it, this process is also the worker - which is what makes
  // `npm run dev` work with no infrastructure at all.
  if (jobQueue().driver === 'inline') {
    logger.info('no REDIS_URL: running jobs in this process');
  }

  const stopSweeper = startRetentionSweeper();
  await app.listen({ host: cfg.HOST, port: cfg.PORT });
  logger.info({ port: cfg.PORT, env: cfg.NODE_ENV }, 'convertara api listening');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopSweeper();
    await app.close();
    await closeQueue();
    await bus.close();
    await closeRepository();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
