import type pg from 'pg';

export interface IndexedPage {
  id: string;
  title: string;
  icon: string | null;
  inTrash: boolean;
  updatedAt: number;
}

export interface IndexedRow extends IndexedPage {
  /** Text of the row's properties. */
  props: string;
}

export interface SearchHit {
  id: string;
  title: string;
  icon: string | null;
  /** For a database row, its database; null for pages. */
  databaseId: string | null;
  /** The matching excerpt, hits wrapped in `[` `]` (like the desktop's quick find). */
  snippet: string;
}

/** Turn typed text into a prefix query on every word (`robo arm` → `robo:* & arm:*`). */
export function toTsQuery(input: string): string | null {
  const words = input.toLowerCase().match(/[\p{L}\p{N}_]+/gu);
  if (!words) return null;
  return words
    .slice(0, 20)
    .map((w) => `${w}:*`)
    .join(' & ');
}

/** The full-text search index of each workspace (see migration 3). */
export class SearchIndex {
  constructor(private readonly pool: pg.Pool) {}

  async indexedSeq(workspaceId: string): Promise<number> {
    const { rows } = await this.pool.query<{ indexed_seq: number }>(
      'SELECT indexed_seq FROM search_state WHERE workspace_id = $1',
      [workspaceId],
    );
    return rows[0]?.indexed_seq ?? 0;
  }

  async setIndexedSeq(workspaceId: string, seq: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO search_state (workspace_id, indexed_seq) VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET indexed_seq = greatest(search_state.indexed_seq, excluded.indexed_seq)`,
      [workspaceId, seq],
    );
  }

  /** Workspaces whose index is behind their log. */
  async behind(): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT w.id FROM workspaces w LEFT JOIN search_state s ON s.workspace_id = w.id
       WHERE w.last_seq > coalesce(s.indexed_seq, 0)`,
    );
    return rows.map((r) => r.id);
  }

  /** Docs changed in the log after `seq` (distinct), and the newest seq seen. */
  async changedSince(
    workspaceId: string,
    seq: number,
    limit = 5000,
  ): Promise<{ docIds: string[]; lastSeq: number }> {
    const { rows } = await this.pool.query<{ doc_id: string; seq: number }>(
      `SELECT doc_id, seq FROM doc_updates WHERE workspace_id = $1 AND seq > $2
       ORDER BY seq LIMIT $3`,
      [workspaceId, seq, limit],
    );
    return {
      docIds: [...new Set(rows.map((r) => r.doc_id))],
      lastSeq: rows.length ? rows[rows.length - 1]!.seq : seq,
    };
  }

  /** The workspace's pages (from its page tree); pages no longer there are removed. */
  async setPages(workspaceId: string, pages: IndexedPage[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO search_index (workspace_id, id, kind, database_id, title, icon, in_trash, updated_at)
         SELECT $1, id, 'page', NULL, title, icon, in_trash, updated_at
         FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::bigint[])
           AS t(id, title, icon, in_trash, updated_at)
         ON CONFLICT (workspace_id, id) DO UPDATE SET kind = 'page', database_id = NULL,
           title = excluded.title, icon = excluded.icon, in_trash = excluded.in_trash,
           updated_at = excluded.updated_at`,
        [
          workspaceId,
          pages.map((p) => p.id),
          pages.map((p) => p.title),
          pages.map((p) => p.icon),
          pages.map((p) => p.inTrash),
          pages.map((p) => Math.round(p.updatedAt)),
        ],
      );
      await client.query(
        `DELETE FROM search_index WHERE workspace_id = $1 AND kind = 'page' AND NOT (id = ANY($2::text[]))`,
        [workspaceId, pages.map((p) => p.id)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** A database's rows; rows no longer in it are removed. */
  async setRows(workspaceId: string, databaseId: string, rows: IndexedRow[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO search_index (workspace_id, id, kind, database_id, title, icon, props, in_trash, updated_at)
         SELECT $1, id, 'row', $2, title, icon, props, in_trash, updated_at
         FROM unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::boolean[], $8::bigint[])
           AS t(id, title, icon, props, in_trash, updated_at)
         ON CONFLICT (workspace_id, id) DO UPDATE SET kind = 'row', database_id = $2,
           title = excluded.title, icon = excluded.icon, props = excluded.props,
           in_trash = excluded.in_trash, updated_at = excluded.updated_at`,
        [
          workspaceId,
          databaseId,
          rows.map((r) => r.id),
          rows.map((r) => r.title),
          rows.map((r) => r.icon),
          rows.map((r) => r.props),
          rows.map((r) => r.inTrash),
          rows.map((r) => Math.round(r.updatedAt)),
        ],
      );
      await client.query(
        `DELETE FROM search_index WHERE workspace_id = $1 AND kind = 'row' AND database_id = $2
           AND NOT (id = ANY($3::text[]))`,
        [workspaceId, databaseId, rows.map((r) => r.id)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** The text content of a page or row (which may not be known yet: then it waits). */
  async setBody(workspaceId: string, id: string, body: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO search_index (workspace_id, id, body) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, id) DO UPDATE SET body = excluded.body`,
      [workspaceId, id, body],
    );
  }

  /** Pages and rows matching every word (by prefix), best first; trash left out. */
  async search(workspaceId: string, text: string, limit = 20): Promise<SearchHit[]> {
    const query = toTsQuery(text);
    if (!query) return [];
    const { rows } = await this.pool.query<{
      id: string;
      title: string;
      icon: string | null;
      database_id: string | null;
      snippet: string;
    }>(
      `SELECT s.id, s.title, s.icon, s.database_id,
         ts_headline('simple', concat_ws(' ', s.title, nullif(s.props, ''), nullif(left(s.body, 100000), '')), q,
           'StartSel=[, StopSel=], MaxWords=14, MinWords=6, MaxFragments=1, FragmentDelimiter=…')
           AS snippet
       FROM search_index s, to_tsquery('simple', $2) q
       WHERE s.workspace_id = $1 AND s.kind IS NOT NULL AND NOT s.in_trash AND s.tsv @@ q
         AND NOT EXISTS (
           SELECT 1 FROM search_index d
           WHERE d.workspace_id = s.workspace_id AND d.id = s.database_id AND d.in_trash
         )
       ORDER BY ts_rank(s.tsv, q) DESC, s.updated_at DESC
       LIMIT $3`,
      [workspaceId, query, limit],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      databaseId: r.database_id,
      snippet: r.snippet,
    }));
  }

  /** Forget a workspace's index (to rebuild it). */
  async clear(workspaceId: string): Promise<void> {
    await this.pool.query('DELETE FROM search_index WHERE workspace_id = $1', [workspaceId]);
    await this.pool.query('DELETE FROM search_state WHERE workspace_id = $1', [workspaceId]);
  }
}
