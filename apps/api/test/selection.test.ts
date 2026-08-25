import { beforeAll, describe, expect, it } from 'vitest';
import { planFromRules } from '../src/agent/fast-path.js';
import { planSchema } from '../src/core/plan.js';
import { archiveEngine } from '../src/engines/archive/index.js';
import { imageEngine } from '../src/engines/image/index.js';
import { pdfEngine } from '../src/engines/pdf/index.js';
import { describeSkipped, narrowForPlan, selectFiles } from '../src/execution/selection.js';
import { registry } from '../src/router/registry.js';
import type { WorkFile } from '../src/router/types.js';

const file = (name: string, mime: string, bytes: number): WorkFile => ({
  name,
  data: Buffer.alloc(bytes),
  mime,
  meta: {},
});

/** 4 JPEGs, 2 PNGs, 3 PDFs - the shape of a folder someone actually drops in. */
const batch = (): WorkFile[] => [
  file('photo1.jpg', 'image/jpeg', 900_000),
  file('photo2.jpg', 'image/jpeg', 800_000),
  file('photo3.jpg', 'image/jpeg', 700_000),
  file('photo4.jpg', 'image/jpeg', 100_000),
  file('shot1.png', 'image/png', 50_000),
  file('shot2.png', 'image/png', 40_000),
  file('doc1.pdf', 'application/pdf', 20_000),
  file('doc2.pdf', 'application/pdf', 30_000),
  file('doc3.pdf', 'application/pdf', 10_000),
];

beforeAll(async () => {
  registry.reset();
  await registry.register(imageEngine);
  await registry.register(pdfEngine);
  await registry.register(archiveEngine);
});

describe('picking files out of a bulk drop', () => {
  it('filters by family', () => {
    expect(selectFiles(batch(), { domains: ['image'], order: 'given' }).chosen).toHaveLength(6);
    expect(selectFiles(batch(), { domains: ['pdf'], order: 'given' }).chosen).toHaveLength(3);
  });

  it('filters by concrete format, treating jpg and jpeg as one', () => {
    expect(selectFiles(batch(), { formats: ['png'], order: 'given' }).chosen).toHaveLength(2);
    expect(selectFiles(batch(), { formats: ['jpg'], order: 'given' }).chosen).toHaveLength(4);
  });

  it('filters by size and by name', () => {
    expect(selectFiles(batch(), { minBytes: 500_000, order: 'given' }).chosen).toHaveLength(3);
    expect(selectFiles(batch(), { nameContains: 'shot', order: 'given' }).chosen).toHaveLength(2);
  });

  it('orders before limiting, so "the biggest" means the biggest', () => {
    const chosen = selectFiles(batch(), { order: 'size-desc', limit: 1 }).chosen;
    expect(chosen[0]?.name).toBe('photo1.jpg');
  });

  it('reports what it left behind in words', () => {
    const { skipped } = selectFiles(batch(), { domains: ['pdf'], order: 'given' });
    expect(describeSkipped(skipped)).toBe('4 JPEGs and 2 PNGs');
    expect(describeSkipped([file('a.pdf', 'application/pdf', 1)])).toBe('1 PDF');
  });
});

describe('a mixed batch narrows instead of failing', () => {
  const plan = (op: string, select?: unknown) =>
    planSchema.parse({
      intent: op,
      operations: [{ op, params: op === 'image.convert' ? { format: 'webp' } : {} }],
      constraints: {},
      ...(select ? { select } : {}),
    });

  it('merges the PDFs in a folder that also has images', () => {
    const result = narrowForPlan(batch(), plan('pdf.merge'));
    expect(result.files).toHaveLength(3);
    expect(result.note?.skipped).toBe('4 JPEGs and 2 PNGs');
  });

  it('converts only the images', () => {
    const result = narrowForPlan(batch(), plan('image.convert'));
    expect(result.files).toHaveLength(6);
    expect(result.note?.chosenCount).toBe(6);
    expect(result.note?.totalCount).toBe(9);
  });

  it('says nothing was left behind when everything was used', () => {
    const onlyPdfs = batch().filter((f) => f.mime === 'application/pdf');
    expect(narrowForPlan(onlyPdfs, plan('pdf.merge')).note).toBeUndefined();
  });

  it('still fails when nothing at all is usable', () => {
    const images = batch().filter((f) => f.mime.startsWith('image/'));
    expect(() => narrowForPlan(images, plan('pdf.merge'))).toThrow(/cannot accept/);
  });

  it('fails clearly when a selection matches no files', () => {
    expect(() => narrowForPlan(batch(), plan('image.convert', { domains: ['archive'] }))).toThrow(
      /Nothing matched/,
    );
  });
});

describe('reading a selection out of the sentence', () => {
  const ops = (prompt: string) => planFromRules(prompt, batch())?.plan;

  it('understands a family', () => {
    expect(ops('merge the pdfs')?.select?.domains).toEqual(['pdf']);
    expect(ops('zip the images')?.select?.domains).toEqual(['image']);
  });

  it('understands "the first N images"', () => {
    const plan = ops('convert the first 2 images to png');
    expect(plan?.select?.domains).toEqual(['image']);
    expect(plan?.select?.limit).toBe(2);
  });

  it('does not mistake a destination format for a selection', () => {
    // "convert the images to pdf" must select images and produce a PDF, not
    // select the PDFs.
    const plan = ops('convert the images to pdf');
    expect(plan?.select?.domains).toEqual(['image']);
    expect(plan?.select?.formats).toBeUndefined();
  });

  it('does not mistake the verb for a selection', () => {
    // "zip these" has no determiner in front of a noun, so there is nothing to
    // select - and reading `zip` as "the archives" would match no files at all.
    expect(ops('zip these')?.select).toBeUndefined();
  });

  it('leaves the selector off when the request names no subset', () => {
    expect(ops('convert to webp')?.select).toBeUndefined();
  });
});
