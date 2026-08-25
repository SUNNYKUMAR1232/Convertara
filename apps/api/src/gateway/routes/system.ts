import type { FastifyInstance } from 'fastify';
import { config } from '../../core/config.js';
import { repository } from '../../db/index.js';
import { jobQueue } from '../../queue/index.js';
import { registry } from '../../router/registry.js';
import { allowedTypes } from '../../security/sniff.js';
import { objectStore } from '../../storage/index.js';

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: is the process up. Never touches a dependency. */
  app.get('/health', async () => ({ status: 'ok', uptime: Math.round(process.uptime()) }));

  /** Readiness: can this instance actually serve traffic right now. */
  app.get('/health/ready', async (_request, reply) => {
    const checks = await Promise.all([
      probe('database', () => repository().ping()),
      probe('storage', () => objectStore().ping()),
      probe('queue', () => jobQueue().ping()),
    ]);
    const ok = checks.every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks });
  });

  /**
   * What this deployment can do. The UI reads this instead of hard-coding a
   * feature list, so an engine added later shows up on its own.
   */
  app.get('/v1/capabilities', async () => {
    const cfg = config();
    return {
      ...(await registry.describe()),
      acceptedTypes: allowedTypes(),
      limits: {
        maxUploadBytes: cfg.MAX_UPLOAD_BYTES,
        maxFilesPerRequest: cfg.MAX_FILES_PER_REQUEST,
        syncMaxBytes: cfg.SYNC_MAX_BYTES,
        artifactTtlSeconds: cfg.ARTIFACT_TTL_SECONDS,
      },
      aiMode: cfg.AI_MODE,
    };
  });
}

async function probe(name: string, fn: () => Promise<boolean>) {
  try {
    return { name, ok: await fn() };
  } catch (error) {
    return { name, ok: false, error: (error as Error).message };
  }
}
