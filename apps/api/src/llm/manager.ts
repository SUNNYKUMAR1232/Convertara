import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { repository } from '../db/index.js';
import type { LlmConfigRecord, LlmProvider } from '../db/types.js';
import { anthropicAdapter } from './adapters/anthropic.js';
import { geminiAdapter } from './adapters/gemini.js';
import { ollamaAdapter } from './adapters/ollama.js';
import { customAdapter, groqAdapter, openaiAdapter } from './adapters/openai.js';
import { assertSafeEndpoint } from '../security/endpoint-guard.js';
import { decryptSecret } from './crypto.js';
import { LlmError } from './types.js';
import type { LlmAdapter, LlmSettings, StructuredRequest, StructuredResponse } from './types.js';

const ADAPTERS: Record<LlmProvider, LlmAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  groq: groqAdapter,
  ollama: ollamaAdapter,
  custom: customAdapter,
};

export interface TestResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  error?: string;
}

/**
 * The only thing in the codebase that knows a provider exists.
 *
 * Everything above it - the planner, the routes, the engines - calls
 * `generate()` and gets structured JSON back. That is what makes the model a
 * deployment setting rather than an architectural commitment: a user pastes an
 * API key, picks a model, and nothing else in the system changes.
 */
class LlmManager {
  /**
   * Every outbound call funnels through here, including ones using a base URL
   * that was stored before the policy tightened. Checking at the call site
   * rather than at save time is what makes that true.
   */
  private async guard(settings: LlmSettings): Promise<void> {
    if (settings.baseUrl) await assertSafeEndpoint(settings.baseUrl);
  }

  adapterFor(provider: LlmProvider): LlmAdapter {
    const adapter = ADAPTERS[provider];
    if (!adapter) throw new AppError('BAD_REQUEST', `Unknown provider: ${provider}`);
    return adapter;
  }

  /** A stored config wins; otherwise fall back to server-wide env defaults. */
  async settingsFor(ownerId: string): Promise<LlmSettings | undefined> {
    const cfg = config();
    const stored = await repository().getDefaultLlmConfig(ownerId);
    if (stored) return this.toSettings(stored);

    if (!cfg.LLM_PROVIDER || !cfg.LLM_MODEL) return undefined;
    return {
      provider: cfg.LLM_PROVIDER,
      model: cfg.LLM_MODEL,
      apiKey: cfg.LLM_API_KEY,
      baseUrl: cfg.LLM_BASE_URL,
      temperature: 0.1,
      timeoutMs: cfg.LLM_TIMEOUT_MS,
    };
  }

  toSettings(record: LlmConfigRecord): LlmSettings {
    return {
      provider: record.provider,
      model: record.model,
      apiKey: record.apiKeyCiphertext ? decryptSecret(record.apiKeyCiphertext) : undefined,
      baseUrl: record.baseUrl ?? undefined,
      temperature: record.temperature,
      timeoutMs: config().LLM_TIMEOUT_MS,
      fallbackModel: record.fallbackModel ?? undefined,
    };
  }

  /**
   * One structured call, with a single retry. A transient failure retries the
   * same model; anything else falls straight to the configured fallback model
   * so a rate-limited primary does not take the feature down.
   */
  async generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse> {
    const adapter = this.adapterFor(settings.provider);
    if (adapter.requiresApiKey && !settings.apiKey) {
      throw new AppError('LLM_UNAVAILABLE', `${settings.provider} needs an API key before it can be used`);
    }

    await this.guard(settings);

    try {
      return await adapter.generate(request, settings);
    } catch (error) {
      const retryable = error instanceof LlmError && error.retryable;
      logger.warn(
        { provider: settings.provider, model: settings.model, retryable, err: (error as Error).message },
        'llm call failed',
      );

      if (retryable) {
        try {
          return await adapter.generate(request, settings);
        } catch {
          // fall through to the fallback model
        }
      }

      if (settings.fallbackModel && settings.fallbackModel !== settings.model) {
        logger.info({ model: settings.fallbackModel }, 'falling back to secondary model');
        return adapter.generate(request, { ...settings, model: settings.fallbackModel });
      }

      throw new AppError('LLM_FAILED', (error as Error).message, { provider: settings.provider });
    }
  }

  /** Cheap round trip used by the "Test connection" button. */
  async test(settings: LlmSettings): Promise<TestResult> {
    const started = Date.now();
    try {
      await this.guard(settings);
      const response = await this.adapterFor(settings.provider).generate(
        {
          system: 'You verify connectivity. Reply with the exact JSON requested.',
          user: 'Return {"ok": true}.',
          schemaName: 'connectivity_check',
          jsonSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
          maxOutputTokens: 64,
        },
        { ...settings, timeoutMs: Math.min(settings.timeoutMs, 20_000) },
      );
      return { ok: true, model: response.model, latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, error: (error as Error).message, latencyMs: Date.now() - started };
    }
  }

  async listModels(settings: LlmSettings): Promise<string[]> {
    const adapter = this.adapterFor(settings.provider);
    if (!adapter.listModels) return [];
    await this.guard(settings);
    return adapter.listModels(settings);
  }
}

export const llm = new LlmManager();
