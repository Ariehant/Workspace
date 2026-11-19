/**
 * Share links (Phase 8 N8, #34): a page opened to anyone with the link, who signs in to use
 * it and joins the workspace as a guest with the link's role on that page. One link per page;
 * making a new one ends the old, and so does turning it off.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';

export type ShareLinkRole = 'view' | 'comment' | 'edit';
export const SHARE_LINK_ROLES: readonly ShareLinkRole[] = ['view', 'comment', 'edit'];

export interface ShareLink {
  id: string;
  workspaceId: string;
  pageId: string;
  token: string;
  role: ShareLinkRole;
  /** The page's title when the link was made (shown before signing in). */
  title: string;
  expiresAt: number | null;
  createdBy: string | null;
  createdAt: number;
}

interface ShareLinkRow {
  id: string;
  workspace_id: string;
  page_id: string;
  token: string;
  role: ShareLinkRole;
  title: string;
  expires_at: Date | null;
  created_by: string | null;
  created_at: Date;
}

const toLink = (r: ShareLinkRow): ShareLink => ({
  id: r.id,
  workspaceId: r.workspace_id,
  pageId: r.page_id,
  token: r.token,
  role: r.role,
  title: r.title,
  expiresAt: r.expires_at?.getTime() ?? null,
  createdBy: r.created_by,
  createdAt: r.created_at.getTime(),
});

/** 128 bits, URL-safe. */
const newToken = () => randomBytes(16).toString('base64url');

export class ShareLinks {
  constructor(private readonly pool: pg.Pool) {}

  async get(workspaceId: string, pageId: string): Promise<ShareLink | null> {
    const { rows } = await this.pool.query<ShareLinkRow>(
      'SELECT * FROM share_links WHERE workspace_id = $1 AND page_id = $2',
      [workspaceId, pageId],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  async byToken(token: string): Promise<ShareLink | null> {
    const { rows } = await this.pool.query<ShareLinkRow>(
      'SELECT * FROM share_links WHERE token = $1',
      [token],
    );
    return rows[0] ? toLink(rows[0]) : null;
  }

  /** A new link for the page (replacing its old one, which stops working). */
  async create(link: {
    workspaceId: string;
    pageId: string;
    role: ShareLinkRole;
    title: string;
    expiresAt: number | null;
    createdBy: string;
  }): Promise<ShareLink> {
    const { rows } = await this.pool.query<ShareLinkRow>(
      `INSERT INTO share_links (id, workspace_id, page_id, token, role, title, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id, page_id)
       DO UPDATE SET id = excluded.id, token = excluded.token, role = excluded.role,
         title = excluded.title, expires_at = excluded.expires_at,
         created_by = excluded.created_by, created_at = now()
       RETURNING *`,
      [
        randomUUID(),
        link.workspaceId,
        link.pageId,
        newToken(),
        link.role,
        link.title,
        link.expiresAt === null ? null : new Date(link.expiresAt),
        link.createdBy,
      ],
    );
    return toLink(rows[0]!);
  }

  /** Turn the page's link off. True if there was one. */
  async remove(workspaceId: string, pageId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM share_links WHERE workspace_id = $1 AND page_id = $2',
      [workspaceId, pageId],
    );
    return (rowCount ?? 0) > 0;
  }
}
