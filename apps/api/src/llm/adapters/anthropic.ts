import Anthropic from '@anthropic-ai/sdk';
import { LlmError } from '../types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/**
 * Anthropic Messages API through the official SDK.
 *
 * Two things differ from the OpenAI-shaped adapters and both matter:
 *
 * 1. Structured output comes from a forced tool call. `tool_choice` pins the
 *    single tool, so `input` arrives already shaped like our plan schema and
 *    there is no prose to strip.
 * 2. `temperature` is NOT sent. Sampling parameters were removed on the current
 *    Claude models (Opus 5, Sonnet 5, Opus 4.7/4.8, Fable 5) and sending one
 *    returns a 400. Planning is pinned by the schema anyway.
 */
export const anthropicAdapter: LlmAdapter = {
  provider: 'anthropic',
  defaultBaseUrl: DEFAULT_BASE_URL,
  requiresApiKey: true,

  async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
    if (!settings.apiKey) throw new LlmError('Anthropic needs an API key', 'anthropic', 401);

    const client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl ?? DEFAULT_BASE_URL,
      maxRetries: 1,
    });

    const started = Date.now();
    try {
      const response = await client.messages.create(
        {
          model: settings.model,
          max_tokens: request.maxOutputTokens ?? 2000,
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          tools: [
            {
              name: request.schemaName,
              description: 'Return the processing plan. Call this exactly once.',
              input_schema: request.jsonSchema as Anthropic.Tool['input_schema'],
            },
          ],
          tool_choice: { type: 'tool', name: request.schemaName },
        },
        { timeout: settings.timeoutMs },
      );

      if (response.stop_reason === 'refusal') {
        throw new LlmError('Anthropic declined the request', 'anthropic');
      }

      const toolUse = response.content.find((block) => block.type === 'tool_use');
      if (!toolUse || toolUse.type !== 'tool_use') {
        throw new LlmError('Anthropic returned no plan', 'anthropic');
      }

      return {
        json: toolUse.input,
        model: response.model,
        usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof LlmError) throw error;
      if (error instanceof Anthropic.APIError) {
        throw new LlmError(
          `Anthropic returned ${error.status}: ${error.message}`,
          'anthropic',
          error.status,
          error.status === 429 || (error.status ?? 0) >= 500,
        );
      }
      throw new LlmError(`Anthropic request failed: ${(error as Error).message}`, 'anthropic', undefined, true);
    }
  },

  async listModels(settings: LlmSettings): Promise<string[]> {
    if (!settings.apiKey) throw new LlmError('Anthropic needs an API key', 'anthropic', 401);
    const client = new Anthropic({ apiKey: settings.apiKey, baseURL: settings.baseUrl ?? DEFAULT_BASE_URL });
    const models: string[] = [];
    for await (const model of client.models.list()) models.push(model.id);
    return models;
  },
};
