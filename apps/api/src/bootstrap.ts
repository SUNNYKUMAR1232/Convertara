import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { repository } from './db/index.js';
import { archiveEngine } from './engines/archive/index.js';
import { imageEngine } from './engines/image/index.js';
import { configureSharp } from './engines/image/sharp-util.js';
import { pdfEngine } from './engines/pdf/index.js';
import { pdfEngineReport } from './engines/pdf/report.js';
import { bus } from './events/bus.js';
import { registry } from './router/registry.js';
import { objectStore } from './storage/index.js';

let ready: Promise<void> | undefined;

/**
 * Boot order matters: engines register before anything can plan against them,
 * and capability probes (Ghostscript and friends) run once here rather than on
 * every request.
 */
export function bootstrap(): Promise<void> {
  ready ??= (async () => {
    const cfg = config();
    assertDurableState(cfg);
    configureSharp(cfg.WORKER_CONCURRENCY);

    await registry.register(imageEngine);
    await registry.register(pdfEngine);
    await registry.register(archiveEngine);

    await repository().init();
    await objectStore().ping();
    await bus.connect();

    const report = await pdfEngineReport();
    if (!report.ghostscript) {
      logger.warn('Ghostscript not found: pdf.compress is disabled. Install it to enable PDF size targets.');
    }

    logger.info(
      { capabilities: registry.list().length, domains: registry.domains().map((d) => d.domain) },
      'engines registered',
    );
  })();

  return ready;
}

/**
 * The in-memory store and inline queue are selected by the *absence* of a URL,
 * which makes a typo'd environment variable indistinguishable from a laptop.
 * Three replicas would each get their own isolated store and jobs would vanish
 * between requests, with readiness reporting green throughout. So in production
 * it is a boot failure, not a fallback.
 */
function assertDurableState(cfg: ReturnType<typeof config>): void {
  if (cfg.NODE_ENV !== 'production' || cfg.ALLOW_EPHEMERAL_STATE) return;

  const missing = [
    cfg.DATABASE_URL ? null : 'DATABASE_URL (metadata would be in-memory and lost on restart)',
    cfg.REDIS_URL ? null : 'REDIS_URL (jobs would run in-process with no cross-replica queue)',
  ].filter((m): m is string => m !== null);

  if (missing.length > 0) {
    throw new Error(
      [
        'Refusing to start in production without durable state:',
        ...missing.map((m) => `  - ${m}`),
        'Set them, or set ALLOW_EPHEMERAL_STATE=true if a single ephemeral container is genuinely what you want.',
      ].join('\n'),
    );
  }
}
