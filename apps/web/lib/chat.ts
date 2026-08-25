export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  meta: Record<string, unknown>;
  downloadUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  jobId: string | null;
  attachments: Attachment[];
  /** Client-side only, while the reply is still arriving. */
  streaming?: boolean;
  status?: string;
  progress?: number;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
}

export type TurnEvent =
  | { type: 'conversation'; id: string; title: string }
  | { type: 'message'; message: ChatMessage }
  | { type: 'status'; text: string }
  | { type: 'progress'; fraction: number; stage?: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; message: ChatMessage }
  | { type: 'error'; message: string };

const BASE = '/api';

export async function uploadFiles(files: File[]): Promise<Attachment[]> {
  const form = new FormData();
  for (const file of files) form.append('files', file);

  const response = await fetch(`${BASE}/v1/files`, { method: 'POST', body: form });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message ?? 'Upload failed');

  return (data.files as Attachment[]).map((f) => ({ ...f, downloadUrl: `/v1/files/${f.id}/content`, meta: {} }));
}

/**
 * Sends one turn and yields events as they arrive.
 *
 * A turn carries a body, so this is a POST - which rules out EventSource. The
 * response stream is read directly and parsed as SSE frames, which is the same
 * thing EventSource would do, minus the reconnect logic we do not want here.
 */
export async function* sendTurn(input: {
  conversationId?: string;
  text: string;
  fileIds: string[];
  signal?: AbortSignal;
}): AsyncGenerator<TurnEvent> {
  const response = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId: input.conversationId,
      text: input.text,
      fileIds: input.fileIds,
    }),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  yield* readEvents(response);
}

async function* readEvents(response: Response): AsyncGenerator<TurnEvent> {
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '');
    let message = `Request failed (${response.status})`;
    try {
      message = JSON.parse(text)?.error?.message ?? message;
    } catch {
      // keep the generic message
    }
    yield { type: 'error', message };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith('data:')) {
        try {
          yield JSON.parse(frame.slice(5).trim()) as TurnEvent;
        } catch {
          // ignore a malformed frame rather than killing the stream
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

/** Applies an exact crop/resize/rotate. Same event stream as a chat turn. */
export async function* sendAdjustment(input: {
  conversationId: string;
  fileId: string;
  adjustment: unknown;
}): AsyncGenerator<TurnEvent> {
  const response = await fetch(`${BASE}/v1/chat/adjust`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  yield* readEvents(response);
}

export const chatApi = {
  conversations: async (): Promise<Conversation[]> => {
    const response = await fetch(`${BASE}/v1/conversations`);
    if (!response.ok) return [];
    return (await response.json()).conversations ?? [];
  },

  conversation: async (id: string): Promise<{ title: string; messages: ChatMessage[] }> => {
    const response = await fetch(`${BASE}/v1/conversations/${id}`);
    if (!response.ok) throw new Error('Could not load that conversation');
    const data = await response.json();
    return { title: data.conversation.title, messages: data.messages };
  },

  remove: async (id: string): Promise<void> => {
    await fetch(`${BASE}/v1/conversations/${id}`, { method: 'DELETE' });
  },
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
