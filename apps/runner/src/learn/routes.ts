import {
  apiError,
  decisionCreateRequestSchema,
  decisionListQuerySchema,
  decisionUpdateRequestSchema,
  lessonCreateRequestSchema,
  lessonListQuerySchema,
  lessonReviewRequestSchema,
  lessonUpdateRequestSchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { LearnError, type LearnService } from './service';

type IdParams = { Params: { id: string } };

function parse<S extends z.ZodType>(schema: S, value: unknown, reply: FastifyReply, code: string) {
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return parsed.data as z.infer<S>;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join('.');
  void reply.code(400).send(apiError(code, `${field ? `${field}: ` : ''}${issue?.message ?? 'invalid'}`));
  return undefined;
}

function handle<T>(reply: FastifyReply, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    if (err instanceof LearnError) {
      void reply.code(err.statusCode).send(apiError(err.code, err.message));
      return undefined;
    }
    throw err;
  }
}

/** /api/decisions* and /api/lessons* (PLAN F23 Learn). */
export function registerLearnRoutes(app: FastifyInstance, learn: LearnService): void {
  app.get('/api/decisions', async (req, reply) => {
    const q = parse(decisionListQuerySchema, req.query, reply, 'invalid_query');
    if (q) return learn.listDecisions(q);
  });

  app.get<IdParams>('/api/decisions/:id', async (req, reply) =>
    handle(reply, () => learn.getDecision(req.params.id)),
  );

  app.post('/api/decisions', async (req, reply) => {
    const body = parse(decisionCreateRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const res = handle(reply, () => learn.createDecision(body));
    if (res) return reply.code(201).send(res);
  });

  app.patch<IdParams>('/api/decisions/:id', async (req, reply) => {
    const body = parse(decisionUpdateRequestSchema, req.body, reply, 'invalid_body');
    if (body) return handle(reply, () => learn.updateDecision(req.params.id, body));
  });

  app.get('/api/lessons', async (req, reply) => {
    const q = parse(lessonListQuerySchema, req.query, reply, 'invalid_query');
    if (q) return learn.listLessons({ topic: q.topic, due: q.due === '1' });
  });

  app.post('/api/lessons', async (req, reply) => {
    const body = parse(lessonCreateRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const res = handle(reply, () => learn.createLesson(body));
    if (res) return reply.code(201).send(res);
  });

  app.patch<IdParams>('/api/lessons/:id', async (req, reply) => {
    const body = parse(lessonUpdateRequestSchema, req.body, reply, 'invalid_body');
    if (body) return handle(reply, () => learn.updateLesson(req.params.id, body));
  });

  app.post<IdParams>('/api/lessons/:id/review', async (req, reply) => {
    const body = parse(lessonReviewRequestSchema, req.body, reply, 'invalid_body');
    if (body) return handle(reply, () => learn.reviewLesson(req.params.id, body.result));
  });

  app.delete<IdParams>('/api/lessons/:id', async (req, reply) => {
    handle(reply, () => learn.deleteLesson(req.params.id));
    if (!reply.sent) return reply.code(204).send();
  });
}
