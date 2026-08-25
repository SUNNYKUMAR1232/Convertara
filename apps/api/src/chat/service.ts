import { AppError, notFound } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { logger } from '../core/logger.js';
import { formatBytes } from '../core/units.js';
import { repository } from '../db/index.js';
import type { ConversationRecord, FileRecord, MessageRecord } from '../db/types.js';
import { bus } from '../events/bus.js';
import { runJob, submit } from '../execution/pipeline.js';
import { converse } from '../llm/converse.js';
import { llm } from '../llm/manager.js';
import { jobQueue } from '../queue/index.js';
import { buildAdjustment } from './adjust.js';
import type { Adjustment } from './adjust.js';
import { humaniseError } from './errors.js';
import { capabilitiesReply, classifyTurn, greetingReply, thanksReply, unclearReply } from './intent.js';
import { NO_FILE_REPLY, describeResult } from './reply.js';

export interface TurnRequest {
  ownerId: string;
  conversationId?: string | undefined;
  text: string;
  /** Absent on a follow-up, which is the normal case after the first turn. */
  fileIds?: string[] | undefined;
}

export type TurnEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'message'; message: SerialisedMessage }
  | { type: 'status'; text: string }
  | { type: 'progress'; fraction: number; stage?: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: SerialisedMessage }
  | { type: 'error'; message: string };

export interface SerialisedMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  jobId: string | null;
  attachments: Array<{
    id: string;
    filename: string;
    mime: string;
    bytes: number;
    meta: Record<string, unknown>;
    downloadUrl: string;
  }>;
}

const HISTORY_LIMIT = 20;

/**
 * One conversational turn.
 *
 * The chat layer decides *what kind* of turn this is and where the files come
 * from; everything after that is the same planner and the same deterministic
 * engine the plain API uses. Chat is a surface, not a second pipeline.
 */
export async function* handleTurn(request: TurnRequest): AsyncGenerator<TurnEvent, void, undefined> {
  const repo = repository();
  const conversation = await resolveConversation(repo, request);
  yield { type: 'conversation', id: conversation.id, title: conversation.title };

  const attachments = await loadFiles(request.fileIds ?? [], request.ownerId);
  const userMessage = await repo.addMessage({
    id: newId(),
    conversationId: conversation.id,
    role: 'user',
    text: request.text,
    attachmentIds: attachments.map((f) => f.id),
    jobId: null,
    createdAt: new Date(),
  });
  yield { type: 'message', message: serialise(userMessage, attachments) };

  const history = await repo.listMessages(conversation.id, HISTORY_LIMIT);

  // "Now make it a PDF" has no attachment of its own - it means whatever the
  // last turn produced. Carrying that forward is what makes this a
  // conversation rather than a series of unrelated uploads.
  const carried = attachments.length > 0 ? attachments : await inheritFiles(repo, history, request.ownerId);
  const kind = classifyTurn(request.text, carried.length > 0);

  try {
    if (kind === 'operation') {
      yield* runOperation(request, conversation, carried);
      return;
    }

    const canned =
      kind === 'greeting'
        ? greetingReply(carried.length > 0)
        : kind === 'thanks'
          ? thanksReply(carried.length > 0)
          : kind === 'capabilities'
            ? await capabilitiesReply()
            : kind === 'unclear'
              ? unclearReply(carried[0]?.filename)
              : undefined;

    if (canned !== undefined) {
      yield { type: 'delta', text: canned };
      yield { type: 'done', message: await save(repo, conversation, canned, [], null) };
      return;
    }

    yield* answerQuestion(request, conversation, history, carried);
  } catch (error) {
    // The raw message goes to the log; the user gets a sentence they can act on.
    const message = humaniseError(error);
    logger.error({ err: error, conversationId: conversation.id }, 'chat turn failed');
    yield { type: 'delta', text: message };
    yield { type: 'done', message: await save(repo, conversation, message, [], null) };
  }
}

export interface AdjustRequest {
  ownerId: string;
  conversationId: string;
  fileId: string;
  adjustment: Adjustment;
}

