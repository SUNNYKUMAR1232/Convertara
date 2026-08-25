import { sharp } from './sharp-util.js';

export interface RemoveOptions {
  /** 0-100. How different from a background colour a pixel may be. */
  tolerance: number;
  /** Soften the cut edge by this many pixels. */
  feather: number;
  /** Chroma-key against this colour instead of sampling the border. */
  color?: { r: number; g: number; b: number } | undefined;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface RemoveResult {
  data: Buffer;
  width: number;
  height: number;
  /** Share of pixels made transparent - a sanity signal for the caller. */
  removed: number;
  /**
   * Share of the cut that sits on a boundary. A clean cut-out has a boundary
   * proportional to the subject's outline; a wandering fill leaves speckle, and
   * its boundary is proportional to its area instead. This is what separates
   * "removed 60% correctly" from "removed 60% of the wrong pixels".
   */
  speckle: number;
  /** Every background colour found around the border. */
  backgrounds: Rgb[];
  /** Kept for callers that only care about the dominant one. */
  background: Rgb;
}

/** At most this many distinct background colours. Beyond it, everything matches. */
const MAX_CLUSTERS = 4;

/**
 * Background removal by flood fill from the edges.
 *
 * Two things make this work on real images rather than only on studio cut-outs.
 *
 * A border is sampled into several colours, not one. A single median across the
 * whole border is the obvious approach and it fails badly on anything with two
 * backgrounds - a photo with a dark blurred top and a white bottom gives a
 * median that matches neither, and measured on exactly that image it removed
 * the white half and left the dark half untouched at every tolerance.
 *
 * And the flood walks gradients. A pixel is also accepted when it is very close
 * to the neighbour that reached it, which lets the fill follow a blur or a
 * vignette - with a hard cap on how far it may drift from a sampled colour, so
 * it cannot wander through a soft edge and eat the subject.
 *
 * It still does not do hair against a hedge. Where subject and background share
 * colours, no flood fill will help and the caller is told how much was removed
 * so it can say so.
 */
export async function removeBackground(input: Buffer, options: RemoveOptions): Promise<RemoveResult> {
  const { data, info } = await sharp(input, { failOn: 'none' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);

  const backgrounds = options.color ? [options.color] : sampleBorder(pixels, width, height);

  // Tolerance is a share of the maximum possible RGB distance, squared so the
  // inner loop never needs a square root.
  const limit = ((options.tolerance / 100) * 441.67) ** 2;
  // Following a gradient has to be stricter than matching a sampled colour, or
  // the fill walks straight through an anti-aliased edge into the subject.
  const stepLimit = limit * 0.15;
  // ...and even a long series of small steps may not stray far from a real
  // background colour. Measured: at 6x the fill drifted from a dark blurred
  // backdrop into a dark subject and removed the entire image.
  const driftLimit = limit * 2;

  const transparent = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  let drifted = 0;
  let allowDrift = true;

  const nearest = (offset: number): number => {
    const r = pixels[offset]!;
    const g = pixels[offset + 1]!;
    const b = pixels[offset + 2]!;
    let best = Number.POSITIVE_INFINITY;
    for (const background of backgrounds) {
      const distance = squared(r, g, b, background);
      if (distance < best) best = distance;
    }
    return best;
  };

  /** `from` is the pixel that reached this one, or -1 for a border seed. */
  const consider = (index: number, from: number): void => {
    if (transparent[index] === 1) return;

    const offset = index * 4;
    const toBackground = nearest(offset);

    if (toBackground > limit) {
      // Not a background colour outright - but it may be one step along a
      // gradient that started at one.
      if (!allowDrift || from < 0 || toBackground > driftLimit) return;
      const previous = from * 4;
      const step = squared(pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, {
        r: pixels[previous]!,
        g: pixels[previous + 1]!,
        b: pixels[previous + 2]!,
      });
      if (step > stepLimit) return;
      drifted += 1;
    }

    transparent[index] = 1;
    stack[top++] = index;
  };

  const flood = (): number => {
    for (let x = 0; x < width; x += 1) {
      consider(x, -1);
      consider((height - 1) * width + x, -1);
    }
    for (let y = 0; y < height; y += 1) {
      consider(y * width, -1);
      consider(y * width + width - 1, -1);
    }

    let count = 0;
    while (top > 0) {
      const index = stack[--top]!;
      count += 1;

      const x = index % width;
      const y = (index - x) / width;

      if (x > 0) consider(index - 1, index);
      if (x < width - 1) consider(index + 1, index);
      if (y > 0) consider(index - width, index);
      if (y < height - 1) consider(index + width, index);
    }
    return count;
  };

  // Seeds are the border pixels: a background that touches an edge is a
  // background, and one that does not is a hole the subject encloses.
  let removed = flood();

  /**
   * On a real gradient most of the fill still matches a sampled colour outright
   * and only the transition band drifts. When most of it drifted instead, the
   * fill was not following a gradient - it was wandering through noise, which
   * is how a busy photo lost 62% of itself to a background it does not have.
   * Redo it without the gradient step.
   */
  if (removed > 0 && drifted / removed > 0.35) {
    allowDrift = false;
    transparent.fill(0);
    top = 0;
    drifted = 0;
    removed = flood();
  }

  const speckle = removed > 0 ? boundaryShare(transparent, width, height) / removed : 0;
  applyAlpha(pixels, transparent, width, height, options.feather);

  return {
    data: Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length),
    width,
    height,
    removed: removed / (width * height),
    speckle,
    backgrounds,
    background: backgrounds[0] ?? { r: 255, g: 255, b: 255 },
  };
}

/** How many cut pixels touch an uncut one - the length of the cut's outline. */
function boundaryShare(transparent: Uint8Array, width: number, height: number): number {
  let boundary = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (transparent[index] !== 1) continue;

      const touchesKept =
        (x > 0 && transparent[index - 1] === 0) ||
        (x < width - 1 && transparent[index + 1] === 0) ||
        (y > 0 && transparent[index - width] === 0) ||
        (y < height - 1 && transparent[index + width] === 0);

      if (touchesKept) boundary += 1;
    }
  }
  return boundary;
}

