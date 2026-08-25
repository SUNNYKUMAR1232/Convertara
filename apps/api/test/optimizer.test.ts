import { describe, expect, it } from 'vitest';
import { resolveConstraints } from '../src/constraints/engine.js';
import { constraintsSchema } from '../src/core/plan.js';
import { logger } from '../src/core/logger.js';
import { solveSizeTarget } from '../src/execution/optimizer.js';
import type { EngineContext, SizeOptimizer, WorkFile } from '../src/router/types.js';

const file: WorkFile = { name: 'photo.jpg', data: Buffer.alloc(4_000_000), mime: 'image/jpeg', meta: {} };

const context = (rc: ReturnType<typeof resolveConstraints>): EngineContext => ({
  logger,
  signal: new AbortController().signal,
  constraints: rc,
  progress: () => undefined,
});

/**
 * Stands in for a real encoder with a monotonic size curve, so the search
 * strategy can be tested without spending a second per case on libvips.
 */
function fakeOptimizer(sizeFor: (quality: number, scale: number) => number): SizeOptimizer & { calls: number } {
  const optimizer = {
    domain: 'image',
    calls: 0,
    supports: () => true,
    knobs: () => ({ quality: { min: 30, max: 95 }, scale: { min: 0.35, max: 1 } }),
    render: async (input: WorkFile, knobs: { quality: number; scale: number }) => {
      optimizer.calls += 1;
      return { ...input, data: Buffer.alloc(Math.max(1, Math.round(sizeFor(knobs.quality, knobs.scale)))) };
    },
  };
  return optimizer;
}

const target = (kb: number, tolerance = 0.05, mode: 'target' | 'max' = 'target') =>
  resolveConstraints(constraintsSchema.parse({ size: { target: kb, unit: 'KB', tolerance, mode } }));

describe('deterministic size search', () => {
  it('lands inside a +/-5% window using quality alone', async () => {
    const rc = target(300);
    const optimizer = fakeOptimizer((quality) => quality * 6000);

    const solution = await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(solution.satisfied).toBe(true);
    expect(solution.file.data.length).toBeGreaterThanOrEqual(rc.size!.min);
    expect(solution.file.data.length).toBeLessThanOrEqual(rc.size!.max);
  });

  it('gets there in a handful of encodes, not dozens', async () => {
    const rc = target(300);
    const optimizer = fakeOptimizer((quality) => quality * 6000);

    await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(optimizer.calls).toBeLessThanOrEqual(7);
  });

  it('gives up pixels only when quality alone cannot reach the target', async () => {
    const rc = target(100);
    // Even at the lowest quality this encoder cannot get under 100KB at full size.
    const optimizer = fakeOptimizer((quality, scale) => quality * 20_000 * scale * scale);

    const solution = await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(solution.satisfied).toBe(true);
    const scaled = solution.attempts.filter((a) => a.scale < 1);
    expect(scaled.length).toBeGreaterThan(0);
  });

  it('picks the highest quality that fits under a hard ceiling', async () => {
    const rc = target(500, 0, 'max');
    const optimizer = fakeOptimizer((quality) => quality * 6000);

    const solution = await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(solution.satisfied).toBe(true);
    expect(solution.file.data.length).toBeLessThanOrEqual(rc.size!.max);
    // 85 * 6000 = 510000 would exceed the ceiling; 85 is the last that fits.
    expect(solution.file.data.length).toBeGreaterThan(rc.size!.max * 0.9);
  });

  it('returns the closest attempt rather than nothing when the target is impossible', async () => {
    const rc = target(10);
    const optimizer = fakeOptimizer(() => 5_000_000); // stubbornly huge at every setting

    const solution = await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(solution.satisfied).toBe(false);
    expect(solution.file.data.length).toBe(5_000_000);
    expect(solution.attempts.length).toBeGreaterThan(0);
  });

  it('does nothing at all when there is no size constraint', async () => {
    const rc = resolveConstraints(constraintsSchema.parse({}));
    const optimizer = fakeOptimizer(() => 1);

    const solution = await solveSizeTarget(file, rc, optimizer, context(rc));

    expect(optimizer.calls).toBe(0);
    expect(solution.file).toBe(file);
  });
});
