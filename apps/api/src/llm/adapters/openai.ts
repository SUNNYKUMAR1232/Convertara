import { LlmError, parseJsonLoose, postJson } from '../types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from '../types.js';

/**
 * OpenAI Chat Completions. Also serves every "OpenAI-compatible" endpoint -
 * vLLM, LM Studio, OpenRouter, Together, a self-hosted gateway - by pointing
 * `baseUrl` somewhere else, which is why the `custom` provider reuses it.
 */
function build(provider: 'openai' | 'custom', defaultBaseUrl: string, requiresApiKey: boolean): LlmAdapter {
  return {
    provider,
    defaultBaseUrl,
    requiresApiKey,

    async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
      const base = (settings.baseUrl ?? defaultBaseUrl).replace(/\/+$/, '');
      const started = Date.now();

      const body = {
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: request.maxOutputTokens ?? 1500,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        response_format: {
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
