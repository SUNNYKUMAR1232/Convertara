import type { LlmProvider } from '../db/types.js';

export interface ProviderInfo {
  provider: LlmProvider;
  label: string;
  requiresApiKey: boolean;
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  /** Shown in the settings UI. The list is a convenience, not a restriction. */
  suggestedModels: string[];
  help: string;
}

/**
 * Catalogue for the settings screen. Any model string is accepted - these are
 * only the ones we offer as a starting point, so a model released next week
 * needs no code change.
 */
export const PROVIDERS: ProviderInfo[] = [
  {
    provider: 'anthropic',
    label: 'Anthropic',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    baseUrlEditable: true,
    suggestedModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
    help: 'Keys start with sk-ant-. Planning uses a forced tool call, so output is always schema-shaped.',
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    baseUrlEditable: true,
    suggestedModels: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini'],
    help: 'Keys start with sk-. Uses JSON-schema response format.',
  },
  {
    provider: 'gemini',
    label: 'Google Gemini',
    requiresApiKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    baseUrlEditable: true,
    suggestedModels: ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    help: 'Uses responseSchema for structured output.',
  },
  {
    provider: 'groq',
    label: 'Groq',
    requiresApiKey: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    baseUrlEditable: true,
    suggestedModels: ['llama-3.3-70b-versatile', 'moonshotai/kimi-k2-instruct-0905', 'llama-3.1-8b-instant'],
    help: 'Keys start with gsk_. Very fast. Asks for plain JSON rather than a server-enforced schema, so any chat model works.',
  },
  {
    provider: 'ollama',
    label: 'Ollama (local)',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:11434',
    baseUrlEditable: true,
    suggestedModels: ['llama3.1', 'qwen2.5', 'mistral-nemo'],
    help: 'Runs on your own machine. Nothing leaves the host.',
  },
  {
    provider: 'custom',
    label: 'Custom (OpenAI-compatible)',
    requiresApiKey: false,
    defaultBaseUrl: 'http://localhost:8000/v1',
    baseUrlEditable: true,
    suggestedModels: [],
    help: 'Point this at vLLM, LM Studio, OpenRouter, or an internal gateway.',
  },
];

export const providerInfo = (provider: LlmProvider): ProviderInfo | undefined =>
  PROVIDERS.find((p) => p.provider === provider);
