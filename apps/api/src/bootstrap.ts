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
