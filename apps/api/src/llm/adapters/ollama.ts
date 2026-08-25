import { LlmError, parseJsonLoose, postJson } from '../types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from '../types.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

/**
 * Local models via Ollama. `format` takes a JSON Schema directly, which is how
 * a 7B model is kept from inventing fields. No API key, which is the point -
 * this is the "no data leaves the box" option.
 */
export const ollamaAdapter: LlmAdapter = {
  provider: 'ollama',
  defaultBaseUrl: DEFAULT_BASE_URL,
  requiresApiKey: false,

  async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
    const base = (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const started = Date.now();

    const body = {
      model: settings.model,
      stream: false,
      format: request.jsonSchema,
      options: { temperature: settings.temperature, num_predict: request.maxOutputTokens ?? 1500 },
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user },
      ],
    };

    const data = await postJson(`${base}/api/chat`, body, {}, settings.timeoutMs, 'ollama');
    const content = data?.message?.content;
    if (typeof content !== 'string') throw new LlmError('No content in the response', 'ollama');

    return {
      json: parseJsonLoose(content, 'ollama'),
      model: data.model ?? settings.model,
      usage: { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count },
      latencyMs: Date.now() - started,
    };
  },

  async listModels(settings: LlmSettings): Promise<string[]> {
    const base = (settings.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const response = await fetch(`${base}/api/tags`);
    if (!response.ok) throw new LlmError(`Could not list models (${response.status})`, 'ollama', response.status);
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
  },
};
