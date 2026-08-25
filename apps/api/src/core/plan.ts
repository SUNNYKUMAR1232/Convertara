import { z } from 'zod';
import { BYTE_UNITS, toBytes } from './units.js';

/**
 * The structured plan is the single contract between the "AI brain" and the
 * deterministic system. Both the rule-based fast path and the LLM planner emit
 * exactly this shape; nothing downstream can tell which produced it.
 */

export const operationSchema = z.object({
  /** Capability name, e.g. `image.resize`. Resolved by the capability router. */
  op: z.string().min(3).max(64).regex(/^[a-z0-9]+\.[a-z0-9-]+$/, 'op must look like `domain.capability`'),
  params: z.record(z.unknown()).default({}),
});
export type Operation = z.infer<typeof operationSchema>;

export const sizeConstraintSchema = z.object({
  /** Numeric target expressed in `unit`. */
  target: z.number().positive(),
  unit: z.enum(BYTE_UNITS).default('KB'),
  /** Fractional tolerance around the target, e.g. 0.05 for ±5%. */
  tolerance: z.number().min(0).max(0.9).default(0.05),
  /**
   * `target` — land inside [target*(1-tol), target*(1+tol)].
   * `max`    — never exceed target; smaller is fine.
   */
  mode: z.enum(['target', 'max']).default('target'),
});
export type SizeConstraint = z.infer<typeof sizeConstraintSchema>;

export const dimensionConstraintSchema = z
  .object({
    width: z.number().int().positive().max(60_000).optional(),
    height: z.number().int().positive().max(60_000).optional(),
    maxWidth: z.number().int().positive().max(60_000).optional(),
    maxHeight: z.number().int().positive().max(60_000).optional(),
    /** Never scale below this fraction of the source when hunting for a size target. */
    minScale: z.number().min(0.05).max(1).default(0.35),
  })
  .default({ minScale: 0.35 });
export type DimensionConstraint = z.infer<typeof dimensionConstraintSchema>;

export const constraintsSchema = z
  .object({
    size: sizeConstraintSchema.optional(),
    dimensions: dimensionConstraintSchema.optional(),
    /** Lowest acceptable encoder quality (1-100) when chasing a size target. */
    minQuality: z.number().int().min(1).max(100).default(30),
    /** Preferred output container/format, e.g. `webp`. */
    format: z.string().max(16).optional(),
    /** Drop EXIF/XMP and other metadata. */
    stripMetadata: z.boolean().default(false),
  })
  .default({ minQuality: 30, stripMetadata: false });
export type Constraints = z.infer<typeof constraintsSchema>;

export const planSchema = z.object({
  version: z.literal(1).default(1),
  /** Short machine-readable summary of what the user asked for. */
  intent: z.string().min(1).max(200).default('process'),
  operations: z.array(operationSchema).min(1).max(12),
  constraints: constraintsSchema,
  output: z
    .object({
      filename: z.string().max(200).optional(),
      /** Produce a single file, or a zip when the pipeline fans out. */
      bundle: z.enum(['auto', 'single', 'zip']).default('auto'),
    })
    .default({ bundle: 'auto' }),
  /** Set by the planner, never by the model. */
  source: z.enum(['fast-path', 'llm', 'explicit']).default('llm'),
  notes: z.string().max(1000).optional(),
});
export type Plan = z.infer<typeof planSchema>;

/** Schema handed to the LLM: no server-controlled fields, no defaults it could fight. */
export const llmPlanSchema = planSchema.omit({ source: true, version: true });
export type LlmPlan = z.infer<typeof llmPlanSchema>;

export function sizeTargetBytes(size: SizeConstraint): number {
  return toBytes(size.target, size.unit);
}
