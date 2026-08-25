import { AppError } from '../core/errors.js';
import type { ErrorCode } from '../core/errors.js';
import { describeWindow, resolveConstraints } from '../constraints/engine.js';
import { humaniseError } from './errors.js';
import type { JobRecord } from '../db/types.js';
import { formatBytes } from '../core/units.js';

export interface ReplyFile {
  filename: string;
  bytes: number;
  mime: string;
  meta: Record<string, unknown>;
}

/**
 * Writes the assistant's reply for a turn that did work.
 *
 * Deliberately not a model call. The facts are all in hand - what ran, what
 * went in, what came out, whether the constraints hold - and a template that
 * knows those facts produces a better sentence than a model guessing at them,
 * for no latency and no cost. The model is for understanding the request, not
 * for narrating the receipt.
 */
export function describeResult(job: JobRecord, inputs: ReplyFile[], outputs: ReplyFile[]): string {
  if (job.status === 'failed') {
    if (!job.error) return 'That did not work, and I could not produce a file.';
    return humaniseError(new AppError(job.error.code as ErrorCode, job.error.message));
  }
  if (outputs.length === 0) return 'That finished, but produced nothing to download.';

  const parts: string[] = [what(job, inputs, outputs)];

  const constraints = job.plan ? resolveConstraints(job.plan.constraints) : undefined;
  const window = constraints ? describeWindow(constraints) : undefined;

  if (job.status === 'partial') {
    parts.push(
      window
        ? `That misses the ${window} you asked for. Going further would have pushed quality below the floor, so this is the closest I could get without wrecking it.`
        : 'It does not satisfy every constraint you set, but it is the closest I could get.',
    );
    parts.push('The file is attached either way, in case it is good enough.');
  } else if (window && constraints?.size) {
    // "inside your at most 20 KB" is what you get from reusing one phrase for
    // both shapes of constraint, so a ceiling gets its own sentence.
    parts.push(
      constraints.size.mode === 'max'
        ? `That is under the ${formatBytes(constraints.size.max)} ceiling you set.`
        : `That is inside your ${window}.`,
    );
  }

  return parts.join(' ');
}

function what(job: JobRecord, inputs: ReplyFile[], outputs: ReplyFile[]): string {
  const ops = job.plan?.operations.map((o) => o.op) ?? [];
  const first = outputs[0];
  if (!first) return 'Done.';

  const inputBytes = inputs.reduce((n, f) => n + f.bytes, 0);
  const outputBytes = outputs.reduce((n, f) => n + f.bytes, 0);

  // Several files in, one archive out.
  if (outputs.length === 1 && first.mime === 'application/zip' && inputs.length > 1 && ops.includes('archive.create')) {
    return `Zipped ${plural(inputs.length, 'file')} into ${first.filename} (${formatBytes(first.bytes)}).`;
  }
  if (ops.includes('archive.extract')) {
    return `Unpacked ${plural(outputs.length, 'file')} from the archive.`;
  }
  if (ops.includes('pdf.merge')) {
    const pages = typeof first.meta.pages === 'number' ? `, ${first.meta.pages} pages` : '';
    return `Merged ${inputs.length} PDFs into ${first.filename} (${formatBytes(first.bytes)}${pages}).`;
  }
  if (ops.includes('pdf.split')) {
    // Several outputs get bundled into one zip before they reach here, so the
    // count the user cares about is inside the archive, not the length of this
    // array - which would always report "1 file".
    const pieces = bundledCount(outputs) ?? outputs.length;
    const zipped = pieces !== outputs.length ? ', zipped for download' : '';
    return `Split that into ${plural(pieces, 'file')}${zipped}.`;
  }
  if (ops.includes('pdf.extract-pages')) {
    const pages = typeof first.meta.pages === 'number' ? `${first.meta.pages} pages` : 'the pages you asked for';
    return `Pulled out ${pages} (${formatBytes(first.bytes)}).`;
  }

  if (ops.includes('image.crop')) {
    const size = typeof first.meta.width === 'number' ? ` to ${first.meta.width}x${first.meta.height}` : '';
    return `Cropped${size} - ${formatBytes(outputBytes)}.`;
  }
  if (ops.includes('image.rotate') || ops.includes('pdf.rotate')) {
    const size = typeof first.meta.width === 'number' ? `, now ${first.meta.width}x${first.meta.height}` : '';
    return `Rotated${size} - ${formatBytes(outputBytes)}.`;
  }

  const shrank = inputBytes > 0 && outputBytes < inputBytes * 0.95;
  const grew = inputBytes > 0 && outputBytes > inputBytes * 1.05;
  const converted = ops.includes('image.convert') || ops.includes('pdf.from-images');
  const resized = ops.includes('image.resize');

  const bits: string[] = [];
  if (converted) bits.push(`Converted to ${label(first.mime)}`);
  else if (resized) bits.push('Resized that');
  else if (shrank) bits.push('Compressed that');
  else bits.push('Done');

  // Nearly every resize also shrinks the file, so the resize has to be checked
  // first or the reply describes the side effect instead of the instruction.
  if (resized && typeof first.meta.width === 'number') {
    bits.push(`to ${first.meta.width}x${first.meta.height}`);
  }

  const size =
    inputs.length === 1 && (shrank || grew)
      ? `${formatBytes(inputBytes)} to ${formatBytes(outputBytes)}`
      : formatBytes(outputBytes);

  const spread = bundledCount(outputs) ?? outputs.length;
  const many = spread > 1 ? ` across ${plural(spread, 'file')}` : '';
  return `${bits.join(' ')}${many} - ${size}.`;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** How many files went into the archive, when the pipeline bundled the results. */
function bundledCount(outputs: ReplyFile[]): number | undefined {
  const only = outputs.length === 1 ? outputs[0] : undefined;
  if (!only || only.mime !== 'application/zip') return undefined;
  return typeof only.meta.entries === 'number' ? only.meta.entries : undefined;
}

function label(mime: string): string {
  const names: Record<string, string> = {
    'image/jpeg': 'JPEG',
    'image/png': 'PNG',
    'image/webp': 'WebP',
    'image/avif': 'AVIF',
    'image/gif': 'GIF',
    'image/tiff': 'TIFF',
    'application/pdf': 'PDF',
    'application/zip': 'a zip',
  };
  return names[mime] ?? mime;
}

/** Shown when the user sends an instruction with no file anywhere in the thread. */
export const NO_FILE_REPLY =
  'Attach a file and tell me what to do with it. I handle images, PDFs and zip archives - convert, resize, compress to an exact size, crop, rotate, merge, split, extract pages, zip and unzip.';
