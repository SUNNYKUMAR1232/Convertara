import { z } from 'zod';
import { AppError } from '../../core/errors.js';
import type { Capability, EnginePlugin, OpInput, SizeOptimizer, WorkFile } from '../../router/types.js';
import { IMAGE_FORMATS, MIME_BY_FORMAT, encode, formatFromMime, probe, sharp } from './sharp-util.js';
import type { ImageFormat } from './sharp-util.js';

const formatEnum = z.enum(IMAGE_FORMATS);

async function annotate(name: string, data: Buffer, format: ImageFormat): Promise<WorkFile> {
  const facts = await probe(data);
  return {
    name: replaceExt(name, format),
    data,
    mime: MIME_BY_FORMAT[format],
    meta: { width: facts.width, height: facts.height, format: facts.format, hasAlpha: facts.hasAlpha },
  };
}

function replaceExt(name: string, format: ImageFormat): string {
  const ext = format === 'jpeg' ? 'jpg' : format;
  return `${name.replace(/\.[^./\\]+$/, '')}.${ext}`;
}

async function targetFormat(file: WorkFile, requested?: string): Promise<ImageFormat> {
  if (requested) {
    const parsed = formatEnum.safeParse(requested === 'jpg' ? 'jpeg' : requested);
    if (!parsed.success) throw new AppError('BAD_REQUEST', `Unsupported image format: ${requested}`);
    return parsed.data;
  }
  return formatFromMime(file.mime) ?? (await probe(file.data)).format;
}

/** Applies one transform to every input file in turn, reporting progress as it goes. */
async function mapFiles(
  input: OpInput<any>,
  fn: (file: WorkFile, index: number) => Promise<WorkFile>,
): Promise<WorkFile[]> {
  const out: WorkFile[] = [];
  for (const [i, file] of input.files.entries()) {
    input.ctx.signal.throwIfAborted();
    out.push(await fn(file, i));
    input.ctx.progress((i + 1) / input.files.length);
  }
  return out;
}

const ACCEPTS = ['image/*'];
const always = () => true;

