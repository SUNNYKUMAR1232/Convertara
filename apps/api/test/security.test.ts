import { describe, expect, it } from 'vitest';
import { ExtractionBudget, safeEntryName } from '../src/security/archive-guard.js';
import { safeFilename } from '../src/security/sniff.js';
import { parsePageRange } from '../src/engines/pdf/pages.js';

const limits = { maxEntries: 10, maxTotalBytes: 1_000_000, maxRatio: 100 };

describe('archive entry names', () => {
  it.each([
    '../../etc/passwd',
    '/etc/passwd',
    'C:\\Windows\\system32\\cmd.exe',
    'nested/../../escape.txt',
    '..\\..\\windows\\evil.dll',
  ])('rejects %s', (name) => {
    expect(() => safeEntryName(name)).toThrow();
  });

  it('keeps a legitimate nested path', () => {
    expect(safeEntryName('images/logo.png')).toBe('images/logo.png');
    expect(safeEntryName('.\\images\\logo.png')).toBe('images/logo.png');
  });
});

describe('extraction budget', () => {
  it('rejects an entry that expands beyond the ratio limit', () => {
    const budget = new ExtractionBudget(limits);
    expect(() => budget.admit({ name: 'bomb.txt', compressedSize: 1000, uncompressedSize: 500_000 })).toThrow(
      /expands/,
    );
  });

  it('rejects an archive with too many entries', () => {
    const budget = new ExtractionBudget(limits);
    for (let i = 0; i < 10; i += 1) {
      budget.admit({ name: `f${i}.txt`, compressedSize: 10, uncompressedSize: 100 });
    }
    expect(() => budget.admit({ name: 'f10.txt', compressedSize: 10, uncompressedSize: 100 })).toThrow(/entries/);
  });

  it('rejects an archive whose total expansion is too large', () => {
    const budget = new ExtractionBudget({ ...limits, maxRatio: 10_000 });
    expect(() => {
      budget.admit({ name: 'a', compressedSize: 1000, uncompressedSize: 900_000 });
      budget.admit({ name: 'b', compressedSize: 1000, uncompressedSize: 900_000 });
    }).toThrow(/expands to more than/);
  });

  it('allows an ordinary archive through', () => {
    const budget = new ExtractionBudget(limits);
    budget.admit({ name: 'doc.pdf', compressedSize: 5000, uncompressedSize: 12_000 });
    expect(budget.stats).toEqual({ entries: 1, totalBytes: 12_000 });
  });
});

describe('upload filenames', () => {
  it('strips directories and control characters', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\temp\\report.pdf')).toBe('report.pdf');
    expect(safeFilename('.hidden')).toBe('hidden');
    expect(safeFilename('')).toBe('file');
  });
});

describe('page ranges', () => {
  it('parses selections into zero-based indices', () => {
    expect(parsePageRange('1-3', 10)).toEqual([0, 1, 2]);
    expect(parsePageRange('1,3,5', 10)).toEqual([0, 2, 4]);
    expect(parsePageRange('8-', 10)).toEqual([7, 8, 9]);
    expect(parsePageRange('all', 3)).toEqual([0, 1, 2]);
  });

  it('rejects a selection outside the document', () => {
    expect(() => parsePageRange('1-99', 10)).toThrow();
    expect(() => parsePageRange('0', 10)).toThrow();
  });
});
