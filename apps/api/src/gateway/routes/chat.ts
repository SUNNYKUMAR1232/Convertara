import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../core/errors.js';
import { handleTurn, serialise } from '../../chat/service.js';
import { repository } from '../../db/index.js';
import type { FileRecord } from '../../db/types.js';
import { ownerOf } from '../context.js';

const turnBody = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().max(4000).default(''),
  fileIds: z.array(z.string().uuid()).max(64).default([]),
});

const idParams = z.object({ id: z.string().uuid() });

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One turn, streamed.
   *
   * POST rather than GET because a turn carries a body, which rules out
   * EventSource on the client - it reads the response stream directly instead.
   * The frames are the same shape either way.
   */
  app.post('/v1/chat', async (request: FastifyRequest, reply: FastifyReply) => {
    const owner = ownerOf(request);
    const body = turnBody.parse(request.body);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    // Watch the response, not the request. Node emits `close` on a POST's
    // request stream as soon as the body has been read, which is immediately -
    // using that as the disconnect signal aborts every turn before its first
    // event and never ends the response.
    let closed = false;
    reply.raw.on('close', () => {
      closed = true;
    });

    try {
      for await (const event of handleTurn({
        ownerId: owner,
        conversationId: body.conversationId,
        text: body.text,
        fileIds: body.fileIds,
      })) {
        if (closed) break;
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!closed) reply.raw.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }

    return reply;
  });

  app.get('/v1/conversations', async (request) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(request.query);
    const conversations = await repository().listConversations(ownerOf(request), query.limit);
    return {
      conversations: conversations.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
    };
  });

  app.get('/v1/conversations/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    const repo = repository();
    const conversation = await repo.getConversation(id);
    if (!conversation || conversation.ownerId !== ownerOf(request)) throw notFound('Conversation not found');

    const messages = await repo.listMessages(id, 200);
    const serialised = await Promise.all(
      messages.map(async (message) => {
        const files = await Promise.all(message.attachmentIds.map((fid) => repo.getFile(fid)));
        return serialise(message, files.filter((f): f is FileRecord => f !== null));
      }),
    );

    return { conversation: { id: conversation.id, title: conversation.title }, messages: serialised };
  });

  app.delete('/v1/conversations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const conversation = await repository().getConversation(id);
    if (!conversation || conversation.ownerId !== ownerOf(request)) throw notFound('Conversation not found');
    await repository().deleteConversation(id);
    return reply.code(204).send();
  });
}
