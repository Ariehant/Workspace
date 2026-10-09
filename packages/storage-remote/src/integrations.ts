/**
 * Internal integrations (Phase 6 M5). Each is a bot user (`users.kind = 'bot'`) in its
 * workspace with the "bot" role, so pages are shared with it as with a person, and has
 * one API token (`ntn_…`), shown once and stored as a hash. A bot can't sign in: it has
 * no password, and sessions are only looked up for people.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { hashSecret } from './accounts';

/** What an integration may do through the API. */
export interface Capabilities {
  readContent: boolean;
  updateContent: boolean;
  insertContent: boolean;
  readComments: boolean;
  insertComments: boolean;
  /** People: not at all, without their emails, or with them. */
  userInfo: 'none' | 'noEmail' | 'email';
}

export const DEFAULT_CAPABILITIES: Capabilities = {
  readContent: true,
  updateContent: true,
  insertContent: true,
  readComments: true,
  insertComments: true,
  userInfo: 'noEmail',
};

export interface Integration {
  /** Its bot user's id. */
  id: string;
  workspaceId: string;
  name: string;
  icon: string | null;
  capabilities: Capabilities;
  createdBy: string | null;
  createdAt: number;
  /** The token's last characters (null: none yet). */
  tokenHint: string | null;
  lastUsedAt: number | null;
}

interface Row {
  id: string;
  workspace_id: string;
  name: string;
  icon: string | null;
  capabilities: Capabilities;
  created_by: string | null;
  created_at: Date;
  hint: string | null;
  last_used_at: Date | null;
}

const toIntegration = (r: Row): Integration => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  icon: r.icon,
  capabilities: { ...DEFAULT_CAPABILITIES, ...r.capabilities },
  createdBy: r.created_by,
  createdAt: r.created_at.getTime(),
  tokenHint: r.hint,
  lastUsedAt: r.last_used_at?.getTime() ?? null,
});

const SELECT = `SELECT i.*, t.hint, t.last_used_at FROM integrations i
  LEFT JOIN integration_tokens t ON t.integration_id = i.id`;

/** Token prefix (as Notion's, so tools recognise them). */
export const TOKEN_PREFIX = 'ntn_';

/** A new token: the prefix and 32 random bytes. */
export const newIntegrationToken = () => `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

export class Integrations {
  constructor(private readonly pool: pg.Pool) {}

  async list(workspaceId: string): Promise<Integration[]> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT} WHERE i.workspace_id = $1 ORDER BY i.created_at, i.name`,
      [workspaceId],
    );
    return rows.map(toIntegration);
  }

  async get(workspaceId: string, id: string): Promise<Integration | null> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT} WHERE i.workspace_id = $1 AND i.id = $2`,
      [workspaceId, id],
    );
    return rows[0] ? toIntegration(rows[0]) : null;
  }

  /** A new integration: its bot user, membership, and its first token (returned once). */
  async create(input: {
    workspaceId: string;
    name: string;
    icon?: string | null;
    capabilities: Capabilities;
    createdBy: string;
  }): Promise<{ integration: Integration; token: string }> {
    const id = randomUUID();
    const token = newIntegrationToken();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, email, name, password_hash, is_admin, kind)
         VALUES ($1, $2, $3, NULL, false, 'bot')`,
        [id, `bot-${id}@integrations.invalid`, input.name],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'bot')`,
        [input.workspaceId, id],
      );
      await client.query(
        `INSERT INTO integrations (id, workspace_id, name, icon, capabilities, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          input.workspaceId,
          input.name,
          input.icon ?? null,
          input.capabilities,
          input.createdBy,
        ],
      );
      await client.query(
        `INSERT INTO integration_tokens (integration_id, token_hash, hint) VALUES ($1, $2, $3)`,
        [id, hashSecret(token), token.slice(-4)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { integration: (await this.get(input.workspaceId, id))!, token };
  }

  async update(
    workspaceId: string,
    id: string,
    changes: { name?: string; icon?: string | null; capabilities?: Capabilities },
  ): Promise<Integration | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE integrations SET name = coalesce($3, name),
         icon = CASE WHEN $4 THEN $5 ELSE icon END,
         capabilities = coalesce($6, capabilities)
       WHERE workspace_id = $1 AND id = $2`,
      [
        workspaceId,
        id,
        changes.name ?? null,
        changes.icon !== undefined,
        changes.icon ?? null,
        changes.capabilities ?? null,
      ],
    );
    if (!rowCount) return null;
    if (changes.name)
      await this.pool.query('UPDATE users SET name = $2 WHERE id = $1', [id, changes.name]);
    return this.get(workspaceId, id);
  }

  /** A new token; the old one stops working at once. Null if there's no such integration. */
  async rotate(workspaceId: string, id: string): Promise<string | null> {
    const token = newIntegrationToken();
    const { rowCount } = await this.pool.query(
      `INSERT INTO integration_tokens (integration_id, token_hash, hint)
       SELECT id, $3, $4 FROM integrations WHERE workspace_id = $1 AND id = $2
       ON CONFLICT (integration_id) DO UPDATE SET token_hash = excluded.token_hash,
         hint = excluded.hint, created_at = now(), last_used_at = NULL`,
      [workspaceId, id, hashSecret(token), token.slice(-4)],
    );
    return rowCount ? token : null;
  }

  /** Delete it: its bot user (and so its membership and token) and what was shared with it. */
  async remove(workspaceId: string, id: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        'DELETE FROM integrations WHERE workspace_id = $1 AND id = $2',
        [workspaceId, id],
      );
      if (rowCount) {
        await client.query('DELETE FROM scope_access WHERE principal = $1', [`user:${id}`]);
        await client.query(`DELETE FROM users WHERE id = $1 AND kind = 'bot'`, [id]);
      }
      await client.query('COMMIT');
      return (rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** The integration a token belongs to (and note it was used, at most once a minute). */
  async byToken(token: string): Promise<Integration | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const { rows } = await this.pool.query<Row>(`${SELECT} WHERE t.token_hash = $1`, [
      hashSecret(token),
    ]);
    const row = rows[0];
    if (!row) return null;
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
      await this.pool.query(
        'UPDATE integration_tokens SET last_used_at = now() WHERE integration_id = $1',
        [row.id],
      );
    }
    return toIntegration(row);
  }
}
