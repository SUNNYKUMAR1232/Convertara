import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, notFound } from '../../core/errors.js';
import { repository } from '../../db/index.js';
import { ingest } from '../../execution/pipeline.js';
import type { Upload } from '../../execution/pipeline.js';
import { objectStore } from '../../storage/index.js';
import { config } from '../../core/config.js';
import { ownerOf } from '../context.js';

const idParams = z.object({ id: z.string().uuid() });

export async function fileRoutes(app: FastifyInstance): Promise<void> {
  /** Multipart upload. Returns ids to hand to POST /v1/process. */
  app.post('/v1/files', async (request, reply) => {
    const owner = ownerOf(request);
    const uploads: Upload[] = [];
    const cfg = config();

    for await (const part of request.parts()) {
      if (part.type !== 'file') continue;
      const data = await part.toBuffer();
      uploads.push({ filename: part.filename || 'upload', data });
      if (uploads.length > cfg.MAX_FILES_PER_REQUEST) {
        throw new AppError('BAD_REQUEST', `At most ${cfg.MAX_FILES_PER_REQUEST} files per request`);
      }
    }

    const records = await ingest(owner, uploads);
    return reply.code(201).send({
      files: records.map((r) => ({
        id: r.id,
        filename: r.filename,
        mime: r.mime,
        bytes: r.bytes,
        expiresAt: r.expiresAt,
      })),
    });
  });

  app.get('/v1/files/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const record = await repository().getFile(id);
    if (!record || record.ownerId !== ownerOf(request)) throw notFound(`File not found: ${id}`);
    return {
      id: record.id,
      filename: record.filename,
      mime: record.mime,
      bytes: record.bytes,
      kind: record.kind,
      meta: record.meta,
      checksum: record.checksum,
      expiresAt: record.expiresAt,
    };
  });

  /** The download itself. `?inline=1` renders in the browser instead of saving. */
  app.get('/v1/files/:id/content', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const record = await repository().getFile(id);
    if (!record || record.ownerId !== ownerOf(request)) throw notFound(`File not found: ${id}`);

    const object = await objectStore().get(record.storageKey);
    const inline = (request.query as { inline?: string }).inline === '1';
    const disposition = inline ? 'inline' : 'attachment';

    return reply
      .header('content-type', record.mime)
      .header('content-length', object.data.length)
      .header('content-disposition', `${disposition}; filename="${record.filename.replace(/"/g, '')}"`)
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .send(object.data);
  });
}
