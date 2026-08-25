import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../core/config.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { fileRoutes } from './routes/files.js';
import { llmRoutes } from './routes/llm.js';
import { processRoutes } from './routes/process.js';
import { systemRoutes } from './routes/system.js';

export async function buildServer(): Promise<FastifyInstance> {
  const cfg = config();

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
    disableRequestLogging: cfg.NODE_ENV === 'production',
  });

  await app.register(cors, {
    origin: cfg.CORS_ORIGIN === '*' ? true : cfg.CORS_ORIGIN.split(',').map((o) => o.trim()),
    credentials: true,
    exposedHeaders: ['content-disposition'],
  });

  await app.register(multipart, {
    limits: {
      fileSize: cfg.MAX_UPLOAD_BYTES,
      files: cfg.MAX_FILES_PER_REQUEST,
      fields: 10,
    },
  });

  await app.register(systemRoutes);
  await app.register(fileRoutes);
  await app.register(processRoutes);
  await app.register(llmRoutes);

  /** One error shape for every failure, so clients never have to guess. */
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
      return reply.code(error.statusCode).send(error.toJSON());
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request body failed validation',
          details: { issues: error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) },
        },
      });
    }

    const status = (error as { statusCode?: number }).statusCode ?? 500;
    if (status === 413) {
      return reply.code(413).send({
        error: { code: 'FILE_TOO_LARGE', message: `Upload exceeds ${cfg.MAX_UPLOAD_BYTES} bytes` },
      });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(status).send({
      error: {
        code: status >= 500 ? 'INTERNAL' : 'BAD_REQUEST',
        message: status >= 500 && cfg.NODE_ENV === 'production' ? 'Something went wrong' : error.message,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` } }),
  );

  return app;
}
