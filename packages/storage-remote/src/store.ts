import { randomUUID } from 'node:crypto';
import pg from 'pg';
import * as Y from 'yjs';
import { Accounts } from './accounts';
import { migrate } from './migrations';
import { SearchIndex } from './search';

/** One stored update of the workspace log. */
export interface LoggedUpdate {
  seq: number;
  docId: string;
  data: Uint8Array;
  /** The device that pushed it (null for compacted rows). */
  deviceId: string | null;
}

export interface NewUpdate {
  docId: string;
  data: Uint8Array;
  deviceId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: Date;
}

export type MemberRole = 'owner' | 'admin' | 'member' | 'guest';

export interface FileMeta {
  id: string;
  name: string;
  mime: string;
  size: number;
}

// bigint (int8) as a JS number: seq values stay far below 2^53.
pg.types.setTypeParser(20, (value) => Number(value));

const toBytes = (data: Buffer) => new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

/**
 * The server's storage in Postgres. Every doc read and write is scoped to a workspace:
 * a doc id means nothing outside its workspace.
 */
export class PgStore {
  readonly pool: pg.Pool;
  readonly accounts: Accounts;
  readonly search: SearchIndex;

  constructor(connectionString: string, options: { max?: number } = {}) {
    this.pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
    // A dropped connection must not crash the server; the pool replaces it.
    this.pool.on('error', () => {});
    this.accounts = new Accounts(this.pool);
    this.search = new SearchIndex(this.pool);
  }