/**
 * Groups the border into up to `MAX_CLUSTERS` colours, ordered by how much of
 * the border each covers. Greedy rather than k-means: a border is a few hundred
 * to a few thousand pixels of mostly one or two colours, and this converges in
 * one pass instead of many.
 */
function sampleBorder(pixels: Uint8ClampedArray, width: number, height: number): Rgb[] {
  const samples: Rgb[] = [];

  const push = (index: number): void => {
    const offset = index * 4;
    samples.push({ r: pixels[offset]!, g: pixels[offset + 1]!, b: pixels[offset + 2]! });
  };

  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }

  // Two colours count as the same background if they are within this distance.
  const merge = (60 * 60) * 3;
  const clusters: Array<{ sum: Rgb; count: number }> = [];

  for (const sample of samples) {
    let matched = false;
    for (const cluster of clusters) {
      const centre = {
        r: cluster.sum.r / cluster.count,
        g: cluster.sum.g / cluster.count,
        b: cluster.sum.b / cluster.count,
      };
      if (squared(sample.r, sample.g, sample.b, centre) <= merge) {
        cluster.sum.r += sample.r;
        cluster.sum.g += sample.g;
        cluster.sum.b += sample.b;
        cluster.count += 1;
        matched = true;
        break;
      }
    }
    if (!matched) clusters.push({ sum: { ...sample }, count: 1 });
  }

  return clusters
    .sort((a, b) => b.count - a.count)
    // A cluster that is a sliver of the border is part of the subject touching
    // the edge, not a background.
    .filter((cluster, index) => index === 0 || cluster.count / samples.length >= 0.04)
    .slice(0, MAX_CLUSTERS)
    .map((cluster) => ({
      r: Math.round(cluster.sum.r / cluster.count),
      g: Math.round(cluster.sum.g / cluster.count),
      b: Math.round(cluster.sum.b / cluster.count),
    }));
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
    if (transparent[index] === 1) pixels[index * 4 + 3] = 0;
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

function squared(r: number, g: number, b: number, to: Rgb): number {
  const dr = r - to.r;
  const dg = g - to.g;
  const db = b - to.b;
  return dr * dr + dg * dg + db * db;
}
