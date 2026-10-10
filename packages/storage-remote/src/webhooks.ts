/**
 * Integration webhooks (Phase 6 M7): each integration may have one subscription, a URL
 * and the events it wants, as in Notion. Deliveries start once it is verified (the token
 * POSTed to the URL is pasted back), and the token signs them.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export interface IntegrationWebhook {
  integrationId: string;
  workspaceId: string;
  url: string;
  events: string[];
  verified: boolean;
  /** Events are for changes after this log position (null: not verified yet). */
  fromSeq: number | null;
  pausedAt: number | null;
  failingSince: number | null;
  lastError: string | null;
  createdAt: number;
}

interface Row {
  integration_id: string;
  workspace_id: string;
  url: string;
  events: string[];
  verification_token: string;
  verified_at: Date | null;
  from_seq: string | number | null;
  paused_at: Date | null;
  failing_since: Date | null;
  last_error: string | null;
  created_at: Date;
}

const toWebhook = (r: Row): IntegrationWebhook => ({
  integrationId: r.integration_id,
  workspaceId: r.workspace_id,
  url: r.url,
  events: r.events,
  verified: r.verified_at !== null,
  fromSeq: r.from_seq === null ? null : Number(r.from_seq),
  pausedAt: r.paused_at?.getTime() ?? null,
  failingSince: r.failing_since?.getTime() ?? null,
  lastError: r.last_error,
  createdAt: r.created_at.getTime(),
});

/** A verification token, in Notion's form. */
export const newVerificationToken = () => `secret_${randomBytes(24).toString('base64url')}`;

export class IntegrationWebhooks {
  constructor(private readonly pool: pg.Pool) {}

  async get(workspaceId: string, integrationId: string): Promise<IntegrationWebhook | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM integration_webhooks WHERE workspace_id = $1 AND integration_id = $2',
      [workspaceId, integrationId],
    );
    return rows[0] ? toWebhook(rows[0]) : null;
  }

  /** The subscription and its signing secret (for deliveries). */
  async withSecret(
    workspaceId: string,
    integrationId: string,
  ): Promise<{ webhook: IntegrationWebhook; secret: string } | null> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM integration_webhooks WHERE workspace_id = $1 AND integration_id = $2',
      [workspaceId, integrationId],
    );
    const row = rows[0];
    return row ? { webhook: toWebhook(row), secret: row.verification_token } : null;
  }

  async list(workspaceId: string): Promise<IntegrationWebhook[]> {
    const { rows } = await this.pool.query<Row>(
      'SELECT * FROM integration_webhooks WHERE workspace_id = $1',
      [workspaceId],
    );
    return rows.map(toWebhook);
  }

  /** Verified, not paused: those events are made for. */
  async active(workspaceId: string): Promise<IntegrationWebhook[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM integration_webhooks
       WHERE workspace_id = $1 AND verified_at IS NOT NULL AND paused_at IS NULL`,
      [workspaceId],
    );
    return rows.map(toWebhook);
  }

  /**
   * Set the URL and events. A new URL needs verifying again (with a new token, returned
   * to be sent to it); otherwise only the events change (null returned).
   */
  async set(
    workspaceId: string,
    integrationId: string,
    url: string,
    events: readonly string[],
  ): Promise<{ webhook: IntegrationWebhook; token: string | null }> {
    const existing = await this.get(workspaceId, integrationId);
    if (existing && existing.url === url) {
      const { rows } = await this.pool.query<Row>(
        `UPDATE integration_webhooks SET events = $3
         WHERE workspace_id = $1 AND integration_id = $2 RETURNING *`,
        [workspaceId, integrationId, events],
      );
      return { webhook: toWebhook(rows[0]!), token: null };
    }
    const token = newVerificationToken();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO integration_webhooks (integration_id, workspace_id, url, events, verification_token)
       VALUES ($2, $1, $3, $4, $5)
       ON CONFLICT (integration_id) DO UPDATE SET url = excluded.url, events = excluded.events,
         verification_token = excluded.verification_token, verified_at = NULL, from_seq = NULL,
         paused_at = NULL, failing_since = NULL, last_error = NULL, created_at = now()
       RETURNING *`,
      [workspaceId, integrationId, url, events, token],
    );
    return { webhook: toWebhook(rows[0]!), token };
  }

  /** Turn deliveries on with the token sent to the URL. False if it isn't that token. */
  async verify(workspaceId: string, integrationId: string, token: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE integration_webhooks w SET verified_at = now(),
         from_seq = (SELECT last_seq FROM workspaces WHERE id = w.workspace_id)
       WHERE workspace_id = $1 AND integration_id = $2 AND verification_token = $3`,
      [workspaceId, integrationId, token],
    );
    return (rowCount ?? 0) > 0;
  }

  async remove(workspaceId: string, integrationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM integration_webhooks WHERE workspace_id = $1 AND integration_id = $2',
      [workspaceId, integrationId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** A delivery went through: no longer failing. */
  async delivered(workspaceId: string, integrationId: string): Promise<void> {
    await this.pool.query(
      `UPDATE integration_webhooks SET failing_since = NULL, last_error = NULL
       WHERE workspace_id = $1 AND integration_id = $2 AND failing_since IS NOT NULL`,
      [workspaceId, integrationId],
    );
  }

  /**
   * A delivery failed for good. Returns since when deliveries have been failing (now, if
   * this is the first).
   */
  async failed(workspaceId: string, integrationId: string, error: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ failing_since: Date }>(
      `UPDATE integration_webhooks SET failing_since = coalesce(failing_since, now()),
         last_error = $3
       WHERE workspace_id = $1 AND integration_id = $2 RETURNING failing_since`,
      [workspaceId, integrationId, error.slice(0, 500)],
    );
    return rows[0]?.failing_since.getTime() ?? null;
  }

  /** Stop deliveries (until resumed). True if it was running. */
  async pause(workspaceId: string, integrationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE integration_webhooks SET paused_at = now()
       WHERE workspace_id = $1 AND integration_id = $2 AND paused_at IS NULL`,
      [workspaceId, integrationId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Deliveries again, for changes from now on. */
  async resume(workspaceId: string, integrationId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE integration_webhooks w SET paused_at = NULL, failing_since = NULL, last_error = NULL,
         from_seq = (SELECT last_seq FROM workspaces WHERE id = w.workspace_id)
       WHERE workspace_id = $1 AND integration_id = $2 AND paused_at IS NOT NULL`,
      [workspaceId, integrationId],
    );
    return (rowCount ?? 0) > 0;
  }
}
