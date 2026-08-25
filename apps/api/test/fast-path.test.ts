import { describe, expect, it } from 'vitest';
import { planFromRules } from '../src/agent/fast-path.js';
import type { WorkFile } from '../src/router/types.js';

const image = (name = 'photo.jpg'): WorkFile => ({
  name,
  data: Buffer.alloc(1024),
  mime: 'image/jpeg',
  meta: { width: 4000, height: 3000 },
});

const pdf = (name = 'doc.pdf'): WorkFile => ({ name, data: Buffer.alloc(1024), mime: 'application/pdf', meta: {} });
const zip = (): WorkFile => ({ name: 'bundle.zip', data: Buffer.alloc(1024), mime: 'application/zip', meta: {} });

const ops = (prompt: string, files: WorkFile[]) => planFromRules(prompt, files)?.plan.operations.map((o) => o.op);

describe('requests that never touch a model', () => {
  it('converts a format', () => {
    const result = planFromRules('convert to webp', [image()]);
    expect(result?.plan.operations).toEqual([{ op: 'image.convert', params: { format: 'webp' } }]);
    expect(result?.plan.constraints.format).toBe('webp');
    expect(result?.plan.source).toBe('fast-path');
  });

  it('reads a size target with an explicit tolerance', () => {
    const plan = planFromRules('compress to 300kb ±5%', [image()])?.plan;

    expect(plan?.operations[0]?.op).toBe('image.compress');
    expect(plan?.constraints.size).toEqual({ target: 300, unit: 'KB', tolerance: 0.05, mode: 'target' });
  });

  it('treats "under X" as a ceiling rather than a target', () => {
    const plan = planFromRules('compress under 2mb', [image()])?.plan;
    expect(plan?.constraints.size?.mode).toBe('max');
  });

  it('defaults to a 5% tolerance when none is given', () => {
    const plan = planFromRules('compress to 300kb', [image()])?.plan;
    expect(plan?.constraints.size?.tolerance).toBe(0.05);
    expect(plan?.constraints.size?.mode).toBe('target');
  });

  it('reads explicit dimensions', () => {
    const plan = planFromRules('resize to 1200x800', [image()])?.plan;
    expect(plan?.operations[0]).toEqual({
      op: 'image.resize',
      params: { width: 1200, height: 800, fit: 'inside' },
    });
  });

  it('infers compression from a bare size target', () => {
    expect(ops('300kb', [image()])).toEqual(['image.compress']);
    expect(ops('300kb', [pdf()])).toEqual(['pdf.compress']);
  });

  it('routes the same verb to the right engine for the file type', () => {
    expect(ops('rotate 90', [image()])).toEqual(['image.rotate']);
    expect(ops('rotate 90', [pdf()])).toEqual(['pdf.rotate']);
  });

  it('handles pdf page selection, merging and archives', () => {
    expect(ops('extract pages 1-3', [pdf(), pdf('b.pdf')])).toEqual(['pdf.extract-pages']);
    expect(ops('merge these pdfs', [pdf(), pdf('b.pdf')])).toEqual(['pdf.merge']);
    expect(ops('zip these files', [image(), image('b.jpg')])).toEqual(['archive.create']);
    expect(ops('unzip this', [zip()])).toEqual(['archive.extract']);
  });

  it('combines several instructions in one prompt', () => {
    const plan = planFromRules('convert to webp and resize to 800x600', [image()])?.plan;
    expect(plan?.operations.map((o) => o.op)).toEqual(['image.resize', 'image.convert']);
  });
});

describe('requests that must go to a model', () => {
  it.each([
    'make this suitable for my website',
    'optimize for social media',
    'make it look good but keep the size sensible',
    'do whatever you think is best',
    'prepare these for print',
  ])('defers "%s"', (prompt) => {
    expect(planFromRules(prompt, [image()])).toBeUndefined();
  });

  it('defers when part of the prompt is not understood', () => {
    // "watermark" is a real instruction the rule engine cannot express, so
    // silently ignoring it would be worse than handing the prompt to a model.
    expect(planFromRules('convert to webp and add a watermark', [image()])).toBeUndefined();
  });

  it('defers an empty or very long prompt', () => {
    expect(planFromRules('', [image()])).toBeUndefined();
    expect(planFromRules('convert to webp '.repeat(40), [image()])).toBeUndefined();
  });
});
