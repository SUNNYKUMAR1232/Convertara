import type { Constraints, Operation, Plan } from '../core/plan.js';
import { planSchema } from '../core/plan.js';
import type { Selector } from '../core/plan.js';
import { parseSize, parseTolerance } from '../core/units.js';
import type { WorkFile } from '../router/types.js';
import { domainForMime } from '../execution/executor.js';

/**
 * Rule-based planner. Most traffic is "convert this to webp" or "get it under
 * 300KB", and none of that needs a language model - it needs a regex and a
 * lookup table. Anything this file cannot parse with confidence returns
 * undefined and the request falls through to the LLM path.
 */

const FORMAT_WORDS: Record<string, string> = {
  webp: 'webp',
  jpg: 'jpeg',
  jpeg: 'jpeg',
  png: 'png',
  avif: 'avif',
  tiff: 'tiff',
  tif: 'tiff',
  gif: 'gif',
  pdf: 'pdf',
  zip: 'zip',
};

/** Words that carry no instruction, so leaving them unmatched proves nothing. */
const FILLER = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'my', 'our', 'your',
  'please', 'can', 'you', 'could', 'would', 'to', 'into', 'as', 'in', 'at', 'of', 'for',
  'and', 'then', 'with', 'without', 'file', 'files', 'image', 'images', 'photo', 'photos',
  'picture', 'pictures', 'document', 'documents', 'doc', 'docs', 'page', 'pages',
  'set', 'be', 'is', 'are', 'me', 'i', 'want', 'need',
  'size', 'quality', 'aspect', 'ratio', 'each', 'all', 'them', 'one', 'single', 'same',
  'exactly', 'about', 'around', 'approximately', 'under', 'below', 'over', 'max', 'maximum',
  'least', 'most', 'per', 'from', 'out', 'up', 'down', 'on', 'off', 'new', 'copy',
  // Conversational connectives. A one-shot prompt box never sees these, but a
  // chat thread is full of them - "now convert it to png", "also make it
  // smaller" - and treating them as unrecognised sends an easy turn to a model.
  'now', 'next', 'also', 'instead', 'again', 'just', 'actually', 'ok', 'okay',
  'but', 'so', 'still', 'too', 'as well', 'lets', "let's", 'go', 'ahead', 'sure',
  'yes', 'no', 'thanks', 'thank',
  // Format nouns: naming the thing you are holding is not an instruction.
  //
  // INVARIANT: nothing in this set may also be a word a matcher below treats as
  // an operation. A word that is in both gets silently absorbed when its matcher
  // does not fire, and the result is a dropped instruction with a plausible
  // looking file attached - the one failure mode worth more than the latency the
  // fast path saves. `zip` and `archive` live in OPERATION_WORDS for that reason.
  // Enforced by a test.
  'pdf', 'pdfs', 'jpg', 'jpgs', 'jpeg', 'jpegs', 'png', 'pngs', 'webp', 'avif', 'tiff',
  'tif', 'gifs', 'pic', 'pics', 'img', 'imgs',
]);

/**
 * Every word that can trigger an operation. Exported so a test can assert it
 * never intersects FILLER.
 */
export const OPERATION_WORDS: readonly string[] = [
  'convert', 'change', 'turn', 'save', 'export', 'compress', 'shrink', 'reduce', 'smaller',
  'optimize', 'optimise', 'merge', 'combine', 'join', 'concat', 'concatenate', 'extract',
  'keep', 'take', 'only', 'split', 'rotate', 'flip', 'flop', 'greyscale', 'grayscale',
  'monochrome', 'strip', 'remove', 'clear', 'delete', 'zip', 'unzip', 'archive', 'bundle',
  'package', 'unpack', 'decompress', 'resize', 'scale', 'resample', 'crop', 'metadata', 'exif',
];

/** Words that signal judgement rather than instruction - hand those to the model. */
const VAGUE = /\b(best|better|nice|good|suitable|appropriate|optimi[sz]e for|looks?|seem|maybe|probably|sensible|reasonable|professional|web[- ]ready|social|instagram|print|email|whatever|smart|automatically|decide|figure out|you think|recommend)\b/i;

interface Draft {
  operations: Operation[];
  constraints: Partial<Constraints>;
  select?: Selector;
  bundle?: 'auto' | 'single' | 'zip';
}

