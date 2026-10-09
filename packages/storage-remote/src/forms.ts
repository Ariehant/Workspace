/**
 * Public form links (Phase 6 M2): a form view shared "with anyone with the link" has a
 * random token here. The token lives only on the server (never in the doc), so making
 * a new link turns the old one off at once.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export interface FormLink {
  token: string;
  workspaceId: string;
  databaseId: string;
  viewId: string;
  createdBy: string | null;
  createdAt: number;
}

interface FormLinkRow {
  token: string;
  workspace_id: string;
  database_id: string;
  view_id: string;
  created_by: string | null;
  created_at: Date;
}

const toLink = (r: FormLinkRow): FormLink => ({
  token: r.token,
  workspaceId: r.workspace_id,
  databaseId: r.database_id,
  viewId: r.view_id,
  createdBy: r.created_by,
  createdAt: r.created_at.getTime(),
});

/** 128 bits, URL-safe. */
export const newFormToken = () => randomBytes(16).toString('base64url');

export class FormLinks {
  constructor(private readonly pool: pg.Pool) {}

  async get(workspaceId: string, databaseId: string, viewId: string): Promise<FormLink | null> {
    const { rows } = await this.pool.query<FormLinkRow>(
      `SELECT * FROM form_links WHERE workspace_id = $1 AND database_id = $2 AND view_id = $3`,
      [workspaceId, databaseId, viewId],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  async byToken(token: string): Promise<FormLink | null> {
    const { rows } = await this.pool.query<FormLinkRow>(
      'SELECT * FROM form_links WHERE token = $1',
      [token],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  /** A new link for the form (replacing its old one, which stops working). */
  async create(
    workspaceId: string,
    databaseId: string,
    viewId: string,
    createdBy: string,
  ): Promise<FormLink> {
    const { rows } = await this.pool.query<FormLinkRow>(
      `INSERT INTO form_links (token, workspace_id, database_id, view_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, database_id, view_id)
       DO UPDATE SET token = excluded.token, created_by = excluded.created_by,
         created_at = now()
       RETURNING *`,
      [newFormToken(), workspaceId, databaseId, viewId, createdBy],
    );
    return toLink(rows[0]!);
  }

  async remove(workspaceId: string, databaseId: string, viewId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM form_links WHERE workspace_id = $1 AND database_id = $2 AND view_id = $3`,
      [workspaceId, databaseId, viewId],
    );
  }
}
