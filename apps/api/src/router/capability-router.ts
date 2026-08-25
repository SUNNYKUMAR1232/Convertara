import { AppError } from '../core/errors.js';
import type { Plan } from '../core/plan.js';
import { registry } from './registry.js';
import type { Capability, WorkFile } from './types.js';

export interface ResolvedOperation {
  capability: Capability;
  params: unknown;
}

export function mimeMatches(patterns: string[], mime: string): boolean {
  return patterns.some((p) => {
    if (p === '*/*' || p === '*') return true;
    if (p.endsWith('/*')) return mime.startsWith(`${p.slice(0, -1)}`);
    return p === mime;
  });
}

/**
 * Resolves a plan's capability names to concrete engine handlers, validating
 * parameters and input types before a single byte is processed. A plan that
 * survives this function is executable.
 */
export async function resolvePlan(plan: Plan, files: WorkFile[]): Promise<ResolvedOperation[]> {
  const resolved: ResolvedOperation[] = [];
  let currentMimes: Array<string | undefined> = files.map((f) => f.mime);

  for (const [index, operation] of plan.operations.entries()) {
    const capability = registry.get(operation.op);
    if (!capability) {
      throw new AppError('PLAN_INVALID', `Unknown operation "${operation.op}"`, {
        index,
        known: registry.list().map((c) => c.name),
      });
    }
    if (!(await capability.available())) {
      throw new AppError('CAPABILITY_UNAVAILABLE', `"${operation.op}" is not available on this deployment`, {
        operation: operation.op,
      });
    }

    const parsed = capability.paramsSchema.safeParse(operation.params ?? {});
    if (!parsed.success) {
      throw new AppError('PLAN_INVALID', `Invalid parameters for "${operation.op}"`, {
        index,
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }

    // `undefined` means an earlier step produced something unpredictable, so
    // there is nothing to check statically. The executor checks it for real.
    const mismatched = currentMimes.filter(
      (m): m is string => m !== undefined && !mimeMatches(capability.accepts, m),
    );
    if (mismatched.length > 0) {
      throw new AppError('PLAN_INVALID', `"${operation.op}" cannot accept ${[...new Set(mismatched)].join(', ')}`, {
        index,
        accepts: capability.accepts,
      });
    }

    if (capability.produces === 'varies') currentMimes = currentMimes.map(() => undefined);
    else if (capability.produces !== 'same') currentMimes = currentMimes.map(() => capability.produces);
    resolved.push({ capability, params: parsed.data });
  }

  return resolved;
}

/** Rough CPU cost, used to decide sync vs async execution. */
export function estimateCost(ops: ResolvedOperation[], totalBytes: number): number {
  const megabytes = Math.max(0.1, totalBytes / (1024 * 1024));
  return Math.round(ops.reduce((sum, o) => sum + o.capability.cost * megabytes, 0));
}
