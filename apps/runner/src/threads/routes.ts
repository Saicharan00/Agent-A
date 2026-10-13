import {
  MAX_ATTACHMENT_BYTES,
  apiError,
  inboxUploadQuerySchema,
  messagePageQuerySchema,
  sendMessageRequestSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { RunError } from '../runs/service';
import { ThreadError, type ThreadService } from './service';

type IdParams = { Params: { id: string } };

function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
  code: string,
): z.output<S> | undefined {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply.code(400).send(apiError(code, `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

async function handle<T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ThreadError || err instanceof RunError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/**
 * GET /api/threads/:id, GET/POST /api/threads/:id/messages, and POST /api/bots/:id/inbox?name= (raw file bytes,
 * application/octet-stream) for chat attachments.
 */
export async function registerThreadRoutes(app: FastifyInstance, threads: ThreadService): Promise<void> {
  app.get<IdParams>('/api/threads/:id', async (req, reply) =>
    handle(reply, () => threads.get(req.params.id)),
  );

  app.get<IdParams>('/api/threads/:id/messages', async (req, reply) => {
    const q = parse(messagePageQuerySchema, req.query, reply, 'invalid_query');
    if (!q) return;
    return handle(reply, () => threads.messages(req.params.id, q));
  });

  app.post<IdParams>('/api/threads/:id/messages', async (req, reply) => {
    const body = parse(sendMessageRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const res = await handle(reply, () => threads.send(req.params.id, body));
    if (res) return reply.code(201).send(res);
  });

  // Binary uploads get their own scope so the octet-stream parser and the larger body limit stay local.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post<IdParams>('/api/bots/:id/inbox', { bodyLimit: MAX_ATTACHMENT_BYTES }, async (req, reply) => {
      const q = parse(inboxUploadQuerySchema, req.query, reply, 'invalid_query');
      if (!q) return;
      if (!Buffer.isBuffer(req.body)) {
        return reply
          .code(415)
          .send(apiError('unsupported_media_type', 'Send the file as application/octet-stream'));
      }
      const data = req.body;
      const res = await handle(reply, () => threads.saveToInbox(req.params.id, q.name, data));
      if (res) return reply.code(201).send(res);
    });
  });
}
