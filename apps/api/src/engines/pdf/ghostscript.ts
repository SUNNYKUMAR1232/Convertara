import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBinary, run } from '../../core/bin.js';

const CANDIDATES = ['gs', 'gswin64c', 'gswin32c'];

export async function ghostscriptPath(): Promise<string | null> {
  return findBinary(CANDIDATES);
}

export async function ghostscriptAvailable(): Promise<boolean> {
  return (await ghostscriptPath()) !== null;
}

/** Maps a 1-100 quality knob onto Ghostscript's downsampling controls. */
export function qualityToRaster(quality: number): { preset: string; dpi: number; jpegQuality: number } {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const preset = q >= 85 ? '/prepress' : q >= 65 ? '/printer' : q >= 40 ? '/ebook' : '/screen';
  const dpi = Math.round(45 + (q / 100) * 255); // 45dpi at the floor, 300dpi at the ceiling
  return { preset, dpi, jpegQuality: Math.max(15, Math.min(95, q)) };
}

/**
 * Re-writes a PDF through Ghostscript, downsampling embedded raster images.
 * This is the only meaningful lever on PDF size; without Ghostscript installed
 * the engine advertises `pdf.compress` as unavailable rather than pretending.
 */
export async function compressPdf(data: Buffer, quality: number, signal?: AbortSignal): Promise<Buffer> {
  const bin = await ghostscriptPath();
  if (!bin) throw new Error('Ghostscript is not installed');

  const { preset, dpi, jpegQuality } = qualityToRaster(quality);
  const dir = await mkdtemp(join(tmpdir(), 'convertara-gs-'));
  const input = join(dir, 'in.pdf');
  const output = join(dir, 'out.pdf');

  try {
    await writeFile(input, data);
    await run(
      bin,
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.7',
        `-dPDFSETTINGS=${preset}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        '-dSAFER',
        '-dDetectDuplicateImages=true',
        '-dCompressFonts=true',
        '-dSubsetFonts=true',
        '-dDownsampleColorImages=true',
        '-dDownsampleGrayImages=true',
        '-dDownsampleMonoImages=true',
        `-dColorImageResolution=${dpi}`,
        `-dGrayImageResolution=${dpi}`,
        `-dMonoImageResolution=${Math.max(dpi, 150)}`,
        '-dAutoFilterColorImages=false',
        '-dColorImageFilter=/DCTEncode',
        `-dJPEGQ=${jpegQuality}`,
        `-sOutputFile=${output}`,
        input,
      ],
      { timeoutMs: 120_000, signal },
    );
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
