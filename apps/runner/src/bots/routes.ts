import {
  type BotUpdateResponse,
  type BotView,
  apiError,
  botCreateRequestSchema,
  botDeleteRequestSchema,
  botDuplicateRequestSchema,
  botListQuerySchema,
  botUpdateRequestSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { BotError, type BotService } from './service';

type IdParams = { Params: { id: string } };

/** Parses with zod; on failure replies 400 `invalid_body` naming the first bad field. */
function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  reply: FastifyReply,
  code = 'invalid_body',
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
    if (err instanceof BotError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/**
 * GET/POST /api/bots, GET/PATCH/DELETE /api/bots/:id, POST /api/bots/:id/{archive,restore,duplicate},
 * POST /api/team/reset.
 * Responses never include runtime secrets (the MCP token hash) or container internals.
 */
export function registerBotRoutes(app: FastifyInstance, bots: BotService): void {
  app.post('/api/team/reset', async (_req, reply) => handle(reply, () => bots.resetTeam()));

  app.get('/api/bots', async (req, reply): Promise<BotView[] | undefined> => {
    const q = parse(botListQuerySchema, req.query, reply, 'invalid_query');
    if (!q) return;
    return bots.list(q.archived);
  });

  app.post('/api/bots', async (req, reply) => {
    const body = parse(botCreateRequestSchema, req.body, reply);
    if (!body) return;
    const bot = await handle(reply, () => bots.create(body));
    if (bot) return reply.code(201).send(bots.view(bot));
  });

  app.get<IdParams>('/api/bots/:id', async (req, reply) =>
    handle(reply, () => bots.view(bots.get(req.params.id))),
  );

  app.patch<IdParams>('/api/bots/:id', async (req, reply): Promise<BotUpdateResponse | undefined> => {
    const body = parse(botUpdateRequestSchema, req.body, reply);
    if (!body) return;
    const res = await handle(reply, () => bots.update(req.params.id, body));
    return res && { bot: bots.view(res.bot), restartRequired: res.restartRequired };
  });

  app.delete<IdParams>('/api/bots/:id', async (req, reply) => {
    const body = parse(botDeleteRequestSchema, req.body, reply);
    if (!body) return;
    const done = await handle(reply, async () => {
      await bots.delete(req.params.id, body);
      return true;
    });
    if (done) return reply.code(204).send();
  });

  app.post<IdParams>('/api/bots/:id/archive', async (req, reply) =>
    handle(reply, async () => bots.view(await bots.archive(req.params.id))),
  );

  app.post<IdParams>('/api/bots/:id/restore', async (req, reply) =>
    handle(reply, () => bots.view(bots.restore(req.params.id))),
  );

  app.post<IdParams>('/api/bots/:id/duplicate', async (req, reply) => {
    const body = parse(botDuplicateRequestSchema, req.body, reply);
    if (!body) return;
    const bot = await handle(reply, () => bots.duplicate(req.params.id, body.name));
    if (bot) return reply.code(201).send(bots.view(bot));
  });
}
