import { describe, expect, it } from 'vitest';
import { constraintsSchema } from '../src/core/plan.js';
import { describeWindow, evaluate, resolveConstraints } from '../src/constraints/engine.js';
import { parseSize, parseTolerance } from '../src/core/units.js';

const constraints = (input: unknown) => constraintsSchema.parse(input);

describe('size windows', () => {
  it('expands a tolerance into an inclusive byte range', () => {
    const rc = resolveConstraints(constraints({ size: { target: 300, unit: 'KB', tolerance: 0.05, mode: 'target' } }));

    expect(rc.size).toEqual({
      target: 307200,
      min: Math.floor(307200 * 0.95),
      max: Math.ceil(307200 * 1.05),
      mode: 'target',
    });
  });

  it('treats "max" mode as a ceiling with no floor', () => {
    const rc = resolveConstraints(constraints({ size: { target: 2, unit: 'MB', tolerance: 0.05, mode: 'max' } }));

    expect(rc.size?.min).toBe(0);
    expect(rc.size?.max).toBe(2 * 1024 * 1024);
    expect(describeWindow(rc)).toBe('at most 2.0 MB');
  });

  it('passes inside the window and fails outside it', () => {
    const rc = resolveConstraints(constraints({ size: { target: 300, unit: 'KB', tolerance: 0.05, mode: 'target' } }));

    expect(evaluate(rc, { bytes: 307_000 }).pass).toBe(true);
    expect(evaluate(rc, { bytes: 292_000 }).pass).toBe(true);
    expect(evaluate(rc, { bytes: 260_000 }).pass).toBe(false);
    expect(evaluate(rc, { bytes: 400_000 }).pass).toBe(false);
  });

  it('reports how far outside the window a result landed', () => {
    const rc = resolveConstraints(constraints({ size: { target: 100, unit: 'KB', tolerance: 0.1, mode: 'target' } }));

    expect(evaluate(rc, { bytes: 200_000 }).sizeDelta).toBeGreaterThan(0);
    expect(evaluate(rc, { bytes: 10_000 }).sizeDelta).toBeLessThan(0);
    expect(evaluate(rc, { bytes: 102_400 }).sizeDelta).toBe(0);
  });

  it('checks format and dimensions when they are constrained', () => {
    const rc = resolveConstraints(constraints({ format: 'webp', dimensions: { maxWidth: 1000 } }));

    expect(evaluate(rc, { bytes: 1, format: 'webp', width: 900 }).pass).toBe(true);
    expect(evaluate(rc, { bytes: 1, format: 'jpeg', width: 900 }).pass).toBe(false);
    expect(evaluate(rc, { bytes: 1, format: 'webp', width: 1200 }).pass).toBe(false);
  });

  it('treats jpg and jpeg as the same format', () => {
    const rc = resolveConstraints(constraints({ format: 'jpg' }));
    expect(evaluate(rc, { bytes: 1, format: 'image/jpeg' }).pass).toBe(true);
  });
});

describe('parsing sizes out of prose', () => {
  it.each([
    ['300kb', 307200],
    ['300 KB', 307200],
    ['1.5 MB', Math.round(1.5 * 1024 * 1024)],
    ['under 2mb', 2 * 1024 * 1024],
    ['500 kilobytes', 512000],
  ])('reads %s', (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it.each([
    ['±5%', 0.05],
    ['+/- 10%', 0.1],
    ['within 2%', 0.02],
    ['plus or minus 15 %', 0.15],
  ])('reads tolerance %s', (input, expected) => {
    expect(parseTolerance(input)).toBeCloseTo(expected, 5);
  });

  it('returns undefined when there is no size or tolerance', () => {
    expect(parseSize('make it smaller')).toBeUndefined();
    expect(parseTolerance('make it smaller')).toBeUndefined();
  });
});
