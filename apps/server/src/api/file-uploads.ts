/**
 * File uploads (Phase 8 #43), as Notion's API has them:
 *
 * - `POST /v1/file_uploads`, `{ filename, content_type?, mode? }`: a pending upload (only
 *   `single_part`), with the URL to send the file to, for an hour.
 * - `POST /v1/file_uploads/:id/send`: the file, as `multipart/form-data` (the part `file`), up
 *   to 20 MB. It's stored as the workspace's attachment (by its hash), once.
 * - `GET /v1/file_uploads/:id`: the upload as it is.
 *
 * A sent upload is then attached by its id: `{ type: "file_upload", file_upload: { id } }` in
 * image, video, audio, PDF and file blocks, and in files property values. An integration
 * sees only its own uploads.
 */
import multipart from '@fastify/multipart';
import { ApiError, parseId } from '@workspace/api-model';
import type { FileUpload } from '@workspace/storage-remote';
import { createHash, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { fileKey } from '../files';
import { decideMime } from '../files/sniff';
import { viewOf } from './plugin';
import type { ApiView } from './view';

/** Notion's limit for a single-part upload. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** A pending upload can be sent for this long. */
const PENDING_MS = 3600_000;

const invalid = (message: string) => new ApiError('validation_error', message);

const extensionOf = (name: string) => {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : '';
};

type Status = 'pending' | 'uploaded' | 'expired';
const statusOf = (u: FileUpload, now = Date.now()): Status =>
  u.fileId ? 'uploaded' : now - u.createdAt > PENDING_MS ? 'expired' : 'pending';

function uploadObject(api: ApiView, u: FileUpload) {
  const status = statusOf(u);
  const base = api.ctx.config.publicUrl;
  return {
    object: 'file_upload',
    id: u.id,
    created_time: new Date(u.createdAt).toISOString(),
    last_edited_time: new Date(u.uploadedAt ?? u.createdAt).toISOString(),
    expiry_time: status === 'pending' ? new Date(u.createdAt + PENDING_MS).toISOString() : null,
    upload_url: status === 'pending' ? `${base}/v1/file_uploads/${u.id}/send` : null,
    archived: false,
    status,
    filename: u.filename,
    content_type: u.contentType,
    content_length: u.size,
  };
}

async function uploadOf(api: ApiView, raw: string): Promise<FileUpload> {
  const id = parseId(raw);
  if (!id) throw invalid('path.file_upload_id should be a valid uuid.');
  const upload = await api.ctx.store.fileUploads.get(api.botId, id);
  if (!upload || upload.workspaceId !== api.workspaceId) {
    throw new ApiError('object_not_found', `Could not find file upload with ID: ${id}.`);
  }
  return upload;
}

export function fileUploadRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/file_uploads', async (request) => {
    const api = viewOf(request);
    api.need('insertContent');
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body !== 'object' || Array.isArray(body)) throw invalid('body should be an object.');
    const mode = body.mode ?? 'single_part';
    if (mode !== 'single_part') {
      throw invalid('body.mode: only "single_part" uploads (up to 20 MB) are supported.');
    }
    const filename = body.filename;
    if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) {
      throw invalid('body.filename should be a file name of 1 to 255 characters.');
    }
    const type = body.content_type;
    if (type !== undefined && (typeof type !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(type))) {
      throw invalid('body.content_type should be a MIME type.');
    }
    const upload = await api.ctx.store.fileUploads.create({
      workspaceId: api.workspaceId,
      integrationId: api.botId,
      filename: filename.trim(),
      contentType: type ?? null,
    });
    return uploadObject(api, upload);
  });

  app.get<{ Params: { id: string } }>('/file_uploads/:id', async (request) => {
    const api = viewOf(request);
    return uploadObject(api, await uploadOf(api, request.params.id));
  });

  // Sending the file: multipart, in a scope of its own (the rest of the API takes JSON).
  void app.register(async (scope) => {
    await scope.register(multipart, {
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 6 },
    });
    scope.post<{ Params: { id: string } }>(
      '/file_uploads/:id/send',
      { bodyLimit: MAX_UPLOAD_BYTES + 64 * 1024 },
      async (request) => {
        const api = viewOf(request);
        api.need('insertContent');
        const upload = await uploadOf(api, request.params.id);
        const status = statusOf(upload);
        if (status !== 'pending') {
          throw invalid(
            status === 'uploaded'
              ? 'This file upload has been sent already.'
              : 'This file upload expired: create a new one.',
          );
        }
        if (!request.isMultipart()) {
          throw invalid('Send the file as multipart/form-data, in a part named "file".');
        }
        let bytes: Buffer | null = null;
        let declared = upload.contentType ?? 'application/octet-stream';
        try {
          for await (const part of request.parts()) {
            if (part.type !== 'file') continue;
            if (part.fieldname !== 'file') {
              await part.toBuffer();
              continue;
            }
            bytes = await part.toBuffer();
            if (!upload.contentType && part.mimetype) declared = part.mimetype;
          }
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code === 'FST_REQ_FILE_TOO_LARGE') {
            throw invalid(`The file should be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
          }
          if (code?.startsWith('FST_')) throw invalid('The multipart body couldn’t be read.');
          throw error;
        }
        if (!bytes || bytes.byteLength === 0) {
          throw invalid('Send the file as multipart/form-data, in a part named "file".');
        }
        const fileId = `${createHash('sha256').update(bytes).digest('hex')}${extensionOf(upload.filename)}`;
        const mime = decideMime(declared, bytes.subarray(0, 64));
        const { store, files } = api.ctx;
        const key = fileKey(api.workspaceId, fileId);
        if (!(await files.has(key))) {
          const tmp = join(tmpdir(), `workspace-upload-${randomUUID()}`);
          try {
            await writeFile(tmp, bytes);
            await files.putFile(key, tmp, bytes.byteLength, mime);
          } finally {
            await rm(tmp, { force: true });
          }
        }
        await store.putFile(
          api.workspaceId,
          { id: fileId, name: upload.filename, mime, size: bytes.byteLength },
          api.botId,
        );
        if (!(await store.fileUploads.uploaded(upload.id, fileId, bytes.byteLength, mime))) {
          throw invalid('This file upload has been sent already.');
        }
        return uploadObject(api, (await store.fileUploads.get(api.botId, upload.id))!);
      },
    );
  });
}
