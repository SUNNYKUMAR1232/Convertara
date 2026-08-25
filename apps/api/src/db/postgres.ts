import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { notFound } from '../core/errors.js';
import { logger } from '../core/logger.js';
import type {
  ConversationRecord,
  FileRecord,
  JobRecord,
  LlmConfigRecord,
  MessageRecord,
  Repository,
} from './types.js';

const here = dirname(fileURLToPath(import.meta.url));

type Row = Record<string, any>;

const toFile = (r: Row): FileRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  jobId: r.job_id,
  kind: r.kind,
  filename: r.filename,
  mime: r.mime,
  bytes: Number(r.bytes),
  storageKey: r.storage_key,
  checksum: r.checksum,
  meta: r.meta ?? {},
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

const toJob = (r: Row): JobRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  status: r.status,
  prompt: r.prompt,
  plan: r.plan,
  planSource: r.plan_source,
  inputFileIds: r.input_file_ids ?? [],
  outputFileIds: r.output_file_ids ?? [],
  progress: Number(r.progress ?? 0),
  stage: r.stage,
  evaluation: r.evaluation,
  selection: r.selection ?? null,
  error: r.error,
  timings: r.timings ?? {},
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toConversation = (r: Row): ConversationRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toMessage = (r: Row): MessageRecord => ({
  id: r.id,
  conversationId: r.conversation_id,
  role: r.role,
  text: r.text,
  attachmentIds: r.attachment_ids ?? [],
  jobId: r.job_id,
  createdAt: r.created_at,
});

