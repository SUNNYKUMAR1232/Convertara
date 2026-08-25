import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { AppError, notFound } from '../../core/errors.js';
import { newId } from '../../core/ids.js';
import { repository } from '../../db/index.js';
import type { LlmConfigRecord } from '../../db/types.js';
import { decryptSecret, encryptSecret, maskSecret, secretKeyConfigured } from '../../llm/crypto.js';
import { llm } from '../../llm/manager.js';
import { PROVIDERS, providerInfo } from '../../llm/providers.js';
import type { LlmSettings } from '../../llm/types.js';
import { ownerOf } from '../context.js';

const providerEnum = z.enum(['openai', 'anthropic', 'gemini', 'groq', 'ollama', 'custom']);

const upsertBody = z.object({
  id: z.string().uuid().optional(),
  label: z.string().min(1).max(80).default('Default'),
  provider: providerEnum,
  model: z.string().min(1).max(120),
  baseUrl: z.string().url().max(400).optional(),
  /** Omit on update to keep the stored key. Send "" to clear it. */
  apiKey: z.string().max(400).optional(),
  temperature: z.number().min(0).max(2).default(0.1),
  fallbackModel: z.string().max(120).optional(),
  isDefault: z.boolean().default(true),
});

/**
 * Test and list-models accept a saved configuration, a set of loose fields, or
 * both. Both is the case that matters: the settings screen never receives a
 * stored key back, so a test of a saved configuration has no key to send. With
 * `configId` alongside the edited fields, the stored key fills that gap while
 * the edits still take effect.
 */
const testBody = z
  .object({
    configId: z.string().uuid().optional(),
    provider: providerEnum.optional(),
    model: z.string().min(1).max(120).optional(),
    baseUrl: z.string().url().max(400).optional(),
    apiKey: z.string().max(400).optional(),
    temperature: z.number().min(0).max(2).optional(),
  })
  .refine((body) => body.configId !== undefined || (body.provider !== undefined && body.model !== undefined), {
    message: 'Provide configId, or both provider and model',
  });

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  /** Everything the settings screen needs to render itself. */
  app.get('/v1/llm/providers', async () => ({
    providers: PROVIDERS,
    aiMode: config().AI_MODE,
    secretsConfigured: secretKeyConfigured(),
    serverDefault: config().LLM_PROVIDER
      ? { provider: config().LLM_PROVIDER, model: config().LLM_MODEL }
      : null,
  }));

  app.get('/v1/llm/configs', async (request) => ({
    configs: (await repository().listLlmConfigs(ownerOf(request))).map(present),
  }));

  app.post('/v1/llm/configs', async (request, reply) => {
    const owner = ownerOf(request);
    const body = upsertBody.parse(request.body);
    const info = providerInfo(body.provider);

    if (body.apiKey && !secretKeyConfigured()) {
      throw new AppError(
        'INTERNAL',
        'SECRET_KEY is not set on the server, so API keys cannot be stored. Generate one with: openssl rand -hex 32',
      );
    }
    if (info?.requiresApiKey && !body.apiKey && !body.id) {
      throw new AppError('BAD_REQUEST', `${info.label} requires an API key`);
    }

    const existing = body.id ? await repository().getLlmConfig(body.id) : null;
    if (body.id && (!existing || existing.ownerId !== owner)) throw notFound('Configuration not found');

    // An omitted key means "leave it alone"; an empty string means "remove it".
    const ciphertext =
      body.apiKey === undefined
        ? (existing?.apiKeyCiphertext ?? null)
        : body.apiKey === ''
          ? null
          : encryptSecret(body.apiKey);

    const record: LlmConfigRecord = {
      id: body.id ?? newId(),
      ownerId: owner,
      label: body.label,
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      apiKeyCiphertext: ciphertext,
      temperature: body.temperature,
      fallbackModel: body.fallbackModel ?? null,
      isDefault: body.isDefault,
      createdAt: existing?.createdAt ?? new Date(),
      updatedAt: new Date(),
    };

    const saved = await repository().upsertLlmConfig(record);
    return reply.code(body.id ? 200 : 201).send({ config: present(saved) });
  });

  app.delete('/v1/llm/configs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const existing = await repository().getLlmConfig(id);
    if (!existing || existing.ownerId !== ownerOf(request)) throw notFound('Configuration not found');
    await repository().deleteLlmConfig(id);
    return reply.code(204).send();
  });

  /** Round-trips a tiny structured request so a bad key fails here, not mid-job. */
  app.post('/v1/llm/test', async (request) => {
    const settings = await resolveSettings(ownerOf(request), testBody.parse(request.body));
    return llm.test(settings);
  });

  app.post('/v1/llm/models', async (request) => {
    const settings = await resolveSettings(ownerOf(request), testBody.parse(request.body));
    try {
      return { models: await llm.listModels(settings) };
    } catch (error) {
      return { models: [], error: (error as Error).message };
    }
  });
}

async function resolveSettings(owner: string, body: z.infer<typeof testBody>): Promise<LlmSettings> {
  let stored: LlmSettings | undefined;
  if (body.configId !== undefined) {
    const record = await repository().getLlmConfig(body.configId);
    if (!record || record.ownerId !== owner) throw notFound('Configuration not found');
    stored = llm.toSettings(record);
  }

  // Anything the caller sent wins; the stored configuration fills the rest,
  // which is how an untouched key survives a test of edited settings.
  return {
    ...stored,
    provider: body.provider ?? stored?.provider ?? 'openai',
    model: body.model ?? stored?.model ?? '',
    apiKey: body.apiKey ?? stored?.apiKey,
    baseUrl: body.baseUrl ?? stored?.baseUrl,
    temperature: body.temperature ?? stored?.temperature ?? 0.1,
    timeoutMs: config().LLM_TIMEOUT_MS,
  };
}

/** Never returns the key itself - only enough to recognise which one is stored. */
function present(record: LlmConfigRecord) {
  return {
    id: record.id,
    label: record.label,
    provider: record.provider,
    model: record.model,
    baseUrl: record.baseUrl,
    temperature: record.temperature,
    fallbackModel: record.fallbackModel,
    isDefault: record.isDefault,
    apiKeyHint: record.apiKeyCiphertext ? maskSecret(safeDecrypt(record.apiKeyCiphertext)) : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function safeDecrypt(ciphertext: string): string {
  try {
    return decryptSecret(ciphertext);
  } catch {
    return '????????';
  }
}
