import type { Plan } from '../core/plan.js';
import type { Evaluation } from '../constraints/engine.js';

/**
 * `partial` means the work ran and produced output that does not satisfy every
 * constraint - a size target missed without going below the quality floor, say.
 * It exists because a client that branches on `failed` deletes a file it should
 * have kept, and that is the single most likely outcome this system has.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';

export interface FileRecord {
  id: string;
  ownerId: string;
  jobId: string | null;
  kind: 'original' | 'result';
  filename: string;
  mime: string;
  bytes: number;
  storageKey: string;
  checksum: string;
  meta: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date;
}

export interface JobRecord {
  id: string;
  ownerId: string;
  status: JobStatus;
  /** What the user typed, if anything. */
  prompt: string | null;
  plan: Plan | null;
  planSource: 'fast-path' | 'llm' | 'explicit' | null;
  inputFileIds: string[];
  outputFileIds: string[];
  progress: number;
  stage: string | null;
  evaluation: Evaluation | null;
  error: { code: string; message: string } | null;
  timings: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'custom';

export interface LlmConfigRecord {
  id: string;
  ownerId: string;
  label: string;
  provider: LlmProvider;
  model: string;
  baseUrl: string | null;
  /** AES-256-GCM ciphertext. The plaintext key never leaves this process. */
  apiKeyCiphertext: string | null;
  temperature: number;
  fallbackModel: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Repository {
  readonly driver: 'memory' | 'postgres';
  init(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;

  createFile(record: FileRecord): Promise<FileRecord>;
  getFile(id: string): Promise<FileRecord | null>;
  listFilesByJob(jobId: string): Promise<FileRecord[]>;
  deleteExpiredFiles(now: Date): Promise<FileRecord[]>;

  createJob(record: JobRecord): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord>;
  listJobs(ownerId: string, limit: number): Promise<JobRecord[]>;

  upsertLlmConfig(record: LlmConfigRecord): Promise<LlmConfigRecord>;
  getLlmConfig(id: string): Promise<LlmConfigRecord | null>;
  listLlmConfigs(ownerId: string): Promise<LlmConfigRecord[]>;
  getDefaultLlmConfig(ownerId: string): Promise<LlmConfigRecord | null>;
  deleteLlmConfig(id: string): Promise<void>;
}
