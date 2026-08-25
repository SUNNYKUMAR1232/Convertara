import { AppError } from '../../core/errors.js';

/**
 * Parses a human page selection ("1-3, 5, 9-") into zero-based indices.
 * Ranges are inclusive and 1-based on the way in, because that is how people
 * and every PDF viewer count pages.
 */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'all') {
    return Array.from({ length: pageCount }, (_, i) => i);
  }

  const selected = new Set<number>();
  for (const part of trimmed.split(',')) {
    const piece = part.trim();
    if (piece === '') continue;

    const range = /^(\d+)?\s*-\s*(\d+)?$/.exec(piece);
    if (range) {
      const start = range[1] ? Number(range[1]) : 1;
      const end = range[2] ? Number(range[2]) : pageCount;
      if (start < 1 || end > pageCount || start > end) {
        throw new AppError('BAD_REQUEST', `Page range "${piece}" is outside 1-${pageCount}`);
      }
      for (let p = start; p <= end; p += 1) selected.add(p - 1);
      continue;
    }

    const single = Number(piece);
    if (!Number.isInteger(single) || single < 1 || single > pageCount) {
      throw new AppError('BAD_REQUEST', `Page "${piece}" is outside 1-${pageCount}`);
    }
    selected.add(single - 1);
  }

  if (selected.size === 0) throw new AppError('BAD_REQUEST', `No pages selected by "${spec}"`);
  return [...selected].sort((a, b) => a - b);
}
