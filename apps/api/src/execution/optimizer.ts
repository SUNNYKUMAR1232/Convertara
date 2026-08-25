import type { ResolvedConstraints, ResolvedSizeWindow } from '../constraints/engine.js';
import type { EngineContext, SizeOptimizer, WorkFile } from '../router/types.js';

export interface Attempt {
  quality: number;
  scale: number;
  bytes: number;
}

export interface SizeSolution {
  file: WorkFile;
  attempts: Attempt[];
  satisfied: boolean;
}

const QUALITY_STEPS = 6;
const SCALE_STEPS = 5;
const REFINE_STEPS = 3;

/**
 * Hits a byte target without asking the model anything.
 *
 * Encoded size rises monotonically with quality and with scale, so a bounded
 * binary search gets inside a +/-5% window in about seven encodes instead of
 * the dozen-plus a linear "try 80, try 70, try 60" loop would need. Quality is
 * spent first and dimensions only when quality alone cannot get there, because
 * users notice a smaller picture more than they notice a softer one.
 */
export async function solveSizeTarget(
  input: WorkFile,
  rc: ResolvedConstraints,
  optimizer: SizeOptimizer,
  ctx: EngineContext,
): Promise<SizeSolution> {
  const window = rc.size;
  if (!window) return { file: input, attempts: [], satisfied: true };

  const knobs = optimizer.knobs(input, rc);
  const attempts: Attempt[] = [];
  const cache = new Map<string, WorkFile>();

  const render = async (quality: number, scale: number): Promise<WorkFile> => {
    const key = `${quality}:${scale.toFixed(3)}`;
    const hit = cache.get(key);
    if (hit) return hit;

    ctx.signal.throwIfAborted();
    const out = await optimizer.render(input, { quality, scale }, ctx);
    cache.set(key, out);
    attempts.push({ quality, scale, bytes: out.data.length });
    ctx.progress(Math.min(0.95, attempts.length / (QUALITY_STEPS + SCALE_STEPS + REFINE_STEPS)));
    return out;
  };

  let best: WorkFile | undefined;
  const consider = (candidate: WorkFile): boolean => {
    if (!best || score(candidate.data.length, window) < score(best.data.length, window)) best = candidate;
    return inside(candidate.data.length, window);
  };

  // Phase 1 - quality only, full size.
  let landed = await searchQuality(render, consider, knobs.quality, 1, window, QUALITY_STEPS);

  // Phase 2 - still too big at the lowest acceptable quality, so give up pixels.
  if (!landed && best && best.data.length > window.max && knobs.scale.min < 1) {
    const holdQuality = Math.round(knobs.quality.min + (knobs.quality.max - knobs.quality.min) * 0.35);
    let low = knobs.scale.min;
    let high = knobs.scale.max;

    for (let i = 0; i < SCALE_STEPS && high - low > 0.02; i += 1) {
      const mid = (low + high) / 2;
      const candidate = await render(holdQuality, mid);
      if (candidate.data.length > window.max) high = mid;
      else low = mid;
      if (consider(candidate)) {
        landed = true;
        break;
      }
    }

    // Phase 3 - claw quality back at the scale we settled on.
    if (!landed) {
      landed = await searchQuality(render, consider, knobs.quality, low, window, REFINE_STEPS);
    }
  }

  const file = best ?? input;
  return { file, attempts, satisfied: inside(file.data.length, window) };
}

async function searchQuality(
  render: (q: number, s: number) => Promise<WorkFile>,
  consider: (f: WorkFile) => boolean,
  range: { min: number; max: number },
  scale: number,
  window: ResolvedSizeWindow,
  steps: number,
): Promise<boolean> {
  let low = range.min;
  let high = range.max;

  for (let i = 0; i < steps && low <= high; i += 1) {
    const mid = Math.round((low + high) / 2);
    const candidate = await render(mid, scale);
    const bytes = candidate.data.length;
    const isInside = consider(candidate);

    // In `max` mode anything under the ceiling passes, so keep climbing to find
    // the best quality that still fits instead of stopping at the first hit.
    if (isInside && window.mode === 'target') return true;

    if (bytes > window.max) high = mid - 1;
    else low = mid + 1;
  }
  return false;
}

function inside(bytes: number, w: ResolvedSizeWindow): boolean {
  return bytes >= w.min && bytes <= w.max;
}

/** Lower is better. Anything over the ceiling is penalised hard. */
function score(bytes: number, w: ResolvedSizeWindow): number {
  if (bytes > w.max) return (bytes - w.max) * 4 + 1e9;
  if (bytes < w.min) return w.min - bytes;
  return Math.abs(bytes - w.target);
}
