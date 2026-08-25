import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from './types.js';
import type { LlmSettings } from './types.js';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ConverseRequest {
  system: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
}

/**
 * Free-text answers, as opposed to the structured planning path.
 *
 * These stream. A planning call is a single structured object where streaming
 * buys nothing, but an answer to "what's the difference between WebP and AVIF"
 * reads as broken if it arrives all at once after four seconds. Providers
 * without a streaming implementation here yield their answer as one chunk, so
 * callers never need to care which they got.
 */
export async function* converse(
  request: ConverseRequest,
  settings: LlmSettings,
): AsyncGenerator<string, void, undefined> {
  switch (settings.provider) {
    case 'anthropic':
      yield* anthropicStream(request, settings);
      return;
    case 'ollama':
      yield* ollamaStream(request, settings);
      return;
    case 'openai':
    case 'custom':
      yield* openaiStream(request, settings);
      return;
    default:
      yield await geminiOnce(request, settings);
  }
}

async function* anthropicStream(request: ConverseRequest, settings: LlmSettings): AsyncGenerator<string> {
  if (!settings.apiKey) throw new LlmError('Anthropic needs an API key', 'anthropic', 401);

  const client = new Anthropic({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl ?? 'https://api.anthropic.com',
    maxRetries: 1,
  });

  // No temperature: sampling parameters are rejected on the current models.
  const stream = client.messages.stream(
    {
      model: settings.model,
      max_tokens: request.maxOutputTokens ?? 800,
      system: request.system,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
    },
    { timeout: settings.timeoutMs },
  );

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
}

async function* openaiStream(request: ConverseRequest, settings: LlmSettings): AsyncGenerator<string> {
  const base = (settings.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      max_tokens: request.maxOutputTokens ?? 800,
      stream: true,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
    }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok || !response.body) {
    throw new LlmError(`${settings.provider} returned ${response.status}`, settings.provider, response.status);
  }

  for await (const line of sseLines(response.body)) {
    if (line === '[DONE]') return;
    try {
      const delta = JSON.parse(line)?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta !== '') yield delta;
    } catch {
      // a partial frame; the reader will deliver the rest
    }
  }
}

async function* ollamaStream(request: ConverseRequest, settings: LlmSettings): AsyncGenerator<string> {
  const base = (settings.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');

  const response = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      stream: true,
      options: { temperature: settings.temperature },
      messages: [{ role: 'system', content: request.system }, ...request.messages],
    }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok || !response.body) {
    throw new LlmError(`ollama returned ${response.status}`, 'ollama', response.status);
  }

  // Ollama streams newline-delimited JSON rather than SSE.
  for await (const line of textLines(response.body)) {
    try {
      const parsed = JSON.parse(line);
      const chunk = parsed?.message?.content;
      if (typeof chunk === 'string' && chunk !== '') yield chunk;
      if (parsed?.done) return;
    } catch {
      // ignore a partial line
    }
  }
}

/** Gemini has no streaming path here yet, so it arrives in one piece. */
async function geminiOnce(request: ConverseRequest, settings: LlmSettings): Promise<string> {
  if (!settings.apiKey) throw new LlmError('Gemini needs an API key', 'gemini', 401);
  const base = (settings.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');

  const response = await fetch(`${base}/models/${encodeURIComponent(settings.model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': settings.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: request.system }] },
      contents: request.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature: settings.temperature, maxOutputTokens: request.maxOutputTokens ?? 800 },
    }),
    signal: AbortSignal.timeout(settings.timeoutMs),
  });

  if (!response.ok) throw new LlmError(`gemini returned ${response.status}`, 'gemini', response.status);
  const data = (await response.json()) as any;
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

async function* textLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') yield line;
      index = buffer.indexOf('\n');
    }
  }
  if (buffer.trim() !== '') yield buffer.trim();
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of textLines(body)) {
    if (line.startsWith('data:')) yield line.slice(5).trim();
  }
}
