import { createReadStream } from 'node:fs';
import { extname } from 'node:path';
import {
  MAX_UPLOAD_BYTES,
  apiError,
  fileLocationSchema,
  fileMkdirRequestSchema,
  fileRenameRequestSchema,
  fileSaveRequestSchema,
  fileUploadQuerySchema,
} from '@agenta/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { FilesService } from './service';
import { FilesError, fsError } from './store';

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
    const mapped = fsError(err);
    if (mapped instanceof FilesError) {
      void reply.code(mapped.statusCode).send(apiError(mapped.code, mapped.message));
      return undefined;
    }
    throw err;
  }
}

/**
 * Types the browser may render inline (previews). Everything else is served as a download, so a bot-written HTML
 * file can never run script on the app's origin. SVG gets a sandboxing CSP for the same reason.
 */
const INLINE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266 / 5987). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const rawQuerySchema = fileLocationSchema.extend({
  download: z.enum(['1', '0', 'true', 'false']).optional(),
});

/**
 * GET /api/bots/:id/files?root=&path= (folder listing), GET /files/content (text), GET /files/raw (bytes; preview
 * or `download=1`), PUT /files/content (save), POST /files/upload (raw bytes), POST /files/mkdir,
 * POST /files/rename, DELETE /files?root=&path=. `root` is `home` (the bot's /home/bot) or `shared` (/shared).
 */
export async function registerFileRoutes(app: FastifyInstance, files: FilesService): Promise<void> {
  app.get<IdParams>('/api/bots/:id/files', async (req, reply) => {
    const q = parse(fileLocationSchema, req.query, reply, 'invalid_query');
    if (!q) return;
    return handle(reply, () => files.list(req.params.id, q.root, q.path));
  });

  app.get<IdParams>('/api/bots/:id/files/content', async (req, reply) => {
    const q = parse(fileLocationSchema, req.query, reply, 'invalid_query');
    if (!q) return;
    return handle(reply, () => files.read(req.params.id, q.root, q.path));
  });

  app.get<IdParams>('/api/bots/:id/files/raw', async (req, reply) => {
    const q = parse(rawQuerySchema, req.query, reply, 'invalid_query');
    if (!q) return;
    const file = await handle(reply, () => files.raw(req.params.id, q.root, q.path));
    if (!file) return;
    const inlineType = INLINE_TYPES[extname(file.name).toLowerCase()];
    const download = q.download === '1' || q.download === 'true' || !inlineType;
    void reply
      .header('content-type', download ? 'application/octet-stream' : inlineType)
      .header('content-length', String(file.size))
      .header('content-disposition', contentDisposition(download ? 'attachment' : 'inline', file.name))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store');
    if (inlineType === 'image/svg+xml') {
      void reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    }
    return reply.send(createReadStream(file.real));
  });

  app.put<IdParams>('/api/bots/:id/files/content', async (req, reply) => {
    const body = parse(fileSaveRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const entry = await handle(reply, () =>
      files.save(req.params.id, body.root, body.path, body.content, body.expectedModifiedAt),
    );
    if (entry) return { entry };
  });

  app.post<IdParams>('/api/bots/:id/files/mkdir', async (req, reply) => {
    const body = parse(fileMkdirRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const entry = await handle(reply, () => files.mkdir(req.params.id, body.root, body.path));
    if (entry) return reply.code(201).send({ entry });
  });

  app.post<IdParams>('/api/bots/:id/files/rename', async (req, reply) => {
    const body = parse(fileRenameRequestSchema, req.body, reply, 'invalid_body');
    if (!body) return;
    const entry = await handle(reply, () => files.rename(req.params.id, body.root, body.from, body.to));
    if (entry) return { entry };
  });

  app.delete<IdParams>('/api/bots/:id/files', async (req, reply) => {
    const q = parse(fileLocationSchema, req.query, reply, 'invalid_query');
    if (!q) return;
    const done = await handle(reply, () => {
      files.remove(req.params.id, q.root, q.path);
      return true;
    });
    if (done) return reply.code(204).send();
  });

  // Binary uploads get their own scope so the octet-stream parser and the larger body limit stay local.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post<IdParams>(
      '/api/bots/:id/files/upload',
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (req, reply) => {
        const q = parse(fileUploadQuerySchema, req.query, reply, 'invalid_query');
        if (!q) return;
        if (!Buffer.isBuffer(req.body)) {
          return reply
            .code(415)
            .send(apiError('unsupported_media_type', 'Send the file as application/octet-stream'));
        }
        const data = req.body;
        const entry = await handle(reply, () =>
          files.upload(req.params.id, q.root, q.path, q.name, data, q.overwrite),
        );
        if (entry) return reply.code(201).send({ entry });
      },
    );
  });
}