  migrate(): Promise<number> {
    return migrate(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Run `fn` in one transaction. */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Workspaces -------------------------------------------------------------------

  async createWorkspace(name: string, ownerId: string | null): Promise<Workspace> {
    const id = randomUUID();
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ id: string; name: string; created_at: Date }>(
        'INSERT INTO workspaces (id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name, created_at',
        [id, name, ownerId],
      );
      if (ownerId) {
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [id, ownerId],
        );
      }
      const row = rows[0]!;
      return { id: row.id, name: row.name, createdAt: row.created_at };
    });
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const { rows } = await this.pool.query<{ id: string; name: string; created_at: Date }>(
      'SELECT id, name, created_at FROM workspaces WHERE id = $1',
      [id],
    );
    const row = rows[0];
    return row ? { id: row.id, name: row.name, createdAt: row.created_at } : null;
  }

  async renameWorkspace(id: string, name: string): Promise<void> {
    await this.pool.query('UPDATE workspaces SET name = $2 WHERE id = $1', [id, name]);
  }

  /** The workspaces a user belongs to, with their role. */
  async workspacesOf(userId: string): Promise<(Workspace & { role: MemberRole })[]> {
    const { rows } = await this.pool.query<{
      id: string;
      name: string;
      created_at: Date;
      role: MemberRole;
    }>(
      `SELECT w.id, w.name, w.created_at, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = $1 ORDER BY w.created_at`,
      [userId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, role: r.role }));
  }

  async roleOf(workspaceId: string, userId: string): Promise<MemberRole | null> {
    const { rows } = await this.pool.query<{ role: MemberRole }>(
      'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
      [workspaceId, userId],
    );
    return rows[0]?.role ?? null;
  }

  // --- The update log ----------------------------------------------------------------

  /**
   * Append updates (in order) and return their seqs. The workspace row is locked while
   * seqs are handed out, so concurrent appends get distinct, gapless, ordered numbers.
   */
  async appendUpdates(workspaceId: string, updates: readonly NewUpdate[]): Promise<number[]> {
    if (updates.length === 0) return [];
    return this.transaction(async (client) => {
      const { rows } = await client.query<{ last_seq: number }>(
        'UPDATE workspaces SET last_seq = last_seq + $2 WHERE id = $1 RETURNING last_seq',
        [workspaceId, updates.length],
      );
      if (!rows[0]) throw new Error(`Unknown workspace ${workspaceId}`);
      const first = rows[0].last_seq - updates.length + 1;
      const seqs = updates.map((_, i) => first + i);
      await client.query(
        `INSERT INTO doc_updates (workspace_id, seq, doc_id, data, device_id)
         SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::bytea[], $5::text[])`,
        [
          workspaceId,
          seqs,
          updates.map((u) => u.docId),
          updates.map((u) => Buffer.from(u.data)),
          updates.map((u) => u.deviceId ?? null),
        ],
      );
      return seqs;
    });
  }

  /** Updates stored after `cursor`, oldest first (at most `limit`). */
  async updatesSince(workspaceId: string, cursor: number, limit = 500): Promise<LoggedUpdate[]> {
    const { rows } = await this.pool.query<{
      seq: number;
      doc_id: string;
      data: Buffer;
      device_id: string | null;
    }>(
      `SELECT seq, doc_id, data, device_id FROM doc_updates
       WHERE workspace_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [workspaceId, cursor, limit],
    );
    return rows.map((r) => ({
      seq: r.seq,
      docId: r.doc_id,
      data: toBytes(r.data),
      deviceId: r.device_id,
    }));
  }

  /** The newest seq of a workspace (0 when nothing is stored). */
  async latestSeq(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ last_seq: number }>(
      'SELECT last_seq FROM workspaces WHERE id = $1',
      [workspaceId],
    );
    return rows[0]?.last_seq ?? 0;
  }

  /** A doc's full state (all its updates merged), or null if nothing is stored. */
  async docState(workspaceId: string, docId: string): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query<{ data: Buffer }>(
      'SELECT data FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 ORDER BY seq',
      [workspaceId, docId],
    );
    if (rows.length === 0) return null;
    return Y.mergeUpdates(rows.map((r) => toBytes(r.data)));
  }

  /** Docs with more than `threshold` stored updates (candidates for compaction). */
  async docsToCompact(workspaceId: string, threshold: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ doc_id: string }>(
      `SELECT doc_id FROM doc_updates WHERE workspace_id = $1
       GROUP BY doc_id HAVING count(*) > $2`,
      [workspaceId, threshold],
    );
    return rows.map((r) => r.doc_id);
  }

  /**
   * Replace a doc's updates with one merged update under a new seq. Devices that had seen
   * some of the old ones get the merged state again (harmless: Yjs ignores what it has);
   * devices behind still get everything. Returns the new seq, or null if nothing changed.
   */
  async compactDoc(workspaceId: string, docId: string): Promise<number | null> {
    return this.transaction(async (client) => {
      // Lock the counter first: no append can slip in between reading and replacing.
      await client.query('SELECT last_seq FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
      const { rows } = await client.query<{ seq: number; data: Buffer }>(
        'SELECT seq, data FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 ORDER BY seq',
        [workspaceId, docId],
      );
      if (rows.length < 2) return null;
      const merged = Y.mergeUpdates(rows.map((r) => toBytes(r.data)));
      const { rows: next } = await client.query<{ last_seq: number }>(
        'UPDATE workspaces SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq',
        [workspaceId],
      );
      const seq = next[0]!.last_seq;
      await client.query(
        'DELETE FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])',
        [workspaceId, docId, rows.map((r) => r.seq)],
      );
      await client.query(
        'INSERT INTO doc_updates (workspace_id, seq, doc_id, data) VALUES ($1, $2, $3, $4)',
        [workspaceId, seq, docId, Buffer.from(merged)],
      );
      return seq;
    });
  }

  // --- Files -------------------------------------------------------------------------

  async putFile(workspaceId: string, file: FileMeta, uploadedBy: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO files (workspace_id, id, name, mime, size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (workspace_id, id) DO NOTHING`,
      [workspaceId, file.id, file.name, file.mime, file.size, uploadedBy],
    );
  }

  async getFile(workspaceId: string, id: string): Promise<FileMeta | null> {
    const { rows } = await this.pool.query<FileMeta>(
      'SELECT id, name, mime, size FROM files WHERE workspace_id = $1 AND id = $2',
      [workspaceId, id],
    );
    return rows[0] ?? null;
  }

  /** Bytes of attachments stored for a workspace. */
  async storageUsed(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string | null }>(
      'SELECT sum(size)::text AS total FROM files WHERE workspace_id = $1',
      [workspaceId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
