import { LlmError, parseJsonLoose, postJson } from '../types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from '../types.js';

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Google Gemini. Structured output comes from `responseMimeType` plus
 * `responseSchema`, which is JSON Schema minus a few keywords - hence the
 * pruning pass below.
 */
export const geminiAdapter: LlmAdapter = {
  provider: 'gemini',
  defaultBaseUrl: DEFAULT_BASE_URL,
  requiresApiKey: true,

  async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
    if (!settings.apiKey) throw new LlmError('Gemini needs an API key', 'gemini', 401);

    const base = (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(settings.model)}:generateContent`;
    const started = Date.now();

    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: [{ role: 'user', parts: [{ text: request.user }] }],
      generationConfig: {
        temperature: settings.temperature,
        maxOutputTokens: request.maxOutputTokens ?? 1500,
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(request.jsonSchema),
      },
    };

    const data = await postJson(url, body, { 'x-goog-api-key': settings.apiKey }, settings.timeoutMs, 'gemini');
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new LlmError('No content in the response', 'gemini');

    return {
      json: parseJsonLoose(text, 'gemini'),
      model: settings.model,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount,
        outputTokens: data.usageMetadata?.candidatesTokenCount,
      },
      latencyMs: Date.now() - started,
    };
  },

  async listModels(settings: LlmSettings): Promise<string[]> {
    if (!settings.apiKey) throw new LlmError('Gemini needs an API key', 'gemini', 401);
    const base = (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const response = await fetch(`${base}/models`, { headers: { 'x-goog-api-key': settings.apiKey } });
    if (!response.ok) throw new LlmError(`Could not list models (${response.status})`, 'gemini', response.status);
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? [])
      .map((m) => m.name?.replace(/^models\//, ''))
      .filter((id): id is string => typeof id === 'string');
  },
};

/** Gemini rejects `additionalProperties`, `$schema`, `oneOf` and friends. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const dropped = new Set(['additionalProperties', '$schema', 'default', 'examples', 'const', 'oneOf', 'anyOf']);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (dropped.has(key)) continue;
    out[key] = toGeminiSchema(value);
  }
  return out;
}