/**
 * An adjustment from the editor. It lands in the thread as an ordinary turn -
 * a user message saying what was asked for and an assistant message with the
 * result - so dragging a crop box and typing an instruction produce the same
 * kind of history.
 */
export async function* handleAdjust(request: AdjustRequest): AsyncGenerator<TurnEvent, void, undefined> {
  const repo = repository();
  const conversation = await repo.getConversation(request.conversationId);
  if (!conversation || conversation.ownerId !== request.ownerId) throw notFound('Conversation not found');

  const files = await loadFiles([request.fileId], request.ownerId);
  const source = files[0];
  if (!source) throw notFound('That file is no longer available');

  const { plan, label } = buildAdjustment(request.adjustment);

  const userMessage = await repo.addMessage({
    id: newId(),
    conversationId: conversation.id,
    role: 'user',
    text: label,
    attachmentIds: [],
    jobId: null,
    createdAt: new Date(),
  });
  yield { type: 'conversation', id: conversation.id, title: conversation.title };
  yield { type: 'message', message: serialise(userMessage, []) };

  try {
    yield* runOperation({ ownerId: request.ownerId, text: label }, conversation, [source], plan);
  } catch (error) {
    const message = humaniseError(error);
    logger.error({ err: error, conversationId: conversation.id }, 'adjustment failed');
    yield { type: 'delta', text: message };
    yield { type: 'done', message: await save(repo, conversation, message, [], null) };
  }
}

async function* runOperation(
  request: TurnRequest,
  conversation: ConversationRecord,
  files: FileRecord[],
  explicitPlan?: unknown,
): AsyncGenerator<TurnEvent, void, undefined> {
  const repo = repository();
  yield { type: 'status', text: explicitPlan ? 'Applying' : 'Working out what you want' };

  const { job, lane } = await submit({
    ownerId: request.ownerId,
    fileIds: files.map((f) => f.id),
    prompt: request.text,
    ...(explicitPlan ? { plan: explicitPlan } : {}),
    mode: 'auto',
  });

  if (!explicitPlan) {
    yield {
      type: 'status',
      text: job.planSource === 'fast-path' ? 'Understood without asking a model' : 'Planned',
    };
  }

  // Progress arrives on the same bus the SSE job stream uses, so a queued turn
  // reports exactly what a queued job would.
  const queue: TurnEvent[] = [];
  let notify: (() => void) | undefined;
  const unsubscribe = bus.subscribe(job.id, (event) => {
    if (typeof event.progress === 'number') {
      queue.push({ type: 'progress', fraction: event.progress, ...(event.stage ? { stage: event.stage } : {}) });
      notify?.();
    }
  });

  try {
    const finished = lane === 'sync' ? runJob(job.id) : enqueueAndWait(job.id);

    let settled = false;
    const result = finished.finally(() => {
      settled = true;
      notify?.();
    });

    // Drain progress events until the job resolves.
    while (!settled) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
      }
      if (settled) break;
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 250);
      });
    }
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) yield next;
    }

    const done = await result;
    const outputs = await loadFiles(done.outputFileIds, request.ownerId);
    const text = describeResult(
      done,
      files.map(toReplyFile),
      outputs.map(toReplyFile),
    );

    yield { type: 'delta', text };
    yield { type: 'done', message: await save(repo, conversation, text, outputs, done.id) };
  } finally {
    unsubscribe();
  }
}

