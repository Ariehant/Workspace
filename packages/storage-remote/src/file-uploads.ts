/**
 * Files sent through the API (Phase 8 #43, Notion's file uploads): one is created, its bytes
 * are sent, and it's then attached to blocks or properties by its id. The bytes are stored as
 * the workspace's attachment (by hash), so the upload only names it.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export interface FileUpload {
  id: string;
  workspaceId: string;
  integrationId: string;
  filename: string;
  contentType: string | null;
  /** The stored attachment's id, once sent. */
  fileId: string | null;
  size: number | null;
  createdAt: number;
  uploadedAt: number | null;
}

interface FileUploadRow {
  id: string;
  workspace_id: string;
  integration_id: string;
  filename: string;
  content_type: string | null;
  file_id: string | null;
  size: string | null;
  created_at: Date;
  uploaded_at: Date | null;
}

const toUpload = (r: FileUploadRow): FileUpload => ({
  id: r.id,
  workspaceId: r.workspace_id,
  integrationId: r.integration_id,
  filename: r.filename,
  contentType: r.content_type,
  fileId: r.file_id,
  size: r.size === null ? null : Number(r.size),
  createdAt: r.created_at.getTime(),
  uploadedAt: r.uploaded_at?.getTime() ?? null,
});

export class FileUploads {
  constructor(private readonly pool: pg.Pool) {}

  async create(input: {
    workspaceId: string;
    integrationId: string;
    filename: string;
    contentType: string | null;
  }): Promise<FileUpload> {
    const { rows } = await this.pool.query<FileUploadRow>(
      `INSERT INTO api_file_uploads (id, workspace_id, integration_id, filename, content_type)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), input.workspaceId, input.integrationId, input.filename, input.contentType],
    );
    return toUpload(rows[0]!);
  }

  /** An integration's upload (another's, or another workspace's, isn't found). */
  async get(integrationId: string, id: string): Promise<FileUpload | null> {
    const { rows } = await this.pool.query<FileUploadRow>(
      'SELECT * FROM api_file_uploads WHERE id = $1 AND integration_id = $2',
      [id, integrationId],
    );
    return rows[0] ? toUpload(rows[0]) : null;
  }

  /** Several of an integration's uploads, by id. */
  async many(integrationId: string, ids: readonly string[]): Promise<FileUpload[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<FileUploadRow>(
      'SELECT * FROM api_file_uploads WHERE integration_id = $1 AND id = ANY($2::uuid[])',
      [integrationId, ids],
    );
    return rows.map(toUpload);
  }

  /** Its bytes arrived (once: a sent upload isn't sent again). */
  async uploaded(id: string, fileId: string, size: number, contentType: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE api_file_uploads SET file_id = $2, size = $3, content_type = $4, uploaded_at = now()
       WHERE id = $1 AND uploaded_at IS NULL`,
      [id, fileId, size, contentType],
    );
    return (rowCount ?? 0) > 0;
  }
}
