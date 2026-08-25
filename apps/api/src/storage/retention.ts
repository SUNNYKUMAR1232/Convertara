import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { repository } from '../db/index.js';
import { objectStore } from './index.js';

const INTERVAL_MS = 10 * 60 * 1000;

/**
 * Uploads and results are temporary by design - users hand us their files, so
 * the safest thing to hold is nothing. Expired rows are deleted along with the
 * blob they point at.
 */
export function startRetentionSweeper(): () => void {
  const sweep = async (): Promise<void> => {
    try {
      const expired = await repository().deleteExpiredFiles(new Date());
      for (const file of expired) {
        await objectStore().delete(file.storageKey).catch((err) => {
          logger.warn({ key: file.storageKey, err: (err as Error).message }, 'could not delete blob');
        });
      }
      if (expired.length > 0) logger.info({ count: expired.length }, 'retention sweep removed expired files');
    } catch (error) {
      logger.warn({ err: (error as Error).message }, 'retention sweep failed');
    }
  };

  void sweep();
  const timer = setInterval(() => void sweep(), INTERVAL_MS);
  timer.unref();
  logger.info({ ttlSeconds: config().ARTIFACT_TTL_SECONDS }, 'retention sweeper started');

  return () => clearInterval(timer);
}
