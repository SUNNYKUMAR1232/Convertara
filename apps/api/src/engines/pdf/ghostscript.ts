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

/**
 * Maps a 1-100 quality knob onto Ghostscript's downsampling controls.
 *
 * `pinnedPreset` exists for the size optimizer. Letting the preset change
 * mid-search puts a cliff in the middle of the curve - measured on a 2.7MB
 * scan, q=30 gave 284KB and q=40 gave 2.69MB - and a binary search cannot
 * converge across a discontinuity like that. A caller that names an explicit
 * quality still gets the full preset ladder.
 */
export function qualityToRaster(
  quality: number,
  pinnedPreset?: string,
): { preset: string; dpi: number; jpegQuality: number } {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const preset = pinnedPreset ?? (q >= 85 ? '/prepress' : q >= 65 ? '/printer' : q >= 40 ? '/ebook' : '/screen');
  const dpi = Math.round(45 + (q / 100) * 255); // 45dpi at the floor, 300dpi at the ceiling
  return { preset, dpi, jpegQuality: Math.max(15, Math.min(95, q)) };
}

/** The preset the optimizer holds fixed while it varies resolution. */
export const OPTIMIZER_PRESET = '/ebook';

/**
 * Re-writes a PDF through Ghostscript, downsampling embedded raster images.
 * This is the only meaningful lever on PDF size; without Ghostscript installed
 * the engine advertises `pdf.compress` as unavailable rather than pretending.
 */
export async function compressPdf(
  data: Buffer,
  quality: number,
  signal?: AbortSignal,
  pinnedPreset?: string,
): Promise<Buffer> {
  const bin = await ghostscriptPath();
  if (!bin) throw new Error('Ghostscript is not installed');

  const { preset, dpi, jpegQuality } = qualityToRaster(quality, pinnedPreset);
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
        // Ghostscript's default is to downsample only when the source exceeds
        // the target by 1.5x, so a 192dpi image asked for 147dpi is left alone
        // and the file snaps back to full size. At 1.0 the requested resolution
        // is honoured whenever it is actually lower, which is the whole point
        // of asking to compress. Measured: this moved the reachable ceiling on
        // one scan from ~309KB to ~624KB.
        '-dColorImageDownsampleThreshold=1.0',
        '-dGrayImageDownsampleThreshold=1.0',
        '-dMonoImageDownsampleThreshold=1.0',
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
