export interface CapabilityInfo {
  name: string;
  domain: string;
  title: string;
  description: string;
  accepts: string[];
  produces: string;
  available: boolean;
}

export interface Capabilities {
  domains: Array<{ domain: string; title: string }>;
  capabilities: CapabilityInfo[];
  acceptedTypes: string[];
  limits: {
    maxUploadBytes: number;
    maxFilesPerRequest: number;
    syncMaxBytes: number;
    artifactTtlSeconds: number;
  };
  aiMode: 'auto' | 'always' | 'never';
}

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface JobOutput {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  meta: Record<string, unknown>;
  downloadUrl: string;
}

export interface Job {
  id: string;
  /** `partial` = it ran and produced output that misses a constraint. */
  status: 'queued' | 'running' | 'succeeded' | 'partial' | 'failed';
  stage: string | null;
  progress: number;
  prompt: string | null;
  plan: {
    intent: string;
    operations: Array<{ op: string; params: Record<string, unknown> }>;
    constraints: Record<string, unknown>;
    notes?: string;
  } | null;
  planSource: 'fast-path' | 'llm' | 'explicit' | null;
  planReason?: string;
  lane?: 'sync' | 'async';
  evaluation: { pass: boolean; checks: Check[] } | null;
  error: { code: string; message: string } | null;
  timings: Record<string, number>;
  outputs: JobOutput[];
  createdAt: string;
}

export interface ProviderInfo {
  provider: string;
  label: string;
  requiresApiKey: boolean;
  defaultBaseUrl: string;
  baseUrlEditable: boolean;
  suggestedModels: string[];
  help: string;
}

export interface LlmConfig {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  temperature: number;
  fallbackModel: string | null;
  isDefault: boolean;
  apiKeyHint: string | null;
}

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there is one. Sending the header on a DELETE
  // makes Fastify reject the request with "Body cannot be empty when
  // content-type is set to application/json" - which is what stopped the
  // saved-configuration Delete button from doing anything.
  const sendsJson = init?.body !== undefined && !(init.body instanceof FormData);

  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(sendsJson ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message = data?.error?.message ?? `Request failed (${response.status})`;
    const details = data?.error?.details?.issues;
    throw new Error(Array.isArray(details) ? `${message}: ${details.join('; ')}` : message);
  }
  return data as T;
}

export const api = {
  capabilities: () => request<Capabilities>('/v1/capabilities'),

  processUpload: (files: File[], prompt: string) => {
    const form = new FormData();
    form.append('prompt', prompt);
    for (const file of files) form.append('files', file);
    return request<Job>('/v1/process/upload', { method: 'POST', body: form });
  },

  job: (id: string) => request<Job>(`/v1/jobs/${id}`),
  jobs: (limit = 10) => request<{ jobs: Job[] }>(`/v1/jobs?limit=${limit}`),

  providers: () =>
    request<{
      providers: ProviderInfo[];
      aiMode: string;
      secretsConfigured: boolean;
      serverDefault: { provider: string; model: string } | null;
    }>('/v1/llm/providers'),

  llmConfigs: () => request<{ configs: LlmConfig[] }>('/v1/llm/configs'),

  saveLlmConfig: (body: unknown) =>
    request<{ config: LlmConfig }>('/v1/llm/configs', { method: 'POST', body: JSON.stringify(body) }),

  deleteLlmConfig: (id: string) => request<void>(`/v1/llm/configs/${id}`, { method: 'DELETE' }),

  testLlm: (body: unknown) =>
    request<{ ok: boolean; model?: string; latencyMs?: number; error?: string }>('/v1/llm/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listModels: (body: unknown) =>
    request<{ models: string[]; error?: string }>('/v1/llm/models', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** Live progress for a queued job. Returns an unsubscribe function. */
  watch: (id: string, onEvent: (event: { type: string; progress?: number; stage?: string; message?: string }) => void) => {
    const source = new EventSource(`${BASE}/v1/jobs/${id}/events`);
    source.onmessage = (message) => {
      try {
        onEvent(JSON.parse(message.data));
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
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
