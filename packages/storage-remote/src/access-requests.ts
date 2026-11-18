import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** What someone may ask for (the rest is for the people who share to decide). */
export type RequestedRole = 'view' | 'comment' | 'edit';
export const REQUESTED_ROLES: readonly RequestedRole[] = ['view', 'comment', 'edit'];
export type AccessRequestStatus = 'pending' | 'approved' | 'declined';

export interface AccessRequest {
  id: string;
  workspaceId: string;
  pageId: string;
  requesterId: string;
  role: RequestedRole;
  message: string;
  status: AccessRequestStatus;
  createdAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

interface Row {
  id: string;
  workspace_id: string;
  page_id: string;
  requester_id: string;
  role: RequestedRole;
  message: string;
  status: AccessRequestStatus;
  created_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
}

const toRequest = (r: Row): AccessRequest => ({
  id: r.id,
  workspaceId: r.workspace_id,
  pageId: r.page_id,
  requesterId: r.requester_id,
  role: r.role,
  message: r.message,
  status: r.status,
  createdAt: r.created_at.getTime(),
  decidedBy: r.decided_by,
  decidedAt: r.decided_at?.getTime() ?? null,
});

/** Requests for access to a page (Phase 8 N4; see migration 15). */
export class AccessRequests {
  constructor(private readonly pool: pg.Pool) {}

  /** A new pending request; null if this person already has one pending for the page. */
  async create(input: {
    workspaceId: string;
    pageId: string;
    requesterId: string;
    role: RequestedRole;
    message: string;
  }): Promise<AccessRequest | null> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO access_requests (id, workspace_id, page_id, requester_id, role, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, page_id, requester_id) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [randomUUID(), input.workspaceId, input.pageId, input.requesterId, input.role, input.message],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  async get(workspaceId: string, id: string): Promise<AccessRequest | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM access_requests WHERE workspace_id = $1 AND id = $2',
      [workspaceId, id],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  /** This person's latest request for a page, if any. */
  async latest(
    workspaceId: string,
    pageId: string,
    requesterId: string,
  ): Promise<AccessRequest | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM access_requests
       WHERE workspace_id = $1 AND page_id = $2 AND requester_id = $3
       ORDER BY created_at DESC LIMIT 1`,
      [workspaceId, pageId, requesterId],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }

  /** Pending requests, for some pages (or all of the workspace's), oldest first. */
  async pending(workspaceId: string, pageIds: readonly string[] | null): Promise<AccessRequest[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM access_requests
       WHERE workspace_id = $1 AND status = 'pending'
         AND ($2::text[] IS NULL OR page_id = ANY($2::text[]))
       ORDER BY created_at`,
      [workspaceId, pageIds],
    );
    return rows.map(toRequest);
  }

  /** How many requests this person made since `since` (the rate limit). */
  async countSince(requesterId: string, since: Date): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM access_requests WHERE requester_id = $1 AND created_at >= $2',
      [requesterId, since],
    );
    return rows[0]?.n ?? 0;
  }

  /** Approve or decline a pending request; null if it isn't pending (any more). */
  async decide(
    workspaceId: string,
    id: string,
    status: 'approved' | 'declined',
    by: string,
  ): Promise<AccessRequest | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE access_requests SET status = $3, decided_by = $4, decided_at = now()
       WHERE workspace_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [workspaceId, id, status, by],
    );
    return rows[0] ? toRequest(rows[0]) : null;
  }
}
