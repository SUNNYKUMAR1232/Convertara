import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { planFromRules } from '../src/agent/fast-path.js';
import { planSchema } from '../src/core/plan.js';
import { execute } from '../src/execution/executor.js';
import { archiveEngine } from '../src/engines/archive/index.js';
import { imageEngine } from '../src/engines/image/index.js';
import { pdfEngine } from '../src/engines/pdf/index.js';
import { registry } from '../src/router/registry.js';
import type { WorkFile } from '../src/router/types.js';

/** A noisy photo-like image: compresses roughly the way a real photo does. */
async function samplePhoto(width = 1600, height = 1200): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i += 1) {
    pixels[i] = (Math.sin(i * 0.37) * 127 + 128) ^ (i % 251);
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
}

async function workFile(data: Buffer, name: string, mime: string): Promise<WorkFile> {
  return { name, data, mime, meta: {} };
}

beforeAll(async () => {
  registry.reset();
  await registry.register(imageEngine);
  await registry.register(pdfEngine);
  await registry.register(archiveEngine);
});

describe('end to end, no model involved', () => {
  it('hits a 300KB +/-5% target on a real image', async () => {
    const source = await samplePhoto();
    const decision = planFromRules('compress to 300kb ±5%', [await workFile(source, 'photo.jpg', 'image/jpeg')]);
    expect(decision).toBeDefined();

    const result = await execute({
      jobId: 'test-size',
      plan: decision!.plan,
      files: [await workFile(source, 'photo.jpg', 'image/jpeg')],
    });

    const bytes = result.files[0]!.data.length;
    expect(bytes).toBeGreaterThanOrEqual(Math.floor(307200 * 0.95));
    expect(bytes).toBeLessThanOrEqual(Math.ceil(307200 * 1.05));
    expect(result.satisfied).toBe(true);
  }, 60_000);

  it('converts to webp and reports the format it actually produced', async () => {
    const source = await samplePhoto(600, 400);
    const decision = planFromRules('convert to webp', [await workFile(source, 'photo.jpg', 'image/jpeg')]);

    const result = await execute({
      jobId: 'test-convert',
      plan: decision!.plan,
      files: [await workFile(source, 'photo.jpg', 'image/jpeg')],
    });

    expect(result.files[0]!.mime).toBe('image/webp');
    expect(result.files[0]!.name).toBe('photo.webp');
    expect(result.satisfied).toBe(true);
  }, 30_000);

  it('resizes within a maximum dimension', async () => {
    const source = await samplePhoto(2000, 1000);
    const plan = planSchema.parse({
      intent: 'resize',
      operations: [{ op: 'image.resize', params: { width: 800, height: 800, fit: 'inside' } }],
      constraints: { dimensions: { maxWidth: 800, maxHeight: 800 } },
    });

    const result = await execute({
      jobId: 'test-resize',
      plan,
      files: [await workFile(source, 'photo.jpg', 'image/jpeg')],
    });

    expect(result.files[0]!.meta.width).toBe(800);
    expect(result.files[0]!.meta.height).toBe(400);
    expect(result.satisfied).toBe(true);
  }, 30_000);

  it('zips several outputs into one download', async () => {
    const a = await samplePhoto(300, 200);
    const b = await samplePhoto(320, 240);
    const plan = planSchema.parse({
      intent: 'convert both',
      operations: [{ op: 'image.convert', params: { format: 'png' } }],
      constraints: {},
      output: { bundle: 'auto' },
    });

    const result = await execute({
      jobId: 'test-bundle',
      plan,
      files: [await workFile(a, 'a.jpg', 'image/jpeg'), await workFile(b, 'b.jpg', 'image/jpeg')],
    });

    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.mime).toBe('application/zip');
  }, 30_000);

  it('refuses a plan whose operation cannot accept the input type', async () => {
    const source = await samplePhoto(200, 200);
    const plan = planSchema.parse({
      intent: 'merge an image',
      operations: [{ op: 'pdf.merge', params: {} }],
      constraints: {},
    });

    await expect(
      execute({ jobId: 'test-mismatch', plan, files: [await workFile(source, 'photo.jpg', 'image/jpeg')] }),
    ).rejects.toThrow(/cannot accept/);
  }, 30_000);

  it('refuses an unknown operation before touching a byte', async () => {
    const source = await samplePhoto(200, 200);
    const plan = planSchema.parse({
      intent: 'hallucinated capability',
      operations: [{ op: 'image.enhance', params: {} }],
      constraints: {},
    });

    await expect(
      execute({ jobId: 'test-unknown', plan, files: [await workFile(source, 'photo.jpg', 'image/jpeg')] }),
    ).rejects.toThrow(/Unknown operation/);
  }, 30_000);

  it('round-trips a zip through create and extract', async () => {
    const a = await samplePhoto(120, 120);
    const create = planSchema.parse({
      intent: 'zip',
      operations: [{ op: 'archive.create', params: { filename: 'bundle.zip' } }],
      constraints: {},
      output: { bundle: 'single' },
    });

    const zipped = await execute({
      jobId: 'test-zip',
      plan: create,
      files: [await workFile(a, 'a.jpg', 'image/jpeg')],
    });
    expect(zipped.files[0]!.mime).toBe('application/zip');

    const extract = planSchema.parse({
      intent: 'unzip',
      operations: [{ op: 'archive.extract', params: {} }],
      constraints: {},
      output: { bundle: 'single' },
    });

    const unzipped = await execute({ jobId: 'test-unzip', plan: extract, files: zipped.files });
    expect(unzipped.files[0]!.name).toBe('a.jpg');
    expect(unzipped.files[0]!.mime).toBe('image/jpeg');
  }, 30_000);
});
