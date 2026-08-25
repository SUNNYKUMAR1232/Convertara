import { LlmError, parseJsonLoose, postJson } from '../types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from '../types.js';

/**
 * How the endpoint is asked for JSON.
 *
 * `json_schema` hands the schema over and lets the server enforce it.
 * `json_object` only asks for valid JSON, so the schema has to travel in the
 * prompt instead - see `structuredMode` on the Groq adapter below for why that
 * is sometimes the only thing that works.
 */
type StructuredMode = 'json_schema' | 'json_object';

/**
 * OpenAI Chat Completions. Also serves every "OpenAI-compatible" endpoint -
 * vLLM, LM Studio, OpenRouter, Together, Groq, a self-hosted gateway - by
 * pointing `baseUrl` somewhere else, which is why `custom` and `groq` reuse it.
 */
function build(
  provider: 'openai' | 'custom' | 'groq',
  defaultBaseUrl: string,
  requiresApiKey: boolean,
  structuredMode: StructuredMode = 'json_schema',
): LlmAdapter {
  return {
    provider,
    defaultBaseUrl,
    requiresApiKey,

    async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
      const base = (settings.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
      const started = Date.now();

      // In json_object mode the server never sees the schema, so state it in
      // the system message or the model has nothing to aim at.
      const system =
        structuredMode === 'json_object'
          ? `${request.system}\n\nReply with JSON only - no prose, no code fence - matching this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
          : request.system;

      const body = {
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: request.maxOutputTokens ?? 1500,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: request.user },
        ],
        response_format:
          structuredMode === 'json_object'
            ? { type: 'json_object' }
            : {
                type: 'json_schema',
                json_schema: { name: request.schemaName, strict: false, schema: request.jsonSchema },
              },
      };

      const headers: Record<string, string> = {};
      if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

      const data = await postJson(`${base}/chat/completions`, body, headers, settings.timeoutMs, provider);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new LlmError('No content in the response', provider);

      return {
        json: parseJsonLoose(content, provider),
        model: data.model ?? settings.model,
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
        },
        latencyMs: Date.now() - started,
      };
    },

    async listModels(settings: LlmSettings): Promise<string[]> {
      const base = (settings.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
      const headers: Record<string, string> = settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {};
      const response = await fetch(`${base}/models`, { headers });
      if (!response.ok) throw new LlmError(`Could not list models (${response.status})`, provider, response.status);
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string');
    },
  };
}

export const openaiAdapter = build('openai', 'https://api.openai.com/v1', true);

/** Same wire format, user-supplied endpoint. */
export const customAdapter = build('custom', 'http://localhost:8000/v1', false);

/**
 * Groq speaks the same wire format but enforces `response_format: json_schema`
 * against the generation and returns 400 "Failed to validate JSON" when it does
 * not conform - where OpenAI with `strict: false` simply hands back the text
 * and lets the caller judge. Our plan schema is a poor fit for that check: it
 * carries a free-form `params` object and minItems/maxItems bounds, so the
 * enforcement rejects plans that are perfectly good.
 *
 * Ask for plain JSON instead and put the schema in the prompt. The planner
 * already validates every response with zod and retries once with the specific
 * failures, so nothing depends on the server having enforced anything.
 */
export const groqAdapter = build('groq', 'https://api.groq.com/openai/v1', true, 'json_object');