const convert: Capability = {
  name: 'image.convert',
  domain: 'image',
  title: 'Convert image format',
  description: 'Re-encode an image as JPEG, PNG, WebP, AVIF, TIFF or GIF.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 3,
  available: always,
  paramsSchema: z.object({
    format: formatEnum,
    quality: z.number().int().min(1).max(100).optional(),
  }),
  run: (input: OpInput<{ format: ImageFormat; quality?: number }>) =>
    mapFiles(input, async (file) => {
      const format = input.params.format;
      const data = await encode(sharp(file.data, { failOn: 'none' }), {
        format,
        quality: input.params.quality ?? 85,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const resize: Capability = {
  name: 'image.resize',
  domain: 'image',
  title: 'Resize image',
  description: 'Scale an image to given dimensions, preserving aspect ratio unless told otherwise.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 3,
  available: always,
  paramsSchema: z
    .object({
      width: z.number().int().positive().max(30000).optional(),
      height: z.number().int().positive().max(30000).optional(),
      fit: z.enum(['cover', 'contain', 'fill', 'inside', 'outside']).default('inside'),
      withoutEnlargement: z.boolean().default(true),
    })
    .refine((v) => v.width !== undefined || v.height !== undefined, 'width or height is required'),
  run: (input: OpInput<{ width?: number; height?: number; fit: any; withoutEnlargement: boolean }>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file);
      const pipeline = sharp(file.data, { failOn: 'none' }).resize({
        width: input.params.width,
        height: input.params.height,
        fit: input.params.fit,
        withoutEnlargement: input.params.withoutEnlargement,
      });
      const data = await encode(pipeline, {
        format,
        quality: 90,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const compress: Capability = {
  name: 'image.compress',
  domain: 'image',
  title: 'Compress image',
  description: 'Reduce file size by re-encoding. Pair with a size constraint to hit an exact target.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 4,
  available: always,
  paramsSchema: z.object({
    quality: z.number().int().min(1).max(100).default(80),
    format: formatEnum.optional(),
  }),
  run: (input: OpInput<{ quality: number; format?: ImageFormat }>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file, input.params.format ?? input.ctx.constraints.format);
      const data = await encode(sharp(file.data, { failOn: 'none' }), {
        format,
        quality: input.params.quality,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const crop: Capability = {
  name: 'image.crop',
  domain: 'image',
  title: 'Crop image',
  description: 'Cut a rectangle out of an image, by coordinates or by gravity.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 3,
  available: always,
  paramsSchema: z.union([
    z.object({
      left: z.number().int().min(0),
      top: z.number().int().min(0),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
    z.object({
      gravity: z.enum(['centre', 'north', 'south', 'east', 'west', 'attention']).default('centre'),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ]),
  run: (input: OpInput<any>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file);
      const p = input.params;
      const pipeline =
        'left' in p
          ? sharp(file.data, { failOn: 'none' }).extract({
              left: p.left,
              top: p.top,
              width: p.width,
              height: p.height,
            })
          : sharp(file.data, { failOn: 'none' }).resize({
              width: p.width,
              height: p.height,
              fit: 'cover',
              position: p.gravity,
            });
      const data = await encode(pipeline, {
        format,
        quality: 90,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const rotate: Capability = {
  name: 'image.rotate',
  domain: 'image',
  title: 'Rotate image',
  description: 'Rotate by an angle, or auto-orient from EXIF when no angle is given.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 2,
  available: always,
  paramsSchema: z.object({
    angle: z.number().optional(),
    flip: z.boolean().default(false),
    flop: z.boolean().default(false),
  }),
  run: (input: OpInput<{ angle?: number; flip: boolean; flop: boolean }>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file);
      let pipeline = sharp(file.data, { failOn: 'none' });
      pipeline = input.params.angle === undefined ? pipeline.rotate() : pipeline.rotate(input.params.angle);
      if (input.params.flip) pipeline = pipeline.flip();
      if (input.params.flop) pipeline = pipeline.flop();
      const data = await encode(pipeline, {
        format,
        quality: 92,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const grayscale: Capability = {
  name: 'image.grayscale',
  domain: 'image',
  title: 'Convert to greyscale',
  description: 'Drop colour information.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 2,
  available: always,
  paramsSchema: z.object({}),
  run: (input: OpInput<Record<string, never>>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file);
      const data = await encode(sharp(file.data, { failOn: 'none' }).grayscale(), {
        format,
        quality: 90,
        strip: input.ctx.constraints.stripMetadata,
      }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

const stripMetadata: Capability = {
  name: 'image.strip-metadata',
  domain: 'image',
  title: 'Strip metadata',
  description: 'Remove EXIF, GPS and other embedded metadata.',
  accepts: ACCEPTS,
  produces: 'same',
  cost: 2,
  available: always,
  paramsSchema: z.object({}),
  run: (input: OpInput<Record<string, never>>) =>
    mapFiles(input, async (file) => {
      const format = await targetFormat(file);
      const data = await encode(sharp(file.data, { failOn: 'none' }), { format, quality: 95, strip: true }).toBuffer();
      return annotate(file.name, data, format);
    }),
};

/**
 * The knobs the size optimizer is allowed to turn. Quality first, dimensions
 * only when quality alone cannot reach the window.
 */
const optimizer: SizeOptimizer = {
  domain: 'image',
  supports: (file) => file.mime.startsWith('image/'),
  knobs: (file, rc) => {
    const format = formatFromMime(file.mime);
    // Lossless formats barely respond to quality, so leave it high and lean on scale.
    const lossless = format === 'png' || format === 'gif' || format === 'tiff';
    return {
      quality: { min: rc.minQuality, max: lossless ? 100 : 95 },
      scale: { min: rc.minScale, max: 1 },
    };
  },
  render: async (file, { quality, scale }, ctx) => {
    const format = await targetFormat(file, ctx.constraints.format);
    const facts = await probe(file.data);
    let pipeline = sharp(file.data, { failOn: 'none' });
    if (scale < 0.999) {
      pipeline = pipeline.resize({
        width: Math.max(1, Math.round(facts.width * scale)),
        height: Math.max(1, Math.round(facts.height * scale)),
        fit: 'fill',
      });
    }
    const data = await encode(pipeline, { format, quality, strip: true }).toBuffer();
    return annotate(file.name, data, format);
  },
};

export const imageEngine: EnginePlugin = {
  domain: 'image',
  title: 'Image engine (libvips)',
  capabilities: [convert, resize, compress, crop, rotate, grayscale, stripMetadata],
  optimizer,
};