async function enqueueAndWait(jobId: string) {
  await jobQueue().enqueue(jobId);
  const repo = repository();
  const deadline = Date.now() + 15 * 60 * 1000;

  // The worker may be another process, so poll the row it writes.
  while (Date.now() < deadline) {
    const job = await repo.getJob(jobId);
    if (job && job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new AppError('EXECUTION_TIMEOUT', 'That job is taking longer than expected. Check back on it shortly.');
}

async function* answerQuestion(
  request: TurnRequest,
  conversation: ConversationRecord,
  history: MessageRecord[],
  files: FileRecord[],
): AsyncGenerator<TurnEvent, void, undefined> {
  const settings = await llm.settingsFor(request.ownerId);
  if (!settings) {
    const text =
      'I can only answer open questions when a language model is configured - add one under Settings. Everything else still works: attach a file and give me a direct instruction like "compress to 300 KB" or "convert to WebP".';
    yield { type: 'delta', text };
    yield { type: 'done', message: await save(repository(), conversation, text, [], null) };
    return;
  }

  const inventory =
    files.length > 0
      ? `\n\nFiles currently in play: ${files.map((f) => `${f.filename} (${f.mime}, ${formatBytes(f.bytes)})`).join(', ')}.`
      : '';

  const system = `You are Convertara, a file-processing assistant. You convert, resize, compress, crop, rotate, merge, split and archive images, PDFs and zip files, and you can hit an exact output size such as "300 KB give or take 5%".

Answer the user's question directly and briefly - a couple of sentences unless they asked for detail. If they want work done on a file, say what to attach and what to ask for. Never claim to have processed a file in this reply; work happens only when they give an instruction with a file attached.${inventory}`;

  const turns = history
    .filter((m) => m.text.trim() !== '')
    .slice(-8)
    .map((m) => ({ role: m.role, content: m.text }));

  let full = '';
  for await (const chunk of converse({ system, messages: turns }, settings)) {
    full += chunk;
    yield { type: 'delta', text: chunk };
  }

  const text = full.trim() === '' ? 'I did not get an answer back from the model. Try again?' : full.trim();
  yield { type: 'done', message: await save(repository(), conversation, text, [], null) };
}

async function resolveConversation(
  repo: ReturnType<typeof repository>,
  request: TurnRequest,
): Promise<ConversationRecord> {
  if (request.conversationId) {
    const existing = await repo.getConversation(request.conversationId);
    if (!existing || existing.ownerId !== request.ownerId) throw notFound('Conversation not found');
    return existing;
  }

  const now = new Date();
  return repo.createConversation({
    id: newId(),
    ownerId: request.ownerId,
    title: titleFrom(request.text),
    createdAt: now,
    updatedAt: now,
  });
}

function titleFrom(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return 'New chat';
  return trimmed.length > 48 ? `${trimmed.slice(0, 45)}...` : trimmed;
}

/** The most recent files in the thread: the last outputs, else the last upload. */
async function inheritFiles(
  repo: ReturnType<typeof repository>,
  history: MessageRecord[],
  ownerId: string,
): Promise<FileRecord[]> {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (!message || message.attachmentIds.length === 0) continue;
    const files = await loadFiles(message.attachmentIds, ownerId);
    if (files.length > 0) return files;
  }
  return [];
}

async function loadFiles(ids: string[], ownerId: string): Promise<FileRecord[]> {
  const repo = repository();
  const found = await Promise.all(ids.map((id) => repo.getFile(id)));
  return found.filter((f): f is FileRecord => f !== null && f.ownerId === ownerId);
}

async function save(
  repo: ReturnType<typeof repository>,
  conversation: ConversationRecord,
  text: string,
  attachments: FileRecord[],
  jobId: string | null,
): Promise<SerialisedMessage> {
  const message = await repo.addMessage({
    id: newId(),
    conversationId: conversation.id,
    role: 'assistant',
    text,
    attachmentIds: attachments.map((f) => f.id),
    jobId,
    createdAt: new Date(),
  });
  await repo.touchConversation(conversation.id);
  return serialise(message, attachments);
}

export function serialise(message: MessageRecord, files: FileRecord[]): SerialisedMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt.toISOString(),
    jobId: message.jobId,
    attachments: files.map((f) => ({
      id: f.id,
      filename: f.filename,
      mime: f.mime,
      bytes: f.bytes,
      meta: f.meta,
      downloadUrl: `/v1/files/${f.id}/content`,
    })),
  };
}

const toReplyFile = (f: FileRecord) => ({
  filename: f.filename,
  bytes: f.bytes,
  mime: f.mime,
  meta: f.meta,
});
