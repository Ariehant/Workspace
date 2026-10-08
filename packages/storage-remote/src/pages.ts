import type pg from 'pg';

/** A link found in page content (see `readLinks` in `@workspace/core`). */
export interface StoredLink {
  target: string;
  kind: string;
  blockId: string | null;
  snippet: string;
}

export interface ServerBacklink {
  /** The linking page (or row). */
  id: string;
  title: string;
  icon: string | null;
  databaseId: string | null;
  blockId: string | null;
  kind: string;
  snippet: string;
}

export interface Snapshot {
  id: number;
  docId: string;
  seq: number;
  reason: string;
  authors: string[];
  createdAt: number;
}

export interface Published {
  workspaceId: string;
  pageId: string;
  slug: string;
  includeSubpages: boolean;
  allowIndexing: boolean;
  title: string;
  description: string;
  publishedBy: string | null;
  publishedAt: number;
}

export interface PublishSettings {
  slug: string;
  includeSubpages: boolean;
  allowIndexing: boolean;
  title: string;
  description: string;
}

interface PublishedRow {
  workspace_id: string;
  page_id: string;
  slug: string;
  include_subpages: boolean;
  allow_indexing: boolean;
  title: string;
  description: string;
  published_by: string | null;
  published_at: Date;
}

const published = (r: PublishedRow): Published => ({
  workspaceId: r.workspace_id,
  pageId: r.page_id,
  slug: r.slug,
  includeSubpages: r.include_subpages,
  allowIndexing: r.allow_indexing,
  title: r.title,
  description: r.description,
  publishedBy: r.published_by,
  publishedAt: r.published_at.getTime(),
});

const DAY = 86_400_000;

/**
 * Pages beyond their content (Phase 5 M7, migration 9): links between them (backlinks),
 * their history, publishing to the web, and views.
 */
export class Pages {
  constructor(private readonly pool: pg.Pool) {}

  // --- Links ------------------------------------------------------------------------

  /** Replace the links found in a doc's content. */
  async setLinks(workspaceId: string, sourceId: string, links: readonly StoredLink[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM page_links WHERE workspace_id = $1 AND source_id = $2', [
        workspaceId,
        sourceId,
      ]);
      if (links.length > 0) {
        await client.query(
          `INSERT INTO page_links (workspace_id, source_id, target_id, kind, block_id, snippet)
           SELECT $1, $2, * FROM unnest($3::text[], $4::text[], $5::text[], $6::text[])`,
          [
            workspaceId,
            sourceId,
            links.map((l) => l.target),
            links.map((l) => l.kind),
            links.map((l) => l.blockId),
            links.map((l) => l.snippet.slice(0, 200)),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Pages (and rows) linking to `targetId`, not in the trash, newest first. */
  async backlinks(
    workspaceId: string,
    targetId: string,
    kinds: readonly string[],
  ): Promise<ServerBacklink[]> {
    const { rows } = await this.pool.query<{
      id: string;
      title: string;
      icon: string | null;
      database_id: string | null;
      block_id: string | null;
      kind: string;
      snippet: string;
    }>(
      `SELECT s.id, s.title, s.icon, s.database_id, l.block_id, l.kind, l.snippet
       FROM page_links l
       JOIN search_index s ON s.workspace_id = l.workspace_id AND s.id = l.source_id
       WHERE l.workspace_id = $1 AND l.target_id = $2 AND l.kind = ANY($3::text[])
         AND s.kind IS NOT NULL AND NOT s.in_trash
       ORDER BY s.updated_at DESC`,
      [workspaceId, targetId, kinds],
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon,
      databaseId: r.database_id,
      blockId: r.block_id,
      kind: r.kind,
      snippet: r.snippet,
    }));
  }

  /** Pages showing a synced block (its original included). */
  async syncedPlaces(workspaceId: string, syncedId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ source_id: string }>(
      `SELECT DISTINCT l.source_id FROM page_links l
       JOIN search_index s ON s.workspace_id = l.workspace_id AND s.id = l.source_id
       WHERE l.workspace_id = $1 AND l.target_id = $2 AND l.kind = 'synced' AND NOT s.in_trash`,
      [workspaceId, syncedId],
    );
    return rows.map((r) => r.source_id);
  }

  // --- History ----------------------------------------------------------------------