export interface FastPathResult {
  plan: Plan;
  reason: string;
}

export function planFromRules(prompt: string, files: WorkFile[]): FastPathResult | undefined {
  const text = prompt.trim();
  if (text === '' || text.length > 200) return undefined;
  if (VAGUE.test(text)) return undefined;

  const lower = text.toLowerCase();

  const draft: Draft = { operations: [], constraints: {} };
  const consumed: Array<[number, number]> = [];

  const take = (re: RegExp): RegExpExecArray | undefined => {
    const match = re.exec(lower);
    if (!match) return undefined;
    consumed.push([match.index, match.index + match[0].length]);
    return match;
  };

  // Selection first, because it decides which domain the rest of the rules are
  // reasoning about. On a mixed batch "merge the PDFs" has to see `pdf`, not
  // `mixed`, or it gives up and pays for a model to state the obvious.
  const selector = parseSelector(lower, take);
  if (selector) draft.select = selector;

  const selected = applySelector(files, selector);
  const domains = new Set(selected.map((f) => domainForMime(f.mime)));
  const domain = domains.size === 1 ? [...domains][0] : 'mixed';

  // --- constraints -----------------------------------------------------------
  const sizeMatch = /(?:under|below|less than|at most|no more than|max(?:imum)?(?: of)?|to|be|around|about|approximately|~)?\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|kib|mib|kilobytes?|megabytes?)\b/i.exec(lower);
  if (sizeMatch) {
    consumed.push([sizeMatch.index, sizeMatch.index + sizeMatch[0].length]);
    const bytes = parseSize(sizeMatch[0]);
    if (bytes !== undefined) {
      const ceiling = /\b(under|below|less than|at most|no more than|max(?:imum)?)\b/i.test(sizeMatch[0]);
      const tolerance = parseTolerance(lower);
      if (tolerance !== undefined) {
        const t = /(?:±|\+\/-|\+-|within|tolerance\s+of|plus or minus)\s*\d+(?:\.\d+)?\s*%/i.exec(lower);
        if (t) consumed.push([t.index, t.index + t[0].length]);
      }
      draft.constraints.size = {
        target: bytes / 1024,
        unit: 'KB',
        tolerance: tolerance ?? (ceiling ? 0 : 0.05),
        mode: ceiling ? 'max' : 'target',
      };
      // "make it 300kb", "get this under 2MB" - the verb belongs to the size
      // phrase here, so consume it rather than leaving it to look unhandled.
      take(/\b(?:make|get|bring)\b/);
    }
  }

  // The verb and its numbers are consumed separately, so "resize to 1200x800"
  // leaves nothing behind for the coverage check to trip over.
  take(/\b(?:resiz(?:e|ing|ed)|scale[ds]?|resample|dimensions?)\b/);
  const dims = take(/\b(\d{2,5})\s*(?:x|by|×)\s*(\d{2,5})\b/);
  const widthOnly = dims ? undefined : take(/\b(?:width|wide)\s*(?:of|to|=|:)?\s*(\d{2,5})\s*(?:px|pixels)?\b/);
  const maxDim = dims || widthOnly ? undefined : take(/\b(?:max(?:imum)?|no more than|at most)\s*(\d{2,5})\s*(?:px|pixels)\b/);

  if (dims) {
    draft.operations.push({ op: 'image.resize', params: { width: Number(dims[1]), height: Number(dims[2]), fit: 'inside' } });
  } else if (widthOnly) {
    draft.operations.push({ op: 'image.resize', params: { width: Number(widthOnly[1]) } });
  } else if (maxDim) {
    const px = Number(maxDim[1]);
    draft.operations.push({ op: 'image.resize', params: { width: px, height: px, fit: 'inside' } });
    draft.constraints.dimensions = { maxWidth: px, maxHeight: px, minScale: 0.35 };
  }

  // --- operations ------------------------------------------------------------
  const convert = take(/\b(?:convert|change|turn|save|export|make)\b[^.]{0,20}?\b(?:to|into|as)\s+(webp|jpe?g|png|avif|tiff?|gif|pdf|zip)\b/)
    ?? take(/\b(?:to|into|as)\s+(webp|jpe?g|png|avif|tiff?|gif)\b/);
  if (convert) {
    const format = FORMAT_WORDS[convert[1] ?? ''] ?? '';
    if (format === 'pdf' && domain === 'image') {
      draft.operations.push({ op: 'pdf.from-images', params: {} });
    } else if (format === 'zip') {
      draft.operations.push({ op: 'archive.create', params: {} });
    } else if (format !== '' && format !== 'pdf') {
      draft.operations.push({ op: 'image.convert', params: { format } });
      draft.constraints.format = format;
    }
  }

  if (take(/\b(?:compress|shrink|reduce|smaller|optimi[sz]e)\b/)) {
    if (domain === 'pdf') draft.operations.push({ op: 'pdf.compress', params: {} });
    else if (domain === 'image') draft.operations.push({ op: 'image.compress', params: {} });
  }

  if (take(/\b(?:merge|combine|join|concat(?:enate)?)\b/) && domain === 'pdf') {
    draft.operations.push({ op: 'pdf.merge', params: {} });
  }

  const extractPages = take(/\b(?:extract|keep|take|only)\s+pages?\s+([\d,\s-]+)/);
  if (extractPages && domain === 'pdf') {
    draft.operations.push({ op: 'pdf.extract-pages', params: { pages: (extractPages[1] ?? '').trim() } });
  } else if (take(/\bsplit\b/) && domain === 'pdf') {
    draft.operations.push({ op: 'pdf.split', params: {} });
  }

  const rotate = take(/\brotate\b(?:\s+(?:by|clockwise|anticlockwise))?\s*(-?\d{1,3})?\s*(?:deg(?:rees)?)?/);
  if (rotate) {
    const angle = rotate[1] ? Number(rotate[1]) : 90;
    draft.operations.push(
      domain === 'pdf' ? { op: 'pdf.rotate', params: { angle } } : { op: 'image.rotate', params: { angle } },
    );
  }

  if (take(/\b(?:gr[ae]yscale|black and white|monochrome)\b/)) {
    draft.operations.push({ op: 'image.grayscale', params: {} });
  }

  if (take(/\b(?:strip|remove|clear|delete)\s+(?:the\s+)?(?:exif|metadata|gps)\b/)) {
    if (domain === 'pdf') draft.operations.push({ op: 'pdf.metadata', params: { clear: true } });
    else draft.operations.push({ op: 'image.strip-metadata', params: {} });
    draft.constraints.stripMetadata = true;
  }

  if (take(/\b(?:zip|archive|bundle|package)\b/) && !draft.operations.some((o) => o.op === 'archive.create')) {
    if (domain === 'archive') draft.operations.push({ op: 'archive.extract', params: {} });
    else draft.operations.push({ op: 'archive.create', params: {} });
  }
  if (take(/\b(?:unzip|extract|unpack|decompress)\b/) && domain === 'archive') {
    if (!draft.operations.some((o) => o.op === 'archive.extract')) {
      draft.operations.push({ op: 'archive.extract', params: {} });
    }
  }

  // A bare size target on its own means "compress to that size".
  if (draft.operations.length === 0 && draft.constraints.size) {
    if (domain === 'image') draft.operations.push({ op: 'image.compress', params: {} });
    else if (domain === 'pdf') draft.operations.push({ op: 'pdf.compress', params: {} });
  }

  if (draft.operations.length === 0) return undefined;
  if (!isFullyUnderstood(lower, consumed)) return undefined;

  const parsed = planSchema.safeParse({
    intent: text.slice(0, 120),
    operations: dedupe(draft.operations),
    ...(draft.select ? { select: draft.select } : {}),
    constraints: draft.constraints,
    output: { bundle: draft.bundle ?? 'auto' },
    source: 'fast-path',
    notes: 'Planned by rules; no model was called.',
  });
  if (!parsed.success) return undefined;

  return { plan: parsed.data, reason: 'matched deterministic rules' };
}