const toLlm = (r: Row): LlmConfigRecord => ({
  id: r.id,
  ownerId: r.owner_id,
  label: r.label,
  provider: r.provider,
  model: r.model,
  baseUrl: r.base_url,
  apiKeyCiphertext: r.api_key_ciphertext,
  temperature: Number(r.temperature),
  fallbackModel: r.fallback_model,
  isDefault: r.is_default,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Columns a job patch may touch, mapped to their SQL names. */
const JOB_COLUMNS: Record<string, string> = {
  status: 'status',
  prompt: 'prompt',
  plan: 'plan',
  planSource: 'plan_source',
  inputFileIds: 'input_file_ids',
  outputFileIds: 'output_file_ids',
  progress: 'progress',
  stage: 'stage',
  evaluation: 'evaluation',
  selection: 'selection',
  error: 'error',
  timings: 'timings',
};

const JSON_COLUMNS = new Set(['plan', 'evaluation', 'selection', 'error', 'timings']);

export class PostgresRepository implements Repository {
  readonly driver = 'postgres' as const;
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
    this.pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));
  }

  async init(): Promise<void> {
    const sql = await readFile(join(here, 'schema.sql'), 'utf8');
    await this.pool.query(sql);
    logger.info('postgres schema ready');
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createFile(r: FileRecord): Promise<FileRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO files (id, owner_id, job_id, kind, filename, mime, bytes, storage_key, checksum, meta, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        r.id,
        r.ownerId,
        r.jobId,
        r.kind,
        r.filename,
        r.mime,
        r.bytes,
        r.storageKey,
        r.checksum,
        JSON.stringify(r.meta),
        r.createdAt,
        r.expiresAt,
      ],
    );
    return toFile(rows[0]);
  }

  async getFile(id: string): Promise<FileRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE id = $1', [id]);
    return rows[0] ? toFile(rows[0]) : null;
  }

  async listFilesByJob(jobId: string): Promise<FileRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM files WHERE job_id = $1 ORDER BY created_at', [jobId]);
    return rows.map(toFile);
  }

  async deleteExpiredFiles(now: Date): Promise<FileRecord[]> {
    const { rows } = await this.pool.query('DELETE FROM files WHERE expires_at <= $1 RETURNING *', [now]);
    return rows.map(toFile);
  }

  async createJob(r: JobRecord): Promise<JobRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO jobs (id, owner_id, status, prompt, plan, plan_source, input_file_ids, output_file_ids,
                         progress, stage, evaluation, selection, error, timings, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        r.id,
        r.ownerId,
        r.status,
        r.prompt,
        r.plan ? JSON.stringify(r.plan) : null,
        r.planSource,
        r.inputFileIds,
        r.outputFileIds,
        r.progress,
        r.stage,
        r.evaluation ? JSON.stringify(r.evaluation) : null,
        r.selection ? JSON.stringify(r.selection) : null,
        r.error ? JSON.stringify(r.error) : null,
        JSON.stringify(r.timings),
        r.createdAt,
        r.updatedAt,
      ],
    );
    return toJob(rows[0]);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, column] of Object.entries(JOB_COLUMNS)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      values.push(JSON_COLUMNS.has(column) && value !== null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}`);
    }

    sets.push('updated_at = now()');
    values.push(id);

    const { rows } = await this.pool.query(
      `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values,
    );
    if (!rows[0]) throw notFound(`Job not found: ${id}`);
    return toJob(rows[0]);
  }

  async listJobs(ownerId: string, limit: number): Promise<JobRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM jobs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2',
      [ownerId, limit],
    );
    return rows.map(toJob);
  }

  async upsertLlmConfig(r: LlmConfigRecord): Promise<LlmConfigRecord> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (r.isDefault) {
        await client.query('UPDATE llm_configs SET is_default = false WHERE owner_id = $1 AND id <> $2', [
          r.ownerId,
          r.id,
        ]);
      }
      const { rows } = await client.query(
        `INSERT INTO llm_configs (id, owner_id, label, provider, model, base_url, api_key_ciphertext,
                                  temperature, fallback_model, is_default, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (id) DO UPDATE SET
           label = EXCLUDED.label, provider = EXCLUDED.provider, model = EXCLUDED.model,
           base_url = EXCLUDED.base_url, api_key_ciphertext = EXCLUDED.api_key_ciphertext,
           temperature = EXCLUDED.temperature, fallback_model = EXCLUDED.fallback_model,
           is_default = EXCLUDED.is_default, updated_at = now()
         RETURNING *`,
        [
          r.id,
          r.ownerId,
          r.label,
          r.provider,
          r.model,
          r.baseUrl,
          r.apiKeyCiphertext,
          r.temperature,
          r.fallbackModel,
          r.isDefault,
          r.createdAt,
        ],
      );
      await client.query('COMMIT');
      return toLlm(rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getLlmConfig(id: string): Promise<LlmConfigRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM llm_configs WHERE id = $1', [id]);
    return rows[0] ? toLlm(rows[0]) : null;
  }

  async listLlmConfigs(ownerId: string): Promise<LlmConfigRecord[]> {
    const { rows } = await this.pool.query('SELECT * FROM llm_configs WHERE owner_id = $1 ORDER BY created_at', [
      ownerId,
    ]);
    return rows.map(toLlm);
  }

  async getDefaultLlmConfig(ownerId: string): Promise<LlmConfigRecord | null> {
    const { rows } = await this.pool.query(
      'SELECT * FROM llm_configs WHERE owner_id = $1 ORDER BY is_default DESC, created_at LIMIT 1',
      [ownerId],
    );
    return rows[0] ? toLlm(rows[0]) : null;
  }

  async deleteLlmConfig(id: string): Promise<void> {
    await this.pool.query('DELETE FROM llm_configs WHERE id = $1', [id]);
  }

  async createConversation(r: ConversationRecord): Promise<ConversationRecord> {
    const { rows } = await this.pool.query(
      'INSERT INTO conversations (id, owner_id, title, created_at, updated_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [r.id, r.ownerId, r.title, r.createdAt, r.updatedAt],
    );
    return toConversation(rows[0]);
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    const { rows } = await this.pool.query('SELECT * FROM conversations WHERE id = $1', [id]);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async listConversations(ownerId: string, limit: number): Promise<ConversationRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM conversations WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2',
      [ownerId, limit],
    );
    return rows.map(toConversation);
  }

  async touchConversation(id: string, title?: string): Promise<void> {
    await this.pool.query(
      'UPDATE conversations SET updated_at = now(), title = COALESCE($2, title) WHERE id = $1',
      [id, title ?? null],
    );
  }

  async deleteConversation(id: string): Promise<void> {
    await this.pool.query('DELETE FROM conversations WHERE id = $1', [id]);
  }

  async addMessage(r: MessageRecord): Promise<MessageRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO messages (id, conversation_id, role, text, attachment_ids, job_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [r.id, r.conversationId, r.role, r.text, r.attachmentIds, r.jobId, r.createdAt],
    );
    return toMessage(rows[0]);
  }

  async listMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2) t ORDER BY created_at',
      [conversationId, limit],
    );
    return rows.map(toMessage);
  }
}