  /** Docs changed between log positions `from` and `to` are due a snapshot once quiet. */
  async markChanged(workspaceId: string, from: number, to: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO history_pending (workspace_id, doc_id, last_change)
       SELECT $1, doc_id, max(created_at) FROM doc_updates
       WHERE workspace_id = $1 AND seq > $2 AND seq <= $3 GROUP BY doc_id
       ON CONFLICT (workspace_id, doc_id)
       DO UPDATE SET last_change = greatest(history_pending.last_change, excluded.last_change)`,
      [workspaceId, from, to],
    );
  }

  /** Docs that changed and have been quiet since `before`. */
  async quietDocs(
    before: number,
    limit = 200,
  ): Promise<{ workspaceId: string; docId: string; lastChange: number }[]> {
    const { rows } = await this.pool.query<{
      workspace_id: string;
      doc_id: string;
      last_change: Date;
    }>(
      `SELECT workspace_id, doc_id, last_change FROM history_pending
       WHERE last_change < $1 ORDER BY last_change LIMIT $2`,
      [new Date(before), limit],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      docId: r.doc_id,
      lastChange: r.last_change.getTime(),
    }));
  }

  /** Done with a pending doc (unless it changed again since `lastChange`). */
  async donePending(workspaceId: string, docId: string, lastChange: number): Promise<void> {
    await this.pool.query(
      'DELETE FROM history_pending WHERE workspace_id = $1 AND doc_id = $2 AND last_change <= $3',
      [workspaceId, docId, new Date(lastChange)],
    );
  }

  async lastSnapshotSeq(workspaceId: string, docId: string): Promise<number> {
    const { rows } = await this.pool.query<{ seq: number | null }>(
      'SELECT max(seq) AS seq FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2',
      [workspaceId, docId],
    );
    return rows[0]?.seq ?? 0;
  }

  /** Who changed a doc after log position `seq`. */
  async authorsSince(workspaceId: string, docId: string, seq: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM doc_updates
       WHERE workspace_id = $1 AND doc_id = $2 AND seq > $3 AND user_id IS NOT NULL`,
      [workspaceId, docId, seq],
    );
    return rows.map((r) => r.user_id).sort();
  }

  async addSnapshot(input: {
    workspaceId: string;
    docId: string;
    seq: number;
    state: Uint8Array;
    reason: string;
    authors: readonly string[];
    now?: number;
  }): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(
      `INSERT INTO doc_snapshots (workspace_id, doc_id, seq, state, reason, authors, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.workspaceId,
        input.docId,
        input.seq,
        Buffer.from(input.state),
        input.reason,
        input.authors,
        new Date(input.now ?? Date.now()),
      ],
    );
    return Number(rows[0]!.id);
  }

  async snapshots(workspaceId: string, docId: string): Promise<Snapshot[]> {
    const { rows } = await this.pool.query<{
      id: string;
      doc_id: string;
      seq: number;
      reason: string;
      authors: string[];
      created_at: Date;
    }>(
      `SELECT id, doc_id, seq, reason, authors, created_at FROM doc_snapshots
       WHERE workspace_id = $1 AND doc_id = $2 ORDER BY created_at DESC, id DESC`,
      [workspaceId, docId],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      docId: r.doc_id,
      seq: r.seq,
      reason: r.reason,
      authors: r.authors,
      createdAt: r.created_at.getTime(),
    }));
  }

  async snapshotState(
    workspaceId: string,
    id: number,
  ): Promise<{ docId: string; state: Uint8Array } | null> {
    const { rows } = await this.pool.query<{ doc_id: string; state: Buffer }>(
      'SELECT doc_id, state FROM doc_snapshots WHERE workspace_id = $1 AND id = $2',
      [workspaceId, id],
    );
    const r = rows[0];
    return r
      ? {
          docId: r.doc_id,
          state: new Uint8Array(r.state.buffer, r.state.byteOffset, r.state.byteLength),
        }
      : null;
  }

  /**
   * The desktop's retention: everything for a week, then the newest of each day, nothing
   * after 90 days.
   */
  async pruneSnapshots(workspaceId: string, docId: string, now = Date.now()): Promise<void> {
    await this.pool.query(
      `DELETE FROM doc_snapshots WHERE workspace_id = $1 AND doc_id = $2 AND (
         created_at < $3 OR (created_at < $4 AND id NOT IN (
           SELECT DISTINCT ON (date_trunc('day', created_at)) id FROM doc_snapshots
           WHERE workspace_id = $1 AND doc_id = $2 AND created_at < $4
           ORDER BY date_trunc('day', created_at), created_at DESC, id DESC
         ))
       )`,
      [workspaceId, docId, new Date(now - 90 * DAY), new Date(now - 7 * DAY)],
    );
  }

  // --- Publishing -------------------------------------------------------------------

  async published(workspaceId: string, pageId: string): Promise<Published | null> {
    const { rows } = await this.pool.query<PublishedRow>(
      'SELECT * FROM published_pages WHERE workspace_id = $1 AND page_id = $2',
      [workspaceId, pageId],
    );
    return rows[0] ? published(rows[0]) : null;
  }

  async bySlug(slug: string): Promise<Published | null> {
    const { rows } = await this.pool.query<PublishedRow>(
      'SELECT * FROM published_pages WHERE slug = $1',
      [slug],
    );
    return rows[0] ? published(rows[0]) : null;
  }

  /** Publish (or change the settings). False if another page has the slug. */
  async publish(
    workspaceId: string,
    pageId: string,
    settings: PublishSettings,
    by: string,
  ): Promise<boolean> {
    const taken = await this.bySlug(settings.slug);
    if (taken && (taken.workspaceId !== workspaceId || taken.pageId !== pageId)) return false;
    try {
      await this.pool.query(
        `INSERT INTO published_pages
           (workspace_id, page_id, slug, include_subpages, allow_indexing, title, description, published_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, page_id) DO UPDATE SET
           slug = excluded.slug, include_subpages = excluded.include_subpages,
           allow_indexing = excluded.allow_indexing, title = excluded.title,
           description = excluded.description`,
        [
          workspaceId,
          pageId,
          settings.slug,
          settings.includeSubpages,
          settings.allowIndexing,
          settings.title,
          settings.description,
          by,
        ],
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return false;
      throw error;
    }
  }

  async unpublish(workspaceId: string, pageId: string): Promise<Published | null> {
    const { rows } = await this.pool.query<PublishedRow>(
      'DELETE FROM published_pages WHERE workspace_id = $1 AND page_id = $2 RETURNING *',
      [workspaceId, pageId],
    );
    return rows[0] ? published(rows[0]) : null;
  }

  // --- Views ------------------------------------------------------------------------

  /** A view of a page (by a person, or a public visitor's daily hash). */
  async view(workspaceId: string, pageId: string, viewer: string, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    await this.pool.query(
      `INSERT INTO page_views (workspace_id, page_id, day, views) VALUES ($1, $2, $3, 1)
       ON CONFLICT (workspace_id, page_id, day) DO UPDATE SET views = page_views.views + 1`,
      [workspaceId, pageId, day],
    );
    await this.pool.query(
      `INSERT INTO page_viewers (workspace_id, page_id, day, viewer) VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [workspaceId, pageId, day, viewer],
    );
  }

  /** Views and distinct viewers per day, the last `days` days (oldest first). */
  async views(
    workspaceId: string,
    pageId: string,
    days = 28,
    now = Date.now(),
  ): Promise<{ day: string; views: number; viewers: number }[]> {
    const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
    const { rows } = await this.pool.query<{ day: string; views: number; viewers: string }>(
      `SELECT to_char(v.day, 'YYYY-MM-DD') AS day, v.views,
         (SELECT count(*) FROM page_viewers w WHERE w.workspace_id = v.workspace_id
            AND w.page_id = v.page_id AND w.day = v.day) AS viewers
       FROM page_views v WHERE v.workspace_id = $1 AND v.page_id = $2 AND v.day >= $3
       ORDER BY v.day`,
      [workspaceId, pageId, since],
    );
    return rows.map((r) => ({ day: r.day, views: r.views, viewers: Number(r.viewers) }));
  }

  /** Distinct viewers over the last `days` days. */
  async viewers(workspaceId: string, pageId: string, days = 28, now = Date.now()) {
    const since = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10);
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(DISTINCT viewer) AS n FROM page_viewers
       WHERE workspace_id = $1 AND page_id = $2 AND day >= $3`,
      [workspaceId, pageId, since],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
