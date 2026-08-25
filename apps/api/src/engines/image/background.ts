import { sharp } from './sharp-util.js';

export interface RemoveOptions {
  /** 0-100. How different from the sampled background a pixel may be. */
  tolerance: number;
  /** Soften the cut edge by this many pixels. */
  feather: number;
  /** Chroma-key against this colour instead of sampling the border. */
  color?: { r: number; g: number; b: number } | undefined;
}

export interface RemoveResult {
  data: Buffer;
  width: number;
  height: number;
  /** Share of pixels made transparent - a sanity signal for the caller. */
  removed: number;
  background: { r: number; g: number; b: number };
}

/**
 * Background removal by flood fill from the edges.
 *
 * This is the honest, offline version: it finds the colour around the border,
 * floods inwards while pixels stay within tolerance, and cuts what it reaches.
 * That covers the cases people mostly want - logos, icons, screenshots, product
 * shots on a studio backdrop - and it is deterministic, instant, and needs no
 * model to download.
 *
 * It does not do hair against a hedge. Anything where the subject and the
 * background share colours needs a segmentation model, and the caller is told
 * which method ran so it can say so rather than quietly returning a bad cut.
 */
export async function removeBackground(input: Buffer, options: RemoveOptions): Promise<RemoveResult> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);

  const background = options.color ?? sampleBorder(pixels, width, height);
  // Tolerance is a percentage of the maximum possible RGB distance, squared so
  // the inner loop never needs a square root.
  const limit = ((options.tolerance / 100) * 441.67) ** 2;

  const transparent = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;

  const consider = (index: number): void => {
    if (transparent[index] === 1) return;
    const offset = index * 4;
    if (distanceSquared(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, background) > limit) return;
    transparent[index] = 1;
    stack[top++] = index;
  };

  // Seed from every border pixel: a background that touches an edge is a
  // background, and one that does not is a hole the subject encloses.
  for (let x = 0; x < width; x += 1) {
    consider(x);
    consider((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    consider(y * width);
    consider(y * width + width - 1);
  }

  let removed = 0;
  while (top > 0) {
    const index = stack[--top]!;
    removed += 1;

    const x = index % width;
    const y = (index - x) / width;

    if (x > 0) consider(index - 1);
    if (x < width - 1) consider(index + 1);
    if (y > 0) consider(index - width);
    if (y < height - 1) consider(index + width);
  }

  applyAlpha(pixels, transparent, width, height, options.feather);

  return {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length),
    width,
    height,
    removed: removed / (width * height),
    background,
  };
}

/**
 * The median border colour, not the mean: a mean is dragged off by any part of
 * the subject that touches the edge, and lands on a colour present nowhere in
 * the image.
 */
function sampleBorder(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];

  const push = (index: number): void => {
    const offset = index * 4;
    reds.push(pixels[offset]!);
    greens.push(pixels[offset + 1]!);
    blues.push(pixels[offset + 2]!);
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  return { r: median(reds), g: median(greens), b: median(blues) };
}

function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? 0;
}

/**
 * Writes the alpha channel, softening the boundary. A hard cut leaves a jagged
 * fringe of background-coloured pixels, which is the tell that something was
 * cut out badly.
 */
function applyAlpha(
  pixels: Uint8ClampedArray,
  transparent: Uint8Array,
  width: number,
  height: number,
  feather: number,
): void {
  for (let index = 0; index < transparent.length; index += 1) {
    if (transparent[index] === 1) {
      pixels[index * 4 + 3] = 0;
    }
  }

  if (feather <= 0) return;

  for (let pass = 0; pass < feather; pass += 1) {
    const softened: Array<[number, number]> = [];

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (transparent[index] === 1) continue;

        const alpha = pixels[index * 4 + 3]!;
        if (alpha === 0) continue;

        let clear = 0;
        if (x > 0 && pixels[(index - 1) * 4 + 3] === 0) clear += 1;
        if (x < width - 1 && pixels[(index + 1) * 4 + 3] === 0) clear += 1;
        if (y > 0 && pixels[(index - width) * 4 + 3] === 0) clear += 1;
        if (y < height - 1 && pixels[(index + width) * 4 + 3] === 0) clear += 1;

        if (clear > 0) softened.push([index, Math.round(alpha * (1 - clear / 6))]);
      }
    }

    for (const [index, alpha] of softened) pixels[index * 4 + 3] = alpha;
  }
}

function distanceSquared(r: number, g: number, b: number, to: { r: number; g: number; b: number }): number {
  const dr = r - to.r;
  const dg = g - to.g;
  const db = b - to.b;
  return dr * dr + dg * dg + db * db;
}
