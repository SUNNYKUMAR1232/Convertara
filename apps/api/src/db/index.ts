import { config } from '../core/config.js';
import { logger } from '../core/logger.js';
import { MemoryRepository } from './memory.js';
import { PostgresRepository } from './postgres.js';
import type { Repository } from './types.js';

let repo: Repository | undefined;

export function repository(): Repository {
  if (!repo) {
    const url = config().DATABASE_URL;
    repo = url ? new PostgresRepository(url) : new MemoryRepository();
    logger.info({ driver: repo.driver }, 'metadata store ready');
  }
  return repo;
}

export async function closeRepository(): Promise<void> {
  await repo?.close();
  repo = undefined;
}

export type {
  ConversationRecord,
  FileRecord,
  JobRecord,
  JobStatus,
  LlmConfigRecord,
  LlmProvider,
  MessageRecord,
  Repository,
} from './types.js';
