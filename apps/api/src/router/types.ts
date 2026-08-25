import type { z } from 'zod';
import type { ResolvedConstraints } from '../constraints/engine.js';
import type { Logger } from '../core/logger.js';

/** A file in flight. Everything downstream of upload works on these. */
export interface WorkFile {
  name: string;
  data: Buffer;
  mime: string;
  /** Engine-supplied facts (width/height/pages/...). Never trusted from clients. */
  meta: Record<string, unknown>;
}

export interface EngineContext {
  logger: Logger;
  signal: AbortSignal;
  /** 0..1 progress within the current operation. */
  progress: (fraction: number, message?: string) => void;
  constraints: ResolvedConstraints;
}

export interface OpInput<P = Record<string, unknown>> {
  files: WorkFile[];
  params: P;
  ctx: EngineContext;
}

export interface Capability<P = any> {
  /** `domain.capability`, e.g. `image.resize`. */
  name: string;
  domain: string;
  title: string;
  description: string;
  /** MIME patterns this capability consumes, e.g. `image/*`. */
  accepts: string[];
  /** MIME produced, or `same` when the capability preserves the input type. */
  produces: string;
  paramsSchema: z.ZodType<P>;
  /** Relative CPU weight per MB, used by the sync/async cost estimator. */
  cost: number;
  /** True when the capability can run right now (e.g. optional binary present). */
  available: () => boolean | Promise<boolean>;
  run: (input: OpInput<P>) => Promise<WorkFile[]>;
}

/**
 * Deterministic size search hook. A domain that can re-encode at a given
 * quality/scale gets automatic size-target support; one that cannot simply
 * does not register an optimizer.
 */
export interface OptimizerKnobs {
  quality: { min: number; max: number };
  scale: { min: number; max: number };
}

export interface SizeOptimizer {
  domain: string;
  supports: (file: WorkFile) => boolean;
  knobs: (file: WorkFile, rc: ResolvedConstraints) => OptimizerKnobs;
  render: (file: WorkFile, knobs: { quality: number; scale: number }, ctx: EngineContext) => Promise<WorkFile>;
}

export interface EnginePlugin {
  domain: string;
  title: string;
  capabilities: Capability[];
  optimizer?: SizeOptimizer;
  /** Probe for external binaries etc. Runs once at boot. */
  init?: () => Promise<void>;
}
