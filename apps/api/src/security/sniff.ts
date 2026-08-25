import { fileTypeFromBuffer } from 'file-type';
import { AppError } from '../core/errors.js';

/**
 * Types we are willing to take in. Detection is by magic bytes, never by the
 * client-supplied Content-Type or the file extension - both are attacker
 * controlled. The extension map below is only a fallback for formats that have
 * no magic number at all.
 */
const ALLOWED = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/tiff',
  'image/heif',
  'application/pdf',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'text/csv',
  'application/json',
  'application/octet-stream',
]);

const BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  svg: 'image/svg+xml',
};

export async function sniffMime(data: Buffer, filename = ''): Promise<string> {
  const detected = await fileTypeFromBuffer(data);
  if (detected) return normalise(detected.mime);

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXTENSION[ext] ?? 'application/octet-stream';
}

function normalise(mime: string): string {
  return mime === 'application/x-zip-compressed' ? 'application/zip' : mime;
}

/**
 * Gate for anything entering the system. Rejecting here means an engine never
 * sees a type it was not built for.
 */
export async function sniffAndAssert(data: Buffer, filename: string): Promise<string> {
  if (data.length === 0) throw new AppError('BAD_REQUEST', `${filename} is empty`);

  const mime = await sniffMime(data, filename);
  if (!ALLOWED.has(mime)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `${filename} is a ${mime}, which this deployment does not accept`, {
      mime,
      allowed: [...ALLOWED],
    });
  }
  if (mime === 'application/octet-stream' && !filename.includes('.')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', `Could not identify the type of ${filename}`);
  }
  return mime;
}

export const allowedTypes = (): string[] => [...ALLOWED];

/** Strips directories and anything that could confuse a filesystem or a header. */
export function safeFilename(raw: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? 'file';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned === '' ? 'file' : cleaned).slice(0, 180);
}