const DOMAIN_NOUNS: Record<string, string> = {
  image: 'image',
  images: 'image',
  photo: 'image',
  photos: 'image',
  picture: 'image',
  pictures: 'image',
  pic: 'image',
  pics: 'image',
  pdf: 'pdf',
  pdfs: 'pdf',
  zip: 'archive',
  zips: 'archive',
  archive: 'archive',
  archives: 'archive',
};

const FORMAT_NOUNS = new Set(['png', 'pngs', 'jpg', 'jpgs', 'jpeg', 'jpegs', 'webp', 'webps', 'gif', 'gifs', 'tiff', 'tiffs', 'avif', 'avifs']);

/**
 * Reads "the images", "all the PDFs", "only the pngs", "the first 3" out of a
 * bulk request. Deliberately narrow: a selector that guesses wrong quietly
 * processes the wrong files, which is worse than not having one.
 */
function parseSelector(lower: string, take: (re: RegExp) => RegExpExecArray | undefined): Selector | undefined {
  const selector: Selector = { order: 'given' };
  let found = false;

  // A determiner is what separates a selection from a verb or a destination.
  // "zip the images" selects images; the bare "zip" is the instruction. Reading
  // any loose noun as a selection makes "zip these" match nothing at all, and
  // "convert to pdf" filter down to the PDFs instead of producing one.
  // The optional "first N" is here so "the first 2 images" still finds `images`.
  const nouns = /\b(?:all|every|each|only|just|the)\s+(?:the\s+)?(?:first\s+\d{1,3}\s+)?([a-z]+)\b/g;
  for (let m = nouns.exec(lower); m !== null; m = nouns.exec(lower)) {
    const word = m[1] ?? '';

    const domain = DOMAIN_NOUNS[word] ?? DOMAIN_NOUNS[`${word}s`];
    if (domain) {
      selector.domains = [...new Set([...(selector.domains ?? []), domain])];
      found = true;
      continue;
    }
    if (FORMAT_NOUNS.has(word) || FORMAT_NOUNS.has(`${word}s`)) {
      selector.formats = [...new Set([...(selector.formats ?? []), word.replace(/s$/, '')])];
      found = true;
    }
  }

  // "the png files", "jpg ones"
  const typed = /\b(png|jpe?g|webp|gif|tiff?|avif)s?\s+(?:files?|ones|images?)\b/.exec(lower);
  if (typed?.[1]) {
    selector.formats = [...new Set([...(selector.formats ?? []), typed[1]])];
    found = true;
  }

  const firstN = take(/\bfirst\s+(\d{1,3})\b/);
  if (firstN?.[1]) {
    selector.limit = Number(firstN[1]);
    found = true;
  }

  const biggest = take(/\b(biggest|largest|smallest)\b/);
  if (biggest) {
    selector.order = biggest[1] === 'smallest' ? 'size-asc' : 'size-desc';
    selector.limit ??= 1;
    found = true;
  }

  return found ? selector : undefined;
}

