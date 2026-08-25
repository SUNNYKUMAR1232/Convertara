export type Anchor =
  | 'center'
  | 'north'
  | 'south'
  | 'east'
  | 'west'
  | 'northeast'
  | 'northwest'
  | 'southeast'
  | 'southwest';

export interface WatermarkOptions {
  text: string;
  anchor: Anchor;
  /** 0-1. */
  opacity: number;
  /** Cap height as a fraction of the image's shorter side. */
  scale: number;
  color: string;
  rotate: number;
  /** Repeat diagonally across the whole image instead of placing once. */
  tile: boolean;
  margin: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Builds the watermark as an SVG layer to composite over the image.
 *
 * SVG rather than a canvas because sharp can rasterise it at exactly the output
 * resolution, so the text stays crisp on a 6000px photo and on a thumbnail
 * without two code paths. The dark halo under the fill is what keeps a light
 * watermark readable over a light photo - without it a watermark disappears on
 * exactly the images people most want to mark.
 */
export function watermarkSvg(width: number, height: number, options: WatermarkOptions): Buffer {
  const fontSize = Math.max(10, Math.round(Math.min(width, height) * options.scale));
  const text = escapeXml(options.text);
  const opacity = Math.max(0.02, Math.min(1, options.opacity));

  const body = options.tile
    ? tiled(width, height, fontSize, text, options)
    : single(width, height, fontSize, text, options);

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .wm {
        font-family: -apple-system, "Segoe UI", Roboto, "DejaVu Sans", "Liberation Sans", sans-serif;
        font-size: ${fontSize}px;
        font-weight: 700;
        fill: ${escapeXml(options.color)};
        fill-opacity: ${opacity};
        stroke: rgba(0,0,0,0.45);
        stroke-width: ${Math.max(1, fontSize * 0.02)};
        paint-order: stroke fill;
      }
    </style>
  </defs>
  ${body}
</svg>`,
    'utf8',
  );
}

function single(width: number, height: number, fontSize: number, text: string, options: WatermarkOptions): string {
  const { x, y, anchor, baseline } = place(width, height, fontSize, options);
  const rotation = options.rotate === 0 ? '' : ` transform="rotate(${options.rotate} ${x} ${y})"`;
  return `<text class="wm" x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${baseline}"${rotation}>${text}</text>`;
}

function tiled(width: number, height: number, fontSize: number, text: string, options: WatermarkOptions): string {
  // Rough advance width - good enough for spacing, and avoids needing font
  // metrics we cannot measure before rasterising.
  const stepX = Math.max(fontSize * 4, text.length * fontSize * 0.62 + fontSize * 2);
  const stepY = fontSize * 3.2;
  const rows: string[] = [];

  for (let y = -height; y < height * 2; y += stepY) {
    for (let x = -width; x < width * 2; x += stepX) {
      rows.push(`<text class="wm" x="${Math.round(x)}" y="${Math.round(y)}" text-anchor="start">${text}</text>`);
    }
  }

  const angle = options.rotate === 0 ? -30 : options.rotate;
  return `<g transform="rotate(${angle} ${width / 2} ${height / 2})">${rows.join('')}</g>`;
}

function place(
  width: number,
  height: number,
  fontSize: number,
  options: WatermarkOptions,
): { x: number; y: number; anchor: string; baseline: string } {
  const margin = Math.round(options.margin);
  const north = options.anchor.includes('north');
  const south = options.anchor.includes('south');
  const east = options.anchor.includes('east');
  const west = options.anchor.includes('west');

  const x = east ? width - margin : west ? margin : width / 2;
  const y = north ? margin + fontSize * 0.1 : south ? height - margin : height / 2;

  return {
    x: Math.round(x),
    y: Math.round(y),
    anchor: east ? 'end' : west ? 'start' : 'middle',
    baseline: north ? 'hanging' : south ? 'auto' : 'middle',
  };
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}
