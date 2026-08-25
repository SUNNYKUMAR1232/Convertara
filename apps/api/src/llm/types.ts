import type { LlmProvider } from '../db/types.js';

export interface LlmSettings {
  provider: LlmProvider;
  model: string;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  temperature: number;
  timeoutMs: number;
  fallbackModel?: string | undefined;
}

export interface StructuredRequest {
  system: string;
  user: string;
  /** Name the provider attaches to the schema; some require it. */
  schemaName: string;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
}

export interface StructuredResponse {
  json: unknown;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  latencyMs: number;
}

/**
 * Every provider hides behind this. The agent calls `generate` and never learns
 * which vendor answered, which is what makes provider choice a config value
 * instead of a code change.
 */
export interface LlmAdapter {
  readonly provider: LlmProvider;
  /** Default endpoint when the user does not supply one. */
  defaultBaseUrl: string;
  /** Whether this provider needs an API key at all (Ollama does not). */
  requiresApiKey: boolean;
  generate(request: StructuredRequest, settings: LlmSettings): Promise<StructuredResponse>;
  listModels?(settings: LlmSettings): Promise<string[]>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Shared fetch wrapper: timeout, JSON parsing, and useful error text. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
  provider: string,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new LlmError(`${provider} returned ${response.status}: ${text.slice(0, 300)}`, provider, response.status, retryable);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new LlmError(`${provider} returned a non-JSON body: ${text.slice(0, 200)}`, provider);
    }
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new LlmError(`${provider} timed out after ${timeoutMs}ms`, provider, undefined, true);
    }
    throw new LlmError(`${provider} request failed: ${(error as Error).message}`, provider, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Models sometimes wrap JSON in prose or a code fence. Dig it out. */
export function parseJsonLoose(raw: string, provider: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new LlmError(`${provider} did not return usable JSON`, provider);
  }
}
