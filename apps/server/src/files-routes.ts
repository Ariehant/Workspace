/**
 * Attachments of a workspace: `HEAD`/`GET`/`PUT /api/workspaces/<id>/files/<file id>`.
 * File ids are content hashes (`<sha256>.<ext>`), so an upload is checked against its id
 * and uploading the same file twice is a no-op.
 */
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';
import { FILE_ID, fileKey } from './files';

const params = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    fileId: { type: 'string', pattern: FILE_ID.source },
  },
} as const;

/** Types a browser could run as a page or script: always downloaded, never shown inline. */
const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml)/i;

class TooLarge extends Error {}

export function fileRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store, files, config } = ctx;

  // Uploads arrive as raw bytes; the handler streams them (no buffering in memory).
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
    done(null, payload),
  );

  async function access(request: FastifyRequest<{ Params: { id: string } }>) {
    return store.roleOf(request.params.id, request.auth!.user.id);
  }

  app.get<{ Params: { id: string; fileId: string } }>(
    '/api/workspaces/:id/files/:fileId',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await access(request))) return fail(reply, 404, 'not_found', 'No such file.');
      const { id, fileId } = request.params;
      const meta = await store.getFile(id, fileId);
      const stored = meta ? await files.get(fileKey(id, fileId)) : null;
      if (!meta || !stored) return fail(reply, 404, 'not_found', 'No such file.');
      const filename = encodeURIComponent(meta.name);
      return (
        reply
          .header('content-type', meta.mime)
          .header('content-length', stored.size)
          .header('x-file-name', filename)
          .header('etag', `"${fileId}"`)
          .header('cache-control', 'private, max-age=31536000, immutable')
          .header('x-content-type-options', 'nosniff')
          // Served from our own origin: whatever it is, it can't run as our page.
          .header('content-security-policy', "sandbox; default-src 'none'")
          .header(
            'content-disposition',
            `${ACTIVE.test(meta.mime) ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`,
          )
          .send(stored.body)
      );
    },
  );

  app.put<{ Params: { id: string; fileId: string }; Body: Readable }>(
    '/api/workspaces/:id/files/:fileId',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      const role = await access(request);
      if (!role) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (role === 'guest') return fail(reply, 403, 'forbidden', 'You can only read here.');
      if (request.headers['content-type'] !== 'application/octet-stream') {
        return fail(reply, 415, 'invalid', 'Send the file as application/octet-stream.');
      }
      const { id, fileId } = request.params;
      const name = decodeHeader(request.headers['x-file-name']) || 'Untitled';
      const mime = String(request.headers['x-file-mime'] || 'application/octet-stream').slice(
        0,
        100,
      );

      if ((await store.getFile(id, fileId)) && (await files.has(fileKey(id, fileId)))) {
        request.body.resume();
        return reply.code(200).send({ id: fileId, existed: true });
      }

      const tmp = join(tmpdir(), `workspace-upload-${randomUUID()}`);
      const hash = createHash('sha256');
      let size: number;
      try {
        size = await saveLimited(request.body, tmp, config.maxFileBytes, hash);
        if (!fileId.startsWith(hash.digest('hex'))) {
          return fail(reply, 400, 'hash_mismatch', "The file's content doesn't match its id.");
        }
        await files.putFile(fileKey(id, fileId), tmp, size, mime);
        await store.putFile(id, { id: fileId, name, mime, size }, request.auth!.user.id);
        return reply.code(201).send({ id: fileId, existed: false });
      } catch (error) {
        if (error instanceof TooLarge) {
          return tooLarge(reply, config.maxFileBytes);
        }
        throw error;
      } finally {
        await rm(tmp, { force: true });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/storage',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      },
    },
    async (request, reply) => {
      if (!(await access(request))) return fail(reply, 404, 'not_found', 'No such workspace.');
      return { bytes: await store.storageUsed(request.params.id) };
    },
  );
}

/**
 * Write a request body to `path`, hashing it, and stop (TooLarge) past `limit` bytes.
 * Returns the size.
 */
function saveLimited(body: Readable, path: string, limit: number, hash: Hash): Promise<number> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    let size = 0;
    let done = false;
    const finish = (error: Error | null) => {
      if (done) return;
      done = true;
      body.off('data', onData);
      if (error) {
        body.pause();
        out.destroy();
        reject(error);
      } else out.end(() => resolve(size));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) return finish(new TooLarge());
      hash.update(chunk);
      // Backpressure: wait for the disk before reading more.
      if (!out.write(chunk)) {
        body.pause();
        out.once('drain', () => body.resume());
      }
    };
    body.on('data', onData);
    body.once('end', () => finish(null));
    body.once('error', (error) => finish(error));
    out.once('error', (error) => finish(error));
  });
}

function decodeHeader(value: string | string[] | undefined): string {
  if (typeof value !== 'string') return '';
  try {
    return decodeURIComponent(value).slice(0, 255);
  } catch {
    return '';
  }
}

function tooLarge(reply: FastifyReply, limit: number) {
  reply.header('connection', 'close');
  return fail(
    reply,
    413,
    'too_large',
    `Files can be at most ${Math.floor(limit / 1024 / 1024)} MB.`,
  );
}
