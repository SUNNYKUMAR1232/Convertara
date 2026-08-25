import { notFound } from '../core/errors.js';
import type {
  ConversationRecord,
  FileRecord,
  JobRecord,
  LlmConfigRecord,
  MessageRecord,
  Repository,
} from './types.js';

/**
 * In-process metadata store. Selected automatically when DATABASE_URL is unset
 * so `npm run dev` works with nothing installed. Never use it with more than
 * one API process - it has no shared state.
 */
export class MemoryRepository implements Repository {
  readonly driver = 'memory' as const;
  private readonly files = new Map<string, FileRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly llm = new Map<string, LlmConfigRecord>();
  private readonly conversations = new Map<string, ConversationRecord>();
  private readonly messages = new Map<string, MessageRecord[]>();

  async init(): Promise<void> {}
  async ping(): Promise<boolean> {
    return true;
  }
  async close(): Promise<void> {}

  async createFile(record: FileRecord): Promise<FileRecord> {
    this.files.set(record.id, record);
    return record;
  }

  async getFile(id: string): Promise<FileRecord | null> {
    return this.files.get(id) ?? null;
  }

  async listFilesByJob(jobId: string): Promise<FileRecord[]> {
    return [...this.files.values()].filter((f) => f.jobId === jobId);
  }

  async deleteExpiredFiles(now: Date): Promise<FileRecord[]> {
    const expired = [...this.files.values()].filter((f) => f.expiresAt <= now);
    for (const file of expired) this.files.delete(file.id);
    return expired;
  }

  async createJob(record: JobRecord): Promise<JobRecord> {
    this.jobs.set(record.id, record);
    return record;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord> {
    const current = this.jobs.get(id);
    if (!current) throw notFound(`Job not found: ${id}`);
    const next = { ...current, ...patch, updatedAt: new Date() };
    this.jobs.set(id, next);
    return next;
  }

  async listJobs(ownerId: string, limit: number): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((j) => j.ownerId === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async upsertLlmConfig(record: LlmConfigRecord): Promise<LlmConfigRecord> {
    if (record.isDefault) {
      for (const [id, cfg] of this.llm) {
        if (cfg.ownerId === record.ownerId && id !== record.id) this.llm.set(id, { ...cfg, isDefault: false });
      }
    }
    this.llm.set(record.id, record);
    return record;
  }

  async getLlmConfig(id: string): Promise<LlmConfigRecord | null> {
    return this.llm.get(id) ?? null;
  }

  async listLlmConfigs(ownerId: string): Promise<LlmConfigRecord[]> {
    return [...this.llm.values()]
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getDefaultLlmConfig(ownerId: string): Promise<LlmConfigRecord | null> {
    const owned = await this.listLlmConfigs(ownerId);
    return owned.find((c) => c.isDefault) ?? owned[0] ?? null;
  }

  async deleteLlmConfig(id: string): Promise<void> {
    this.llm.delete(id);
  }

  async createConversation(record: ConversationRecord): Promise<ConversationRecord> {
    this.conversations.set(record.id, record);
    return record;
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    return this.conversations.get(id) ?? null;
  }

  async listConversations(ownerId: string, limit: number): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter((c) => c.ownerId === ownerId)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, limit);
  }

  async touchConversation(id: string, title?: string): Promise<void> {
    const current = this.conversations.get(id);
    if (!current) return;
    this.conversations.set(id, { ...current, updatedAt: new Date(), title: title ?? current.title });
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    this.messages.delete(id);
  }

  async addMessage(record: MessageRecord): Promise<MessageRecord> {
    const thread = this.messages.get(record.conversationId) ?? [];
    thread.push(record);
    this.messages.set(record.conversationId, thread);
    return record;
  }

  async listMessages(conversationId: string, limit: number): Promise<MessageRecord[]> {
    return (this.messages.get(conversationId) ?? []).slice(-limit);
  }
}
