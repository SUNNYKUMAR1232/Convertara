import { unzipSync, zip } from 'fflate';
import type { Zippable } from 'fflate';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { AppError } from '../../core/errors.js';
import type { Capability, EnginePlugin, OpInput, SizeOptimizer, WorkFile } from '../../router/types.js';
import { ExtractionBudget } from '../../security/archive-guard.js';
import { sniffMime } from '../../security/sniff.js';

const ZIP_MIME = 'application/zip';
const always = () => true;

function limits() {
  const c = config();
  return {
    maxEntries: c.ARCHIVE_MAX_ENTRIES,
    maxTotalBytes: c.ARCHIVE_MAX_TOTAL_BYTES,
    maxRatio: c.ARCHIVE_MAX_RATIO,
  };
}

/** fflate's async zip runs off the main thread; wrap it so callers can await. */
function zipAsync(payload: Zippable, level: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip(payload, { level: level as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }, (err, data) => {
      if (err) reject(new AppError('EXECUTION_FAILED', `Could not build archive: ${err.message}`));
      else resolve(Buffer.from(data));
    });
  });
}

export async function buildZip(files: WorkFile[], level = 6, name = 'archive.zip'): Promise<WorkFile> {
  const payload: Zippable = {};
  const used = new Set<string>();

  for (const file of files) {
    let entry = file.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (used.has(entry)) {
      const dot = entry.lastIndexOf('.');
      const stem = dot > 0 ? entry.slice(0, dot) : entry;
      const ext = dot > 0 ? entry.slice(dot) : '';
      let n = 2;
      while (used.has(`${stem}-${n}${ext}`)) n += 1;
      entry = `${stem}-${n}${ext}`;
    }
    used.add(entry);
    payload[entry] = new Uint8Array(file.data);
  }

  const data = await zipAsync(payload, level);
  return { name, data, mime: ZIP_MIME, meta: { entries: files.length } };
}

const create: Capability = {
  name: 'archive.create',
  domain: 'archive',
  title: 'Create a zip',
  description: 'Bundle the current files into a single zip archive.',
  accepts: ['*/*'],
  produces: ZIP_MIME,
  cost: 3,
  available: always,
  paramsHint: 'level: 0-9 deflate level (default 6), filename: output name',
  paramsSchema: z.object({
    level: z.number().int().min(0).max(9).default(6),
    filename: z.string().max(120).default('archive.zip'),
  }),
  run: async (input: OpInput<{ level: number; filename: string }>) => {
    input.ctx.progress(0.1);
    const result = await buildZip(input.files, input.params.level, input.params.filename);
    input.ctx.progress(1);
    return [result];
  },
};

const extract: Capability = {
  name: 'archive.extract',
  domain: 'archive',
  title: 'Extract a zip',
  description: 'Unpack a zip archive. Path traversal and zip bombs are rejected before anything is written.',
  accepts: [ZIP_MIME, 'application/x-zip-compressed'],
  // Whatever was in the archive - declaring `same` here told the router the
  // output was still a zip, and let a later zip-only operation through.
  produces: 'varies',
  cost: 4,
  available: always,
  paramsHint: 'prefix: optional path prefix filter',
  paramsSchema: z.object({
    /** Only extract entries matching this glob-ish prefix, e.g. `images/`. */
    prefix: z.string().max(200).optional(),
  }),
  run: async (input: OpInput<{ prefix?: string }>) => {
    const out: WorkFile[] = [];

    for (const file of input.files) {
      input.ctx.signal.throwIfAborted();
      const budget = new ExtractionBudget(limits());
      const renamed = new Map<string, string>();

      const entries = unzipSync(new Uint8Array(file.data), {
        filter: (info) => {
          if (info.name.endsWith('/')) return false; // directory marker
          const safe = budget.admit({
            name: info.name,
            compressedSize: info.size,
            uncompressedSize: info.originalSize,
          });
          if (input.params.prefix && !safe.startsWith(input.params.prefix)) return false;
          renamed.set(info.name, safe);
          return true;
        },
      });

      for (const [rawName, bytes] of Object.entries(entries)) {
        const data = Buffer.from(bytes);
        out.push({
          name: renamed.get(rawName) ?? rawName,
          data,
          mime: await sniffMime(data, renamed.get(rawName) ?? rawName),
          meta: { fromArchive: file.name },
        });
      }
      input.ctx.progress(1);
    }

    if (out.length === 0) throw new AppError('EXECUTION_FAILED', 'Archive contained no extractable files');
    return out;
  },
};

const inspect: Capability = {
  name: 'archive.inspect',
  domain: 'archive',
  title: 'Inspect a zip',
  description: 'List the entries in an archive without unpacking it.',
  accepts: [ZIP_MIME, 'application/x-zip-compressed'],
  produces: 'same',
  cost: 1,
  available: always,
  paramsHint: 'no parameters',
  paramsSchema: z.object({}),
  run: async (input: OpInput<Record<string, never>>) => {
    return input.files.map((file) => {
      const listing: Array<{ name: string; compressed: number; uncompressed: number }> = [];
      const budget = new ExtractionBudget(limits());

      unzipSync(new Uint8Array(file.data), {
        filter: (info) => {
          if (!info.name.endsWith('/')) {
            listing.push({
              name: budget.admit({
                name: info.name,
                compressedSize: info.size,
                uncompressedSize: info.originalSize,
              }),
              compressed: info.size,
              uncompressed: info.originalSize,
            });
          }
          return false; // never decompress
        },
      });

      return { ...file, meta: { ...file.meta, entries: listing, entryCount: listing.length } };
    });
  },
};

/** Deflate level is the only knob; there is no lossy mode for a zip. */
const optimizer: SizeOptimizer = {
  domain: 'archive',
  supports: (file) => file.mime === ZIP_MIME,
  knobs: () => ({ quality: { min: 1, max: 100 }, scale: { min: 1, max: 1 } }),
  render: async (file, { quality }) => {
    const budget = new ExtractionBudget(limits());
    const renamed = new Map<string, string>();
    const entries = unzipSync(new Uint8Array(file.data), {
      filter: (info) => {
        if (info.name.endsWith('/')) return false;
        renamed.set(
          info.name,
          budget.admit({ name: info.name, compressedSize: info.size, uncompressedSize: info.originalSize }),
        );
        return true;
      },
    });
    const files: WorkFile[] = Object.entries(entries).map(([name, bytes]) => ({
      name: renamed.get(name) ?? name,
      data: Buffer.from(bytes),
      mime: 'application/octet-stream',
      meta: {},
    }));
    const level = Math.max(0, Math.min(9, Math.round((quality / 100) * 9)));
    return buildZip(files, level, file.name);
  },
};

export const archiveEngine: EnginePlugin = {
  domain: 'archive',
  title: 'Archive engine (zip)',
  capabilities: [create, extract, inspect],
  optimizer,
};
