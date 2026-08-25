export const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;
export type ByteUnit = (typeof BYTE_UNITS)[number];

const MULT: Record<ByteUnit, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

export function toBytes(value: number, unit: ByteUnit): number {
  return Math.round(value * MULT[unit]);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units: ByteUnit[] = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** Normalises "300kb", "1.5 MB", "300 kilobytes", "2mb" -> bytes. */
export function parseSize(input: string): number | undefined {
  const m = /(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|kib|mib|gib|bytes?|kilobytes?|megabytes?|gigabytes?)\b/i.exec(input);
  if (!m) return undefined;
  const value = Number(m[1]);
  const raw = (m[2] ?? 'b').toLowerCase();
  const unit: ByteUnit = raw.startsWith('g') ? 'GB' : raw.startsWith('m') ? 'MB' : raw.startsWith('k') ? 'KB' : 'B';
  return toBytes(value, unit);
}

/** Extracts "±5%", "within 5 percent", "5% tolerance" -> 0.05 */
export function parseTolerance(input: string): number | undefined {
  const m = /(?:±|\+\/-|\+-|within|tolerance\s+of|plus or minus)\s*(\d+(?:\.\d+)?)\s*%/i.exec(input);
  if (!m) return undefined;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return undefined;
  return pct / 100;
}
