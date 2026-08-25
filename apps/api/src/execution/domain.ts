/**
 * Which engine family a file belongs to. Lives on its own so the selection
 * layer and the executor can both use it without importing each other.
 */
export function domainForMime(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'archive';
  return 'unknown';
}
