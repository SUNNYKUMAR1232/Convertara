import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import type { Capability, EnginePlugin, OpInput, SizeOptimizer, WorkFile } from '../../router/types.js';
import { OPTIMIZER_PRESET, compressPdf, ghostscriptAvailable } from './ghostscript.js';
import { parsePageRange } from './pages.js';

const PDF_MIME = 'application/pdf';
const ACCEPTS = [PDF_MIME];
const always = () => true;

async function load(file: WorkFile): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(file.data, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    throw new AppError('EXECUTION_FAILED', `Could not read ${file.name}: ${(error as Error).message}`);
  }
}

async function emit(name: string, doc: PDFDocument): Promise<WorkFile> {
  const bytes = await doc.save({ useObjectStreams: true });
  return {
    name: name.endsWith('.pdf') ? name : `${name.replace(/\.[^./\\]+$/, '')}.pdf`,
    data: Buffer.from(bytes),
    mime: PDF_MIME,
    meta: { pages: doc.getPageCount() },
  };
}

function wrap(name: string, data: Buffer, pages?: number): WorkFile {
  return { name, data, mime: PDF_MIME, meta: pages === undefined ? {} : { pages } };
}

const merge: Capability = {
  name: 'pdf.merge',
  domain: 'pdf',
  title: 'Merge PDFs',
  description: 'Concatenate several PDFs into one, in the order given.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 2,
  available: always,
  paramsHint: 'filename: optional output name. Needs two or more input PDFs',
  paramsSchema: z.object({ filename: z.string().max(120).optional() }),
  run: async (input: OpInput<{ filename?: string }>) => {
    if (input.files.length < 2) throw new AppError('BAD_REQUEST', 'Merging needs at least two PDFs');
    const out = await PDFDocument.create();
    for (const [i, file] of input.files.entries()) {
      input.ctx.signal.throwIfAborted();
      const doc = await load(file);
      const pages = await out.copyPages(doc, doc.getPageIndices());
      for (const page of pages) out.addPage(page);
      input.ctx.progress((i + 1) / input.files.length);
    }
    return [await emit(input.params.filename ?? 'merged.pdf', out)];
  },
};

const split: Capability = {
  name: 'pdf.split',
  domain: 'pdf',
  title: 'Split a PDF',
  description: 'Break a PDF into one file per page, or into fixed-size chunks.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 2,
  available: always,
  paramsHint: 'every: pages per output file (default 1)',
  paramsSchema: z.object({ every: z.number().int().positive().max(1000).default(1) }),
  run: async (input: OpInput<{ every: number }>) => {
    const out: WorkFile[] = [];
    for (const file of input.files) {
      const doc = await load(file);
      const total = doc.getPageCount();
      const stem = file.name.replace(/\.pdf$/i, '');
      for (let start = 0; start < total; start += input.params.every) {
        input.ctx.signal.throwIfAborted();
        const indices = Array.from(
          { length: Math.min(input.params.every, total - start) },
          (_, i) => start + i,
        );
        const chunk = await PDFDocument.create();
        const pages = await chunk.copyPages(doc, indices);
        for (const page of pages) chunk.addPage(page);
        const last = indices[indices.length - 1] ?? start;
        const label = indices.length === 1 ? `${start + 1}` : `${start + 1}-${last + 1}`;
        out.push(await emit(`${stem}-p${label}.pdf`, chunk));
        input.ctx.progress(Math.min(1, (start + input.params.every) / total));
      }
    }
    return out;
  },
};

const extractPages: Capability = {
  name: 'pdf.extract-pages',
  domain: 'pdf',
  title: 'Extract pages',
  description: 'Keep only the selected pages, e.g. "1-3,7,10-".',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 2,
  available: always,
  paramsHint: 'pages: selection string such as \"1-3,7,10-\" (required)',
  paramsSchema: z.object({ pages: z.string().min(1).max(200) }),
  run: async (input: OpInput<{ pages: string }>) => {
    const out: WorkFile[] = [];
    for (const file of input.files) {
      const doc = await load(file);
      const indices = parsePageRange(input.params.pages, doc.getPageCount());
      const picked = await PDFDocument.create();
      const pages = await picked.copyPages(doc, indices);
      for (const page of pages) picked.addPage(page);
      out.push(await emit(file.name.replace(/\.pdf$/i, '-pages.pdf'), picked));
    }
    return out;
  },
};

