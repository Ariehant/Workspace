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
import { FILE_ID, fileKey, type ByteRange } from './files';
import { decideMime } from './files/sniff';

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

/** Bytes kept from the start of an upload, to tell what it is. */
const HEAD_BYTES = 512;

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
      if (!meta) return fail(reply, 404, 'not_found', 'No such file.');
      const etag = `"${fileId}"`;
      const filename = encodeURIComponent(meta.name);
      reply
        .header('etag', etag)
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('x-content-type-options', 'nosniff')
        // Served from our own origin: whatever it is, it can't run as our page.
        .header('content-security-policy', "sandbox; default-src 'none'")
        .header('x-file-name', filename)
        .header(
          'content-disposition',
          `${ACTIVE.test(meta.mime) ? 'attachment' : 'inline'}; filename*=UTF-8''${filename}`,
        );
      // Content-addressed: the same id is always the same bytes.
      if (request.headers['if-none-match']?.split(/\s*,\s*/).includes(etag)) {
        return reply.code(304).send();
      }
      const range = parseRange(request.headers.range, meta.size);
      if (range === 'unsatisfiable') {
        return reply.code(416).header('content-range', `bytes */${meta.size}`).send();
      }
      const stored = await files.get(fileKey(id, fileId), range ?? undefined);
      if (!stored) return fail(reply, 404, 'not_found', 'No such file.');
      reply.header('content-type', meta.mime);
      if (range) {
        return reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${stored.size}`)
          .header('content-length', range.end - range.start + 1)
          .send(stored.body);
      }
      return reply.header('content-length', stored.size).send(stored.body);
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
      let mime = String(request.headers['x-file-mime'] || 'application/octet-stream').slice(0, 100);

      if ((await store.getFile(id, fileId)) && (await files.has(fileKey(id, fileId)))) {
        request.body.resume();
        return reply.code(200).send({ id: fileId, existed: true });
      }

      const tmp = join(tmpdir(), `workspace-upload-${randomUUID()}`);
      const hash = createHash('sha256');
      let size: number;
      try {
        const head: Buffer[] = [];
        size = await saveLimited(request.body, tmp, config.maxFileBytes, hash, head);
        if (!fileId.startsWith(hash.digest('hex'))) {
          return fail(reply, 400, 'hash_mismatch', "The file's content doesn't match its id.");
        }
        // Stored as what the content is, not what the client said it is.
        mime = decideMime(mime, Buffer.concat(head));
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
function saveLimited(
  body: Readable,
  path: string,
  limit: number,
  hash: Hash,
  head: Buffer[],
): Promise<number> {
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
      if (size < HEAD_BYTES) head.push(chunk.subarray(0, HEAD_BYTES - size));
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

/**
 * One `bytes=` range (video seeking), clamped to the file. Null means the whole file
 * (no header, or one we don't support, like several ranges).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null | 'unsatisfiable' {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    // The last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
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
