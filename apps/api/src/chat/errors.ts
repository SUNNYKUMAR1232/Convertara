import { AppError } from '../core/errors.js';

/**
 * Turns an internal failure into something a person can act on.
 *
 * `Invalid parameters for "image.compress"` is a sentence written for whoever
 * wrote image.compress. In a chat window it is noise: it names a thing the user
 * never asked for, in a vocabulary they do not have, and it does not say what
 * to do next. Every branch here answers "what happened, and what should I try
 * instead" - the raw text stays in the logs where it belongs.
 */
export function humaniseError(error: unknown): string {
  if (!(error instanceof AppError)) {
    return 'Something went wrong at my end and that did not finish. Worth trying again.';
  }

  switch (error.code) {
    case 'PLAN_INVALID': {
      // A type mismatch can be explained precisely, so do that rather than
      // giving the generic answer.
      const mismatch = /"([a-z0-9]+\.[a-z-]+)" cannot accept (.+)/i.exec(error.message);
      if (mismatch) {
        return `${friendlyOperation(mismatch[1])} does not work on ${describeType(mismatch[2] ?? '')}. Tell me what you would like done to it instead.`;
      }
      // Otherwise: usually the model emitting parameters that failed validation.
      return 'I could not work out how to do that reliably. Could you put it another way? Something concrete works best - "compress to 300 KB", "convert to JPG", "resize to 1200px wide".';
    }

    case 'CAPABILITY_UNAVAILABLE':
      return `${friendlyOperation(error.details?.operation)} is not available on this deployment. ${enableHint(error.details?.operation)}`;

    case 'UNSUPPORTED_MEDIA_TYPE':
      return `${error.message}. I work with images, PDFs and zip archives.`;

    case 'FILE_TOO_LARGE':
      return `${error.message} Try a smaller file, or split it up first.`;

    case 'CONSTRAINT_UNSATISFIABLE':
      return error.message;

    case 'EXECUTION_TIMEOUT':
      return 'That took longer than the time limit allows. A smaller file, or a less aggressive target, should get through.';

    case 'LLM_UNAVAILABLE':
      return 'I can only answer open questions when a language model is configured - add one under Settings. Direct instructions still work without one: "compress to 300 KB", "convert to WebP", "resize to 1200px".';

    case 'LLM_FAILED':
      return 'The language model did not answer. Check the key and model under Settings - or give me a direct instruction, which needs no model at all.';

    case 'SECURITY_REJECTED':
      return `I stopped that one for safety: ${lower(error.message)}`;

    case 'EXECUTION_FAILED':
      return explainExecution(error.message);

    case 'NOT_FOUND':
      return 'That file is no longer available - uploads are deleted automatically after 24 hours. Attach it again and I will pick up where we left off.';

    default:
      return 'That did not work. Try rephrasing, or attach the file again.';
  }
}

/** Engine failures carry a `capability.name failed: detail` shape. */
function explainExecution(message: string): string {
  const match = /^([a-z0-9]+\.[a-z-]+) failed: (.*)$/i.exec(message);
  if (!match) return `That did not finish: ${lower(message)}`;

  const [, operation, detail] = match;
  const friendly = friendlyOperation(operation);

  if (/invalid zip|not a zip|end of central directory/i.test(detail ?? '')) {
    return `${friendly} needs a zip archive, and that file is not one.`;
  }
  if (/encrypt|password/i.test(detail ?? '')) {
    return 'That PDF is password protected, so I cannot open it. Remove the password and send it again.';
  }
  if (/could not read|unsupported image|Input (file|buffer)/i.test(detail ?? '')) {
    return 'I could not read that file - it may be corrupt or not the format its extension claims.';
  }
  return `${friendly} did not work on that file: ${lower(detail ?? '')}`;
}

/** `image.strip-metadata` reads badly in a sentence; "Stripping metadata" does not. */
function friendlyOperation(operation: unknown): string {
  const names: Record<string, string> = {
    'image.convert': 'Converting images',
    'image.resize': 'Resizing',
    'image.compress': 'Compressing',
    'image.crop': 'Cropping',
    'image.rotate': 'Rotating',
    'image.grayscale': 'Converting to greyscale',
    'image.strip-metadata': 'Stripping metadata',
    'pdf.merge': 'Merging PDFs',
    'pdf.split': 'Splitting PDFs',
    'pdf.extract-pages': 'Extracting pages',
    'pdf.rotate': 'Rotating pages',
    'pdf.compress': 'Compressing PDFs',
    'pdf.metadata': 'Editing PDF metadata',
    'pdf.from-images': 'Making a PDF from images',
    'archive.create': 'Zipping',
    'archive.extract': 'Unzipping',
    'archive.inspect': 'Inspecting an archive',
  };
  return typeof operation === 'string' ? (names[operation] ?? operation) : 'That operation';
}

function enableHint(operation: unknown): string {
  return operation === 'pdf.compress'
    ? 'It needs Ghostscript installed on the server.'
    : 'Ask whoever runs this server to enable it.';
}

function describeType(mime: string): string {
  const names: Record<string, string> = {
    'image/jpeg': 'a JPEG',
    'image/png': 'a PNG',
    'image/webp': 'a WebP',
    'image/gif': 'a GIF',
    'image/tiff': 'a TIFF',
    'image/avif': 'an AVIF',
    'application/pdf': 'a PDF',
    'application/zip': 'a zip archive',
  };
  const first = mime.split(',')[0]?.trim() ?? mime;
  return names[first] ?? `a ${first} file`;
}

const lower = (text: string): string => (text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text);