const rotate: Capability = {
  name: 'pdf.rotate',
  domain: 'pdf',
  title: 'Rotate pages',
  description: 'Rotate every page, or a selection, by a multiple of 90 degrees.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 2,
  available: always,
  paramsHint: 'angle: multiple of 90 (required), pages: selection string (default all)',
  paramsSchema: z.object({
    angle: z.number().int().refine((a) => a % 90 === 0, 'angle must be a multiple of 90'),
    pages: z.string().max(200).default('all'),
  }),
  run: async (input: OpInput<{ angle: number; pages: string }>) => {
    const out: WorkFile[] = [];
    for (const file of input.files) {
      const doc = await load(file);
      const indices = parsePageRange(input.params.pages, doc.getPageCount());
      for (const index of indices) {
        const page = doc.getPage(index);
        page.setRotation(degrees((page.getRotation().angle + input.params.angle) % 360));
      }
      out.push(await emit(file.name, doc));
    }
    return out;
  },
};

const setMetadata: Capability = {
  name: 'pdf.metadata',
  domain: 'pdf',
  title: 'Set PDF metadata',
  description: 'Write title, author, subject and keywords, or clear them entirely.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 1,
  available: always,
  paramsHint: 'title, author, subject, keywords: string[], clear: boolean to wipe all metadata',
  paramsSchema: z.object({
    title: z.string().max(300).optional(),
    author: z.string().max(300).optional(),
    subject: z.string().max(300).optional(),
    keywords: z.array(z.string().max(80)).max(40).optional(),
    clear: z.boolean().default(false),
  }),
  run: async (input: OpInput<{ title?: string; author?: string; subject?: string; keywords?: string[]; clear: boolean }>) => {
    const out: WorkFile[] = [];
    for (const file of input.files) {
      const doc = await load(file);
      const p = input.params;
      if (p.clear) {
        doc.setTitle('');
        doc.setAuthor('');
        doc.setSubject('');
        doc.setKeywords([]);
        doc.setProducer('');
        doc.setCreator('');
      }
      if (p.title !== undefined) doc.setTitle(p.title);
      if (p.author !== undefined) doc.setAuthor(p.author);
      if (p.subject !== undefined) doc.setSubject(p.subject);
      if (p.keywords !== undefined) doc.setKeywords(p.keywords);
      out.push(await emit(file.name, doc));
    }
    return out;
  },
};

const fromImages: Capability = {
  name: 'pdf.from-images',
  domain: 'pdf',
  title: 'Images to PDF',
  description: 'Place each image on its own page, scaled to fit.',
  accepts: ['image/jpeg', 'image/png'],
  produces: PDF_MIME,
  cost: 3,
  available: always,
  paramsHint: 'pageSize: fit|a4|letter, margin: points, filename: output name',
  paramsSchema: z.object({
    pageSize: z.enum(['fit', 'a4', 'letter']).default('fit'),
    margin: z.number().min(0).max(200).default(0),
    filename: z.string().max(120).default('document.pdf'),
  }),
  run: async (input: OpInput<{ pageSize: 'fit' | 'a4' | 'letter'; margin: number; filename: string }>) => {
    const doc = await PDFDocument.create();
    const sizes: Record<string, [number, number]> = { a4: [595.28, 841.89], letter: [612, 792] };

    for (const [i, file] of input.files.entries()) {
      input.ctx.signal.throwIfAborted();
      const image =
        file.mime === 'image/png' ? await doc.embedPng(file.data) : await doc.embedJpg(file.data);
      const margin = input.params.margin;

      if (input.params.pageSize === 'fit') {
        const page = doc.addPage([image.width + margin * 2, image.height + margin * 2]);
        page.drawImage(image, { x: margin, y: margin, width: image.width, height: image.height });
      } else {
        const [w, h] = sizes[input.params.pageSize] ?? [595.28, 841.89];
        const page = doc.addPage([w, h]);
        const scale = Math.min((w - margin * 2) / image.width, (h - margin * 2) / image.height);
        const width = image.width * scale;
        const height = image.height * scale;
        page.drawImage(image, { x: (w - width) / 2, y: (h - height) / 2, width, height });
      }
      input.ctx.progress((i + 1) / input.files.length);
    }
    return [await emit(input.params.filename, doc)];
  },
};