/** Mirrors the runtime selection closely enough to choose the right rules. */
function applySelector(files: WorkFile[], selector: Selector | undefined): WorkFile[] {
  if (!selector) return files;
  let chosen = files;

  if (selector.domains?.length) {
    const wanted = new Set(selector.domains);
    chosen = chosen.filter((f) => wanted.has(domainForMime(f.mime)));
  }
  if (selector.formats?.length) {
    const wanted = new Set(selector.formats.map((f) => (f === 'jpg' ? 'jpeg' : f === 'tif' ? 'tiff' : f)));
    chosen = chosen.filter((f) => wanted.has(f.mime.split('/')[1] ?? ''));
  }
  return chosen.length > 0 ? chosen : files;
}

/** Every content word must have been claimed by a matcher, or we are guessing. */
function isFullyUnderstood(lower: string, consumed: Array<[number, number]>): boolean {
  const covered = new Uint8Array(lower.length);
  for (const [start, end] of consumed) covered.fill(1, start, end);

  const leftovers: string[] = [];
  const wordRe = /[a-z][a-z'-]*/g;
  for (let m = wordRe.exec(lower); m !== null; m = wordRe.exec(lower)) {
    const isCovered = covered[m.index] === 1;
    if (!isCovered && !FILLER.has(m[0])) leftovers.push(m[0]);
  }
  return leftovers.length === 0;
}

function dedupe(operations: Operation[]): Operation[] {
  const seen = new Set<string>();
  return operations.filter((operation) => {
    if (seen.has(operation.op)) return false;
    seen.add(operation.op);
    return true;
  });
}
