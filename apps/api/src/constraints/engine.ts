import type { Constraints } from '../core/plan.js';
import { sizeTargetBytes } from '../core/plan.js';
import { formatBytes } from '../core/units.js';

export interface ResolvedSizeWindow {
  target: number;
  min: number;
  max: number;
  mode: 'target' | 'max';
}

export interface ResolvedConstraints {
  size?: ResolvedSizeWindow;
  maxWidth?: number;
  maxHeight?: number;
  exactWidth?: number;
  exactHeight?: number;
  minScale: number;
  minQuality: number;
  format?: string;
  stripMetadata: boolean;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Evaluation {
  pass: boolean;
  checks: CheckResult[];
  /** Signed distance from the acceptable window, in bytes. <0 too small, >0 too large. */
  sizeDelta?: number;
}

export interface OutputFacts {
  bytes: number;
  format?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Turns a declarative constraint block into concrete numbers. This is the only
 * place a tolerance is expanded into a byte window, so the optimizer, the
 * validator and the user-facing message can never disagree.
 */
export function resolveConstraints(c: Constraints): ResolvedConstraints {
  const resolved: ResolvedConstraints = {
    minScale: c.dimensions?.minScale ?? 0.35,
    minQuality: c.minQuality,
    stripMetadata: c.stripMetadata,
  };
  if (c.format) resolved.format = c.format.toLowerCase();

  if (c.size) {
    const target = sizeTargetBytes(c.size);
    resolved.size =
      c.size.mode === 'max'
        ? { target, min: 0, max: target, mode: 'max' }
        : {
            target,
            min: Math.floor(target * (1 - c.size.tolerance)),
            max: Math.ceil(target * (1 + c.size.tolerance)),
            mode: 'target',
          };
  }

  const d = c.dimensions;
  if (d) {
    if (d.maxWidth !== undefined) resolved.maxWidth = d.maxWidth;
    if (d.maxHeight !== undefined) resolved.maxHeight = d.maxHeight;
    if (d.width !== undefined) resolved.exactWidth = d.width;
    if (d.height !== undefined) resolved.exactHeight = d.height;
  }
  return resolved;
}

export function evaluate(rc: ResolvedConstraints, facts: OutputFacts): Evaluation {
  const checks: CheckResult[] = [];
  let sizeDelta: number | undefined;

  if (rc.size) {
    const { min, max } = rc.size;
    const inWindow = facts.bytes >= min && facts.bytes <= max;
    sizeDelta = facts.bytes > max ? facts.bytes - max : facts.bytes < min ? facts.bytes - min : 0;
    checks.push({
      name: 'size',
      pass: inWindow,
      detail: `${formatBytes(facts.bytes)} ${inWindow ? 'within' : 'outside'} ${formatBytes(min)}–${formatBytes(max)}`,
    });
  }

  if (rc.format) {
    const pass = normaliseFormat(facts.format) === normaliseFormat(rc.format);
    checks.push({ name: 'format', pass, detail: `got ${facts.format ?? 'unknown'}, want ${rc.format}` });
  }

  if (rc.maxWidth !== undefined && facts.width !== undefined) {
    checks.push({
      name: 'maxWidth',
      pass: facts.width <= rc.maxWidth,
      detail: `${facts.width}px <= ${rc.maxWidth}px`,
    });
  }
  if (rc.maxHeight !== undefined && facts.height !== undefined) {
    checks.push({
      name: 'maxHeight',
      pass: facts.height <= rc.maxHeight,
      detail: `${facts.height}px <= ${rc.maxHeight}px`,
    });
  }
  if (rc.exactWidth !== undefined && facts.width !== undefined) {
    checks.push({ name: 'width', pass: facts.width === rc.exactWidth, detail: `${facts.width}px == ${rc.exactWidth}px` });
  }
  if (rc.exactHeight !== undefined && facts.height !== undefined) {
    checks.push({
      name: 'height',
      pass: facts.height === rc.exactHeight,
      detail: `${facts.height}px == ${rc.exactHeight}px`,
    });
  }

  const evaluation: Evaluation = { pass: checks.every((c) => c.pass), checks };
  if (sizeDelta !== undefined) evaluation.sizeDelta = sizeDelta;
  return evaluation;
}

export function describeWindow(rc: ResolvedConstraints): string | undefined {
  if (!rc.size) return undefined;
  return rc.size.mode === 'max'
    ? `at most ${formatBytes(rc.size.max)}`
    : `${formatBytes(rc.size.min)}–${formatBytes(rc.size.max)} (target ${formatBytes(rc.size.target)})`;
}

const ALIASES: Record<string, string> = { jpg: 'jpeg', tif: 'tiff', heic: 'heif' };
export function normaliseFormat(f?: string | undefined): string | undefined {
  if (!f) return undefined;
  const lower = f.toLowerCase().replace(/^image\//, '').replace(/^application\//, '');
  return ALIASES[lower] ?? lower;
}