const watermark: Capability = {
  name: 'pdf.watermark',
  domain: 'pdf',
  title: 'Watermark a PDF',
  description: 'Stamp text diagonally across every page, or a selection of pages.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 2,
  available: always,
  paramsHint:
    'text (required), opacity: 0-1 (default 0.18), rotate: degrees (default 45), color: hex, size: points, pages: selection string',
  paramsSchema: z.object({
    text: z.string().min(1).max(120),
    opacity: z.number().min(0.02).max(1).default(0.18),
    rotate: z.number().min(-180).max(180).default(45),
    color: z
      .string()
      .regex(/^#?[0-9a-fA-F]{6}$/)
      .default('#808080'),
    size: z.number().min(6).max(400).optional(),
    pages: z.string().max(200).default('all'),
  }),
  run: async (input: OpInput<any>) => {
    const out: WorkFile[] = [];

    for (const file of input.files) {
      const doc = await load(file);
      // A standard font, so this needs nothing installed on the host - unlike
      // the image watermark, which rasterises text and so needs real fonts.
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      const indices = parsePageRange(input.params.pages, doc.getPageCount());
      const colour = hexToRgb(input.params.color);

      for (const index of indices) {
        const page = doc.getPage(index);
        const { width, height } = page.getSize();

        // The default spans most of the page diagonal, which is what a
        // watermark is for. A fixed default would be invisible on A0.
        const size =
          input.params.size ??
          Math.max(12, (Math.hypot(width, height) * 0.8) / Math.max(1, input.params.text.length * 0.6));
        const textWidth = font.widthOfTextAtSize(input.params.text, size);
        const radians = (input.params.rotate * Math.PI) / 180;

        page.drawText(input.params.text, {
          x: width / 2 - (textWidth / 2) * Math.cos(radians),
          y: height / 2 - (textWidth / 2) * Math.sin(radians),
          size,
          font,
          color: rgb(colour.r / 255, colour.g / 255, colour.b / 255),
          opacity: input.params.opacity,
          rotate: degrees(input.params.rotate),
        });
      }

      out.push(await emit(file.name, doc));
    }
    return out;
  },
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

const compress: Capability = {
  name: 'pdf.compress',
  domain: 'pdf',
  title: 'Compress a PDF',
  description: 'Downsample embedded images and re-compress. Requires Ghostscript on the host.',
  accepts: ACCEPTS,
  produces: PDF_MIME,
  cost: 8,
  available: ghostscriptAvailable,
  paramsHint: 'quality: 1-100 (default 60). Lower means more aggressive image downsampling',
  paramsSchema: z.object({ quality: z.number().int().min(1).max(100).default(60) }),
  run: async (input: OpInput<{ quality: number }>) => {
    const out: WorkFile[] = [];
    for (const [i, file] of input.files.entries()) {
      input.ctx.signal.throwIfAborted();
      const data = await compressPdf(file.data, input.params.quality, input.ctx.signal);
      out.push(wrap(file.name, data));
      input.ctx.progress((i + 1) / input.files.length);
    }
    return out;
  },
};

/**
 * `scale` is unused for PDFs - page geometry stays fixed and image resolution
 * carries the whole range.
 *
 * The quality ceiling is 80, not 100: above roughly that the requested
 * resolution exceeds what the embedded images actually contain, nothing gets
 * downsampled, and every setting returns the same source-sized file. Searching
 * that flat region wastes encodes. The preset is pinned for the same reason the
 * threshold is set - to keep the curve continuous enough to binary search.
 */
const optimizer: SizeOptimizer = {
  domain: 'pdf',
  supports: (file) => file.mime === PDF_MIME,
  knobs: (_file, rc) => ({ quality: { min: Math.max(5, rc.minQuality - 20), max: 80 }, scale: { min: 1, max: 1 } }),
  render: async (file, { quality }, ctx) =>
    wrap(file.name, await compressPdf(file.data, quality, ctx.signal, OPTIMIZER_PRESET)),
};

export const pdfEngine: EnginePlugin = {
  domain: 'pdf',
  title: 'PDF engine (pdf-lib, Ghostscript)',
  capabilities: [merge, split, extractPages, rotate, setMetadata, fromImages, watermark, compress],
  optimizer,
};
