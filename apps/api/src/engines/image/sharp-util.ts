import sharp from 'sharp';
import { AppError } from '../../core/errors.js';

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  gif: 'image/gif',
};

export const LOSSY: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['jpeg', 'webp', 'avif']);

export function formatFromMime(mime: string): ImageFormat | undefined {
  const found = (Object.keys(MIME_BY_FORMAT) as ImageFormat[]).find((f) => MIME_BY_FORMAT[f] === mime);
  return found;
}

export interface ImageFacts {
  width: number;
  height: number;
  format: ImageFormat;
  hasAlpha: boolean;
  pages: number;
}

export async function probe(data: Buffer): Promise<ImageFacts> {
  const meta = await sharp(data, { failOn: 'none' }).metadata();
  const format = (meta.format ?? '') as ImageFormat;
  if (!IMAGE_FORMATS.includes(format)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Unsupported image format: ${meta.format ?? 'unknown'}`);
  }
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format,
    hasAlpha: Boolean(meta.hasAlpha),
    pages: meta.pages ?? 1,
  };
}

export interface EncodeOptions {
  format: ImageFormat;
  /** 1-100. Ignored by formats without a quality knob. */
  quality?: number;
  /** Keep EXIF/ICC when false. */
  strip?: boolean;
  /** Higher effort = smaller file, slower. Kept low for latency. */
  effort?: number;
}

export function encode(pipeline: sharp.Sharp, options: EncodeOptions): sharp.Sharp {
  const q = Math.min(100, Math.max(1, Math.round(options.quality ?? 80)));
  const p = options.strip === false ? pipeline.withMetadata() : pipeline;

  switch (options.format) {
    case 'jpeg':
      return p.jpeg({ quality: q, mozjpeg: true, progressive: true });
    case 'webp':
      return p.webp({ quality: q, effort: options.effort ?? 4 });
    case 'avif':
      return p.avif({ quality: q, effort: options.effort ?? 3 });
    case 'tiff':
      return p.tiff({ quality: q, compression: 'jpeg' });
    case 'gif':
      return p.gif();
    case 'png':
      // PNG is lossless: the only real size knob is palette quantisation.
      return q >= 95
        ? p.png({ compressionLevel: 9, effort: 7 })
        : p.png({ compressionLevel: 9, effort: 7, palette: true, quality: q, colours: paletteColours(q) });
    default: {
      const never: never = options.format;
      throw new AppError('BAD_REQUEST', `Unsupported target format: ${String(never)}`);
    }
  }
}

function paletteColours(quality: number): number {
  // 1 -> 8 colours, 100 -> 256 colours.
  return Math.max(8, Math.min(256, Math.round((quality / 100) * 256)));
}

/** libvips keeps a warm thread pool; cap it so one request cannot eat the box. */
export function configureSharp(concurrency: number): void {
  sharp.concurrency(concurrency);
  sharp.cache({ memory: 128, files: 0, items: 64 });
}

export { sharp };
