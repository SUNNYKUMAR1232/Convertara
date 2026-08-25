import { AppError } from '../core/errors.js';
import { formatBytes } from '../core/units.js';

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  /** Reject when uncompressed/compressed exceeds this, i.e. a zip bomb. */
  maxRatio: number;
}

export interface EntryInfo {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Rejects an entry name that would escape the extraction root: absolute paths,
 * Windows drive letters, UNC paths, `..` segments, and NUL bytes. Returns the
 * safe relative path to use instead.
 */
export function safeEntryName(rawName: string): string {
  const name = rawName.replace(/\\/g, '/');

  if (name.includes('\0')) throw new AppError('SECURITY_REJECTED', 'Archive entry name contains a null byte');
  if (name.startsWith('/') || name.startsWith('//')) {
    throw new AppError('SECURITY_REJECTED', `Archive entry uses an absolute path: ${rawName}`);
  }
  if (/^[a-zA-Z]:/.test(name)) {
    throw new AppError('SECURITY_REJECTED', `Archive entry uses a drive letter: ${rawName}`);
  }

  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new AppError('SECURITY_REJECTED', `Archive entry escapes the extraction root: ${rawName}`);
  }
  if (parts.length === 0) throw new AppError('SECURITY_REJECTED', `Archive entry has an empty name`);

  return parts.join('/');
}

/** Running tally across one extraction, so limits apply to the archive as a whole. */
export class ExtractionBudget {
  private entries = 0;
  private totalBytes = 0;

  constructor(private readonly limits: ArchiveLimits) {}

  /** Called before an entry is decompressed. Throws to abort the extraction. */
  admit(info: EntryInfo): string {
    const name = safeEntryName(info.name);

    this.entries += 1;
    if (this.entries > this.limits.maxEntries) {
      throw new AppError('SECURITY_REJECTED', `Archive has more than ${this.limits.maxEntries} entries`);
    }

    this.totalBytes += info.uncompressedSize;
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new AppError(
        'SECURITY_REJECTED',
        `Archive expands to more than ${formatBytes(this.limits.maxTotalBytes)}`,
      );
    }

    if (info.compressedSize > 0) {
      const ratio = info.uncompressedSize / info.compressedSize;
      if (ratio > this.limits.maxRatio) {
        throw new AppError(
          'SECURITY_REJECTED',
          `Archive entry "${info.name}" expands ${Math.round(ratio)}x, above the ${this.limits.maxRatio}x limit`,
        );
      }
    }

    return name;
  }

  get stats() {
    return { entries: this.entries, totalBytes: this.totalBytes };
  }
}
