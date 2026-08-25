import type { Plan, Selector } from '../core/plan.js';
import { AppError } from '../core/errors.js';
import { registry } from '../router/registry.js';
import { formatBytes } from '../core/units.js';
import { mimeMatches } from '../router/capability-router.js';
import type { Capability, WorkFile } from '../router/types.js';
import { domainForMime } from './domain.js';

export interface Selection {
  chosen: WorkFile[];
  skipped: WorkFile[];
  /** Why files were left out, phrased for a human. */
  reason?: string;
}

const EXTENSION_ALIASES: Record<string, string> = {
  jpg: 'jpeg',
  tif: 'tiff',
  heic: 'heif',
};

/**
 * Picks the files a bulk request actually meant.
 *
 * Dropping forty files in and saying "compress the images" should compress the
 * images, not fail because three PDFs came along. Selection is deterministic and
 * happens before any engine runs, so what got chosen can be reported exactly
 * rather than inferred from what came out.
 */
export function selectFiles(files: WorkFile[], selector: Selector | undefined): Selection {
  if (!selector || files.length === 0) return { chosen: files, skipped: [] };

  let chosen = files;
  const reasons: string[] = [];

  if (selector.domains && selector.domains.length > 0) {
    const wanted = new Set(selector.domains);
    chosen = chosen.filter((f) => wanted.has(domainForMime(f.mime)));
    reasons.push(selector.domains.join(' and '));
  }

  if (selector.formats && selector.formats.length > 0) {
    const wanted = new Set(selector.formats.map((f) => EXTENSION_ALIASES[f.toLowerCase()] ?? f.toLowerCase()));
    chosen = chosen.filter((f) => wanted.has(subtype(f.mime)) || wanted.has(extension(f.name)));
    reasons.push(selector.formats.join('/'));
  }

  if (selector.minBytes !== undefined) {
    chosen = chosen.filter((f) => f.data.length >= selector.minBytes!);
    reasons.push(`over ${formatBytes(selector.minBytes)}`);
  }

  if (selector.maxBytes !== undefined) {
    chosen = chosen.filter((f) => f.data.length <= selector.maxBytes!);
    reasons.push(`under ${formatBytes(selector.maxBytes)}`);
  }

  if (selector.nameContains) {
    const needle = selector.nameContains.toLowerCase();
    chosen = chosen.filter((f) => f.name.toLowerCase().includes(needle));
    reasons.push(`named like "${selector.nameContains}"`);
  }

  if (selector.order && selector.order !== 'given') {
    chosen = [...chosen].sort(comparator(selector.order));
  }

  if (selector.indices && selector.indices.length > 0) {
    // 1-based on the way in, because that is how people count files.
    const wanted = new Set(selector.indices);
    chosen = chosen.filter((_, index) => wanted.has(index + 1));
  }

  if (selector.limit !== undefined) {
    chosen = chosen.slice(0, selector.limit);
    reasons.push(`first ${selector.limit}`);
  }

  const chosenIds = new Set(chosen);
  const result: Selection = { chosen, skipped: files.filter((f) => !chosenIds.has(f)) };
  if (result.skipped.length > 0 && reasons.length > 0) result.reason = reasons.join(', ');
  return result;
}

/**
 * Narrows to the files an operation can actually take.
 *
 * This is the difference between "merge these PDFs" working on a folder that
 * also has images in it, and failing with a type error. Only a selection that
 * would leave nothing is an error worth raising.
 */
export function selectAcceptable(files: WorkFile[], capability: Capability): Selection {
  const chosen = files.filter((f) => mimeMatches(capability.accepts, f.mime));
  const skipped = files.filter((f) => !mimeMatches(capability.accepts, f.mime));

  if (skipped.length === 0) return { chosen, skipped: [] };
  return { chosen, skipped, reason: describeSkipped(skipped) };
}

export interface NarrowResult {
  files: WorkFile[];
  note?: { chosenCount: number; totalCount: number; skipped: string; reason?: string };
}

/**
 * The single place a plan is matched to files.
 *
 * Both the cost estimate and the execution need the same answer, and they used
 * to compute it separately - which meant a mixed batch failed during estimation
 * before the narrowing in the executor ever ran.
 */
export function narrowForPlan(files: WorkFile[], plan: Plan): NarrowResult {
  const asked = selectFiles(files, plan.select);
  let chosen = asked.chosen;

  const opener = plan.operations[0] ? registry.get(plan.operations[0].op) : undefined;
  if (opener && chosen.length > 0) {
    const acceptable = selectAcceptable(chosen, opener);
    if (acceptable.chosen.length === 0) {
      throw new AppError(
        'PLAN_INVALID',
        `"${opener.name}" cannot accept ${[...new Set(chosen.map((f) => f.mime))].join(', ')}`,
        { accepts: opener.accepts },
      );
    }
    chosen = acceptable.chosen;
  }

  if (chosen.length === 0) {
    throw new AppError('PLAN_INVALID', 'Nothing matched that selection', { attached: files.length });
  }

  const leftOut = files.filter((file) => !chosen.includes(file));
  if (leftOut.length === 0) return { files: chosen };

  return {
    files: chosen,
    note: {
      chosenCount: chosen.length,
      totalCount: files.length,
      skipped: describeSkipped(leftOut),
      ...(asked.reason ? { reason: asked.reason } : {}),
    },
  };
}

/** "3 PDFs" / "a PNG and 2 zips" - what got left out, in words. */
export function describeSkipped(skipped: WorkFile[]): string {
  const counts = new Map<string, number>();
  for (const file of skipped) {
    const label = friendlyType(file.mime);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const parts = [...counts.entries()].map(([label, count]) =>
    count === 1 ? `1 ${label}` : `${count} ${label}s`,
  );
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function comparator(order: NonNullable<Selector['order']>): (a: WorkFile, b: WorkFile) => number {
  switch (order) {
    case 'name':
      return (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    case 'size-asc':
      return (a, b) => a.data.length - b.data.length;
    case 'size-desc':
      return (a, b) => b.data.length - a.data.length;
    default:
      return () => 0;
  }
}

function subtype(mime: string): string {
  const raw = mime.split('/')[1] ?? mime;
  return EXTENSION_ALIASES[raw] ?? raw;
}

function extension(name: string): string {
  const raw = name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_ALIASES[raw] ?? raw;
}

function friendlyType(mime: string): string {
  const names: Record<string, string> = {
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/tiff': 'TIFF',
    'image/avif': 'AVIF',
    'application/pdf': 'PDF',
    'application/zip': 'zip',
  };
  return names[mime] ?? mime.split('/')[1] ?? 'file';
}
