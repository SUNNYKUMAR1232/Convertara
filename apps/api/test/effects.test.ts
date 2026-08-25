import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { planFromRules } from '../src/agent/fast-path.js';
import { planSchema } from '../src/core/plan.js';
import { removeBackground } from '../src/engines/image/background.js';
import { watermarkSvg } from '../src/engines/image/watermark.js';
import { archiveEngine } from '../src/engines/archive/index.js';
import { imageEngine } from '../src/engines/image/index.js';
import { pdfEngine } from '../src/engines/pdf/index.js';
import { execute } from '../src/execution/executor.js';
import { registry } from '../src/router/registry.js';
import type { WorkFile } from '../src/router/types.js';

/** A product shot: even backdrop, solid subject in the middle. */
async function productShot(width = 400, height = 300): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3, 245);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - width / 2;
      const dy = y - height / 2;
      if (dx * dx + dy * dy <= 80 * 80) {
        const offset = (y * width + x) * 3;
        pixels[offset] = 210;
        pixels[offset + 1] = 70;
        pixels[offset + 2] = 60;
      }
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

const workFile = (data: Buffer, name: string, mime: string): WorkFile => ({ name, data, mime, meta: {} });

beforeAll(async () => {
  registry.reset();
  await registry.register(imageEngine);
  await registry.register(pdfEngine);
  await registry.register(archiveEngine);
});

describe('removing a background', () => {
  it('clears the backdrop and keeps the subject', async () => {
    const result = await removeBackground(await productShot(), { tolerance: 12, feather: 0 });

    const alphaAt = (x: number, y: number) => result.data[(y * result.width + x) * 4 + 3];
    expect(alphaAt(2, 2)).toBe(0); // corner: backdrop
    expect(alphaAt(200, 150)).toBe(255); // centre: subject
    expect(result.removed).toBeGreaterThan(0.5);
    expect(result.removed).toBeLessThan(0.95);
  }, 30_000);

  it('samples the border rather than assuming white', async () => {
    const blue = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 20, g: 60, b: 200 } },
    })
      .png()
      .toBuffer();

    const result = await removeBackground(blue, { tolerance: 10, feather: 0 });
    expect(result.background).toMatchObject({ r: 20, g: 60, b: 200 });
    expect(result.removed).toBeGreaterThan(0.99);
  }, 30_000);

  it('leaves an enclosed area alone - a hole is not the background', async () => {
    // A ring: the middle is the same colour as the backdrop but does not touch
    // an edge, so a flood from the border must never reach it.
    const size = 200;
    const pixels = Buffer.alloc(size * size * 3, 250);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - 100;
        const dy = y - 100;
        const distance = Math.hypot(dx, dy);
        if (distance <= 70 && distance >= 35) {
          const offset = (y * size + x) * 3;
          pixels[offset] = 30;
          pixels[offset + 1] = 30;
          pixels[offset + 2] = 30;
        }
      }
    }
    const ring = await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();

    const result = await removeBackground(ring, { tolerance: 8, feather: 0 });
    expect(result.data[(100 * size + 100) * 4 + 3]).toBe(255);
    expect(result.data[3]).toBe(0);
  }, 30_000);

  it('converts to a format that can hold transparency', async () => {
    const jpeg = await sharp(await productShot()).jpeg().toBuffer();
    const plan = planSchema.parse({
      intent: 'cut out',
      operations: [{ op: 'image.remove-background', params: {} }],
      constraints: {},
    });

    const result = await execute({ jobId: 't', plan, files: [workFile(jpeg, 'p.jpg', 'image/jpeg')] });
    // A JPEG cut-out is pointless - JPEG has no alpha channel.
    expect(result.files[0]!.mime).toBe('image/png');
    expect(result.files[0]!.meta.removedFraction).toBeGreaterThan(0.4);
  }, 30_000);
});

describe('watermarking', () => {
  it('actually changes pixels, which means the font resolved', async () => {
    const source = await productShot(300, 200);
    const plan = planSchema.parse({
      intent: 'mark',
      operations: [{ op: 'image.watermark', params: { text: 'CONFIDENTIAL', opacity: 0.6 } }],
      constraints: {},
    });

    const result = await execute({ jobId: 't', plan, files: [workFile(source, 'p.png', 'image/png')] });
    const before = await sharp(source).raw().toBuffer();
    const after = await sharp(result.files[0]!.data).raw().toBuffer();

    let changed = 0;
    for (let i = 0; i < Math.min(before.length, after.length); i += 1) {
      if (Math.abs(before[i]! - after[i]!) > 8) changed += 1;
    }
    // A missing font renders nothing at all and the image comes back identical,
    // with no error anywhere - so this is the check that catches it.
    expect(changed).toBeGreaterThan(500);
  }, 30_000);

  it('escapes text so a stray angle bracket cannot break the SVG', () => {
    const svg = watermarkSvg(100, 100, {
      text: '<script>&"\'',
      anchor: 'center',
      opacity: 0.4,
      scale: 0.06,
      color: '#fff',
      rotate: 0,
      tile: false,
      margin: 10,
    }).toString();

    expect(svg).toContain('&lt;script&gt;');
    expect(svg).not.toContain('<script>');
  });

  it('stamps every page of a PDF', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]);
    doc.addPage([300, 200]);
    const pdf = Buffer.from(await doc.save());

    const plan = planSchema.parse({
      intent: 'mark',
      operations: [{ op: 'pdf.watermark', params: { text: 'DRAFT' } }],
      constraints: {},
    });

    const result = await execute({ jobId: 't', plan, files: [workFile(pdf, 'd.pdf', 'application/pdf')] });
    expect(result.files[0]!.mime).toBe('application/pdf');
    expect(result.files[0]!.data.length).toBeGreaterThan(pdf.length);
  }, 30_000);
});

describe('asking for either in plain language', () => {
  const image = (): WorkFile[] => [workFile(Buffer.alloc(16), 'p.jpg', 'image/jpeg')];
  const pdf = (): WorkFile[] => [workFile(Buffer.alloc(16), 'd.pdf', 'application/pdf')];
  const ops = (prompt: string, files = image()) => planFromRules(prompt, files)?.plan.operations;

  it.each(['remove the background', 'remove bg', 'make the background transparent', 'cut out the background'])(
    'understands "%s" with no model',
    (prompt) => {
      expect(ops(prompt)?.[0]?.op).toBe('image.remove-background');
    },
  );

  it('picks up the watermark text', () => {
    const operations = ops('watermark it with CONFIDENTIAL');
    expect(operations?.[0]).toEqual({ op: 'image.watermark', params: { text: 'confidential', tile: false } });
  });

  it('routes a PDF watermark to the PDF engine', () => {
    expect(ops('watermark it with DRAFT', pdf())?.[0]?.op).toBe('pdf.watermark');
  });

  it('notices when the watermark should be tiled', () => {
    const operations = ops('watermark it across the whole thing with SAMPLE');
    expect((operations?.[0]?.params as { tile?: boolean })?.tile).toBe(true);
  });

  it('does not invent a watermark with no text to stamp', () => {
    expect(planFromRules('watermark it', image())).toBeUndefined();
  });
});
