import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { LocalStore } from './local.js';
import { S3Store } from './s3.js';
import type { ObjectStore } from './types.js';

let store: ObjectStore | undefined;

export function objectStore(): ObjectStore {
  if (!store) {
    const cfg = config();
    store = cfg.STORAGE_DRIVER === 's3' ? new S3Store(cfg) : new LocalStore(cfg.STORAGE_LOCAL_DIR);
    logger.info({ driver: store.driver }, 'object store ready');
  }
  return store;
}

export { objectKey } from './types.js';
export type { Bucket, ObjectStore, StoredObject } from './types.js';
