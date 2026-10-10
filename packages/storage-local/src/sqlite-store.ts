import { DatabaseSync } from 'node:sqlite';

/**
 * Local persistence for one workspace, in a single SQLite file.
 *
 * Uses Node's built-in `node:sqlite` (bundled with Electron), so there is no native
 * module to rebuild per Electron version or CPU architecture.
 *
 * - `doc_updates`: append-only log of Yjs updates per document; compacted on load.
 * - `pages` + `page_fts`: a query index derived from the Yjs docs, for search. It
 *   holds workspace pages and database rows (`database_id` set). It can always be
 *   rebuilt from `doc_updates`.
 * - `settings`: small JSON key/value store for app preferences.
 * - `files`: metadata of attachments stored by `FileStore`.
 * - `link_previews`: cached bookmark metadata, keyed by URL.
 * - `reminders`: `@remind` mentions found in pages, and whether each has fired.
 */

/** Schema migrations; index + 1 is the `user_version` each one produces. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE doc_updates (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX doc_updates_doc ON doc_updates (doc_id, seq);

  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    title TEXT NOT NULL,
    icon TEXT,
    sort_key TEXT NOT NULL,
    in_trash INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE VIRTUAL TABLE page_fts USING fts5 (
    page_id UNINDEXED,
    title,
    body,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: attachments and cached link previews (Phase 1 M3).
  `
  CREATE TABLE files (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE link_previews (
    url TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  `,
  // 3: reminders from @remind mentions, derived from page docs (Phase 1 M4).
  `
  CREATE TABLE reminders (
    page_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    fire_at INTEGER NOT NULL,
    text TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (page_id, block_id, fire_at)
  );
  CREATE INDEX reminders_due ON reminders (fired, fire_at);
  `,
  // 4: database rows in the page index, with their property text searchable (Phase 2).
  `
  ALTER TABLE pages ADD COLUMN database_id TEXT;
  CREATE INDEX pages_database ON pages (database_id);

  CREATE VIRTUAL TABLE page_fts_v4 USING fts5 (
    page_id UNINDEXED,
    title,
    body,
    props,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  INSERT INTO page_fts_v4 (page_id, title, body, props)
    SELECT page_id, title, body, '' FROM page_fts;
  DROP TABLE page_fts;
  ALTER TABLE page_fts_v4 RENAME TO page_fts;
  `,
  // 5: links between pages (backlinks) and page history snapshots (Phase 3 M2).
  `
  CREATE TABLE links (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    block_id TEXT,
    snippet TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX links_target ON links (target_id);
  CREATE INDEX links_source ON links (source_id);

  CREATE TABLE doc_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    state BLOB NOT NULL
  );
  CREATE INDEX doc_versions_doc ON doc_versions (doc_id, created_at);
  `,
  // 6: sync with a server (Phase 4 M4): local updates waiting for the server's
  // acknowledgement, and attachments already uploaded.
  `
  CREATE TABLE sync_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id TEXT NOT NULL,
    data BLOB NOT NULL
  );
  CREATE TABLE sync_files (
    file_id TEXT PRIMARY KEY
  );
  `,
  // 7: each index entry knows its full-text row (Phase 7 M1). `page_id` can't be indexed
  // in the full-text table, so changing an entry by page id scanned all of it. `props`
  // keeps a row's property text, so unchanged rows aren't written again.
  `
  ALTER TABLE pages ADD COLUMN fts_rowid INTEGER;
  ALTER TABLE pages ADD COLUMN props TEXT NOT NULL DEFAULT '';
  CREATE TEMP TABLE fts_ids AS
    SELECT page_id, MAX(rowid) AS fts_rowid FROM page_fts GROUP BY page_id;
  CREATE INDEX temp.fts_ids_page ON fts_ids (page_id);
  UPDATE pages SET fts_rowid = (SELECT fts_rowid FROM fts_ids WHERE fts_ids.page_id = pages.id);
  UPDATE pages SET props = COALESCE((SELECT props FROM page_fts WHERE rowid = pages.fts_rowid), '')
    WHERE database_id IS NOT NULL;
  DROP TABLE temp.fts_ids;
  `,
];

/** Settings that belong to this device's sync (never exported to a backup). */
export const isSyncSetting = (key: string) => key.startsWith('sync.');

/** A reference from one page to another, as stored for backlinks. */
export interface LinkRow {
  target: string;
  kind: string;
  blockId: string | null;
  snippet: string;
}

/** A page linking here, with where (block) and how. */
export interface Backlink {
  id: string;
  title: string;
  icon: string | null;
  databaseId: string | null;
  blockId: string | null;
  kind: string;
  snippet: string;
}

/** A saved state of a doc (page history). */
export interface DocVersion {
  id: number;
  docId: string;
  createdAt: number;
  /** Why it was taken: `edit` (an editing session), `restore`, `template`, … */
  reason: string;
}

export interface PageIndexRow {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  sortKey: string;
  /** The page or one of its ancestors is in the trash. */
  inTrash: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A database row in the page index. */
export interface RowIndexRow {
  id: string;
  title: string;
  icon: string | null;
  sortKey: string;
  inTrash: boolean;
  createdAt: number;
  updatedAt: number;
  /** Text of the row's properties, searchable. */
  props: string;
}

/** An entry of the `pages` table, as stored. */
interface StoredEntry {
  id: string;
  fts_rowid: number | null;
  parent_id: string | null;
  title: string;
  icon: string | null;
  sort_key: string;
  in_trash: number;
  created_at: number;
  updated_at: number;
  props?: string;
}

export interface FileRecord {
  /** `<sha256>.<ext>`: content-addressed, so identical files are stored once. */
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

export interface Reminder {
  pageId: string;
  blockId: string;
  pageTitle: string;
  fireAt: number;
  text: string;
}

export interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  /** The database a row belongs to; `null` for pages. */
  databaseId: string | null;
  /** Matching excerpt with hits wrapped in `[` `]`. */
  snippet: string;
}

/** Block id prefix of reminders set on date properties (not in page content). */
const PROPERTY_REMINDER = 'prop:';

/** Turn free text into an FTS5 query that prefix-matches every word. */
function toFtsQuery(input: string): string | null {
  const terms = input.match(/[\p{L}\p{N}_]+/gu);
  if (!terms) return null;
  return terms.map((t) => `"${t}"*`).join(' ');
}

export class SqliteStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      // Workers (exports, imports) open their own connections: wait for a writer, don't fail.
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;',
    );
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- Yjs document updates -------------------------------------------------

  /**
   * Store an update; with `outbox`, also queue it for the sync server, in the same
   * transaction (a savepoint, so it nests): a crash can't keep one without the other.
   */
  appendUpdate(docId: string, update: Uint8Array, outbox = false): void {
    if (!outbox) {
      this.db
        .prepare('INSERT INTO doc_updates (doc_id, data, created_at) VALUES (?, ?, ?)')
        .run(docId, update, Date.now());
      return;
    }
    this.db.exec('SAVEPOINT append_update');
    try {
      this.db
        .prepare('INSERT INTO doc_updates (doc_id, data, created_at) VALUES (?, ?, ?)')
        .run(docId, update, Date.now());
      this.outboxAdd(docId, update);
      this.db.exec('RELEASE append_update');
    } catch (error) {
      this.db.exec('ROLLBACK TO append_update');
      this.db.exec('RELEASE append_update');
      throw error;
    }
  }

  // --- Sync outbox ------------------------------------------------------------

  outboxAdd(docId: string, update: Uint8Array): void {
    this.db.prepare('INSERT INTO sync_outbox (doc_id, data) VALUES (?, ?)').run(docId, update);
  }

  /** Updates not yet acknowledged by the server, oldest first. */
  outboxPending(limit: number): { localId: number; docId: string; update: Uint8Array }[] {
    const rows = this.db
      .prepare('SELECT id, doc_id, data FROM sync_outbox ORDER BY id LIMIT ?')
      .all(limit) as { id: number; doc_id: string; data: Uint8Array }[];
    return rows.map((r) => ({ localId: r.id, docId: r.doc_id, update: r.data }));
  }

  outboxRemove(ids: readonly number[]): void {
    const remove = this.db.prepare('DELETE FROM sync_outbox WHERE id = ?');
    this.transaction(() => {
      for (const id of ids) remove.run(id);
    });
  }

  /** Forget unsent changes to a doc (the server refused them, or the doc went away). */
  outboxRemoveDoc(docId: string): void {
    this.db.prepare('DELETE FROM sync_outbox WHERE doc_id = ?').run(docId);
  }

  outboxCount(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM sync_outbox').get() as { n: number }).n;
  }

  outboxClear(): void {
    this.db.exec('DELETE FROM sync_outbox');
  }

  /** Attachments the server has (uploaded, or found there). */
  markFileSynced(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO sync_files (file_id) VALUES (?)').run(id);
  }

  /** Local attachments not yet known to be on the server. */
  unsyncedFiles(): FileRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM files WHERE id NOT IN (SELECT file_id FROM sync_files) ORDER BY created_at`,
      )
      .all() as { id: string; name: string; mime: string; size: number; created_at: number }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      createdAt: row.created_at,
    }));
  }

  unsyncedFileCount(): number {
    return (
      this.db
        .prepare('SELECT count(*) AS n FROM files WHERE id NOT IN (SELECT file_id FROM sync_files)')
        .get() as { n: number }
    ).n;
  }

  clearSyncedFiles(): void {
    this.db.exec('DELETE FROM sync_files');
  }

  getUpdates(docId: string): Uint8Array[] {
    const rows = this.db
      .prepare('SELECT data FROM doc_updates WHERE doc_id = ? ORDER BY seq')
      .all(docId) as { data: Uint8Array }[];
    return rows.map((r) => r.data);
  }

  /** Replace a document's update log with one merged update. */
  replaceUpdates(docId: string, merged: Uint8Array): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM doc_updates WHERE doc_id = ?').run(docId);
      this.appendUpdate(docId, merged);
    });
  }

  deleteDoc(docId: string): void {
    this.db.prepare('DELETE FROM doc_updates WHERE doc_id = ?').run(docId);
  }

  listDocIds(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT doc_id FROM doc_updates').all() as {
      doc_id: string;
    }[];
    return rows.map((r) => r.doc_id);
  }

  // --- Page index -----------------------------------------------------------

  /** Make the index of workspace pages match `rows` exactly (database rows aside). */
  syncPageIndex(rows: PageIndexRow[]): void {
    this.transaction(() => {
      const existing = new Map(
        (
          this.db
            .prepare(
              `SELECT id, fts_rowid, parent_id, title, icon, sort_key, in_trash, created_at,
                      updated_at
               FROM pages WHERE database_id IS NULL`,
            )
            .all() as unknown as StoredEntry[]
        ).map((r) => [r.id, r]),
      );
      const update = this.db.prepare(`
        UPDATE pages SET parent_id = ?, title = ?, icon = ?, sort_key = ?, in_trash = ?,
          created_at = ?, updated_at = ?
        WHERE id = ?
      `);
      for (const row of rows) {
        const old = existing.get(row.id);
        existing.delete(row.id);
        if (!old) {
          const ftsRowid = this.ftsEntry(row.id, row.title, null);
          this.insertEntry(row.id, row.parentId, null, row, '', ftsRowid);
          continue;
        }
        const inTrash = row.inTrash ? 1 : 0;
        if (
          old.parent_id !== row.parentId ||
          old.title !== row.title ||
          old.icon !== row.icon ||
          old.sort_key !== row.sortKey ||
          old.in_trash !== inTrash ||
          old.created_at !== row.createdAt ||
          old.updated_at !== row.updatedAt
        ) {
          update.run(
            row.parentId,
            row.title,
            row.icon,
            row.sortKey,
            inTrash,
            row.createdAt,
            row.updatedAt,
            row.id,
          );
        }
        if (old.title !== row.title || old.fts_rowid === null) {
          this.ftsEntry(row.id, row.title, null, old.fts_rowid);
        }
      }
      for (const id of existing.keys()) this.removePageIndex(id);
    });
  }

  /**
   * Make the index of one database's rows match `rows`. Returns the ids that were
   * added and removed (so the caller can index or drop their content docs). Only rows
   * that changed are written.
   */
  syncRowIndex(databaseId: string, rows: RowIndexRow[]): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    this.transaction(() => {
      const existing = new Map(
        (
          this.db
            .prepare(
              `SELECT id, fts_rowid, parent_id, title, icon, sort_key, in_trash, created_at,
                      updated_at, props
               FROM pages WHERE database_id = ?`,
            )
            .all(databaseId) as unknown as StoredEntry[]
        ).map((r) => [r.id, r]),
      );
      for (const row of rows) {
        if (this.writeRowEntry(databaseId, row, existing.get(row.id))) added.push(row.id);
        existing.delete(row.id);
      }
      for (const id of existing.keys()) {
        this.removePageIndex(id);
        removed.push(id);
      }
    });
    return { added, removed };
  }

  /**
   * Index the rows of a database that changed since the last sync (`changed`), and drop
   * the ones that are gone; like `syncRowIndex`, without reading the other rows.
   */
  updateRowIndex(
    databaseId: string,
    changed: readonly RowIndexRow[],
    gone: readonly string[],
  ): { added: string[]; removed: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    this.transaction(() => {
      const get = this.db.prepare(
        `SELECT id, database_id, fts_rowid, parent_id, title, icon, sort_key, in_trash,
                created_at, updated_at, props
         FROM pages WHERE id = ?`,
      );
      for (const row of changed) {
        const old = get.get(row.id) as (StoredEntry & { database_id: string | null }) | undefined;
        const mine = old?.database_id === databaseId ? old : undefined;
        if (this.writeRowEntry(databaseId, row, mine)) added.push(row.id);
      }
      for (const id of gone) {
        const old = get.get(id) as { database_id: string | null } | undefined;
        if (old?.database_id !== databaseId) continue;
        this.removePageIndex(id);
        removed.push(id);
      }
    });
    return { added, removed };
  }

  /** Write one row's index entry, given what's stored for it; true when it's new. */
  private writeRowEntry(
    databaseId: string,
    row: RowIndexRow,
    old: StoredEntry | undefined,
  ): boolean {
    if (!old) {
      const ftsRowid = this.ftsEntry(row.id, row.title, row.props);
      this.insertEntry(row.id, databaseId, databaseId, row, row.props, ftsRowid);
      return true;
    }
    const inTrash = row.inTrash ? 1 : 0;
    if (
      old.title !== row.title ||
      old.icon !== row.icon ||
      old.sort_key !== row.sortKey ||
      old.in_trash !== inTrash ||
      old.created_at !== row.createdAt ||
      old.updated_at !== row.updatedAt ||
      old.props !== row.props
    ) {
      this.db
        .prepare(
          `UPDATE pages SET title = ?, icon = ?, sort_key = ?, in_trash = ?, created_at = ?,
             updated_at = ?, props = ?
           WHERE id = ?`,
        )
        .run(
          row.title,
          row.icon,
          row.sortKey,
          inTrash,
          row.createdAt,
          row.updatedAt,
          row.props,
          row.id,
        );
    }
    if (old.title !== row.title || old.props !== row.props || old.fts_rowid === null) {
      this.ftsEntry(row.id, row.title, row.props, old.fts_rowid);
    }
    return false;
  }

  /**
   * Write a page's full-text title (and property text, for rows) at `rowid`, or in a new
   * full-text row; returns its rowid. A page that had an entry elsewhere (it moved between
   * the workspace and a database) keeps its full-text row.
   */
  private ftsEntry(
    id: string,
    title: string,
    props: string | null,
    rowid: number | null = this.ftsRowidOf(id),
  ): number {
    if (rowid !== null) {
      if (props === null) {
        this.db.prepare('UPDATE page_fts SET title = ? WHERE rowid = ?').run(title, rowid);
      } else {
        this.db
          .prepare('UPDATE page_fts SET title = ?, props = ? WHERE rowid = ?')
          .run(title, props, rowid);
      }
      return rowid;
    }
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO page_fts (page_id, title, body, props) VALUES (?, ?, '', ?)")
      .run(id, title, props ?? '');
    this.db.prepare('UPDATE pages SET fts_rowid = ? WHERE id = ?').run(lastInsertRowid, id);
    return Number(lastInsertRowid);
  }

  private ftsRowidOf(id: string): number | null {
    const row = this.db.prepare('SELECT fts_rowid FROM pages WHERE id = ?').get(id) as
      { fts_rowid: number | null } | undefined;
    return row?.fts_rowid ?? null;
  }

  private insertEntry(
    id: string,
    parentId: string | null,
    databaseId: string | null,
    row: Omit<PageIndexRow, 'id' | 'parentId'>,
    props: string,
    ftsRowid: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO pages
           (id, parent_id, database_id, title, icon, sort_key, in_trash, created_at, updated_at,
            props, fts_rowid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           parent_id = excluded.parent_id, database_id = excluded.database_id,
           title = excluded.title, icon = excluded.icon, sort_key = excluded.sort_key,
           in_trash = excluded.in_trash, created_at = excluded.created_at,
           updated_at = excluded.updated_at, props = excluded.props,
           fts_rowid = excluded.fts_rowid`,
      )
      .run(
        id,
        parentId,
        databaseId,
        row.title,
        row.icon,
        row.sortKey,
        row.inTrash ? 1 : 0,
        row.createdAt,
        row.updatedAt,
        props,
        ftsRowid,
      );
  }

  /** Ids of a database's rows in the index. */
  rowIdsOf(databaseId: string): string[] {
    return (
      this.db.prepare('SELECT id FROM pages WHERE database_id = ?').all(databaseId) as {
        id: string;
      }[]
    ).map((r) => r.id);
  }

  /**
   * Where a page lives: `{ databaseId: null }` for a workspace page, the database for
   * a row, `null` if the index doesn't know the id.
   */
  locatePage(id: string): { databaseId: string | null } | null {
    const row = this.db.prepare('SELECT database_id FROM pages WHERE id = ?').get(id) as
      { database_id: string | null } | undefined;
    return row ? { databaseId: row.database_id } : null;
  }

  removePageIndex(id: string): void {
    const rowid = this.ftsRowidOf(id);
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
    if (rowid !== null) this.db.prepare('DELETE FROM page_fts WHERE rowid = ?').run(rowid);
    this.db.prepare('DELETE FROM links WHERE source_id = ?').run(id);
  }

  // --- Links (backlinks) ------------------------------------------------------

  /** Replace the links of `kinds` that `sourceId` makes (others are kept). */
  replaceLinks(sourceId: string, kinds: readonly string[], links: readonly LinkRow[]): void {
    this.transaction(() => {
      const placeholders = kinds.map(() => '?').join(',');
      this.db
        .prepare(`DELETE FROM links WHERE source_id = ? AND kind IN (${placeholders})`)
        .run(sourceId, ...kinds);
      const insert = this.db.prepare(
        'INSERT INTO links (source_id, target_id, kind, block_id, snippet) VALUES (?, ?, ?, ?, ?)',
      );
      for (const link of links) {
        if (link.target === sourceId) continue;
        insert.run(sourceId, link.target, link.kind, link.blockId, link.snippet);
      }
    });
  }

  /**
   * Replace the links of one kind that each of `sources` makes, in one transaction.
   * Sources whose links didn't change aren't written.
   */
  replaceLinksOf(kind: string, sources: ReadonlyMap<string, readonly LinkRow[]>): void {
    const key = (target: string, blockId: string | null, snippet: string) =>
      JSON.stringify([target, blockId, snippet]);
    this.transaction(() => {
      type Stored = {
        source_id: string;
        target_id: string;
        block_id: string | null;
        snippet: string;
      };
      const existing = new Map<string, string[]>();
      // A few sources: by source (indexed); many: one pass over the kind's links.
      const stored =
        sources.size <= 500
          ? [...sources.keys()].flatMap(
              (id) =>
                this.db
                  .prepare(
                    'SELECT source_id, target_id, block_id, snippet FROM links WHERE source_id = ? AND kind = ?',
                  )
                  .all(id, kind) as Stored[],
            )
          : (this.db
              .prepare('SELECT source_id, target_id, block_id, snippet FROM links WHERE kind = ?')
              .all(kind) as Stored[]);
      for (const link of stored) {
        if (!sources.has(link.source_id)) continue;
        let keys = existing.get(link.source_id);
        if (!keys) existing.set(link.source_id, (keys = []));
        keys.push(key(link.target_id, link.block_id, link.snippet));
      }
      const remove = this.db.prepare('DELETE FROM links WHERE source_id = ? AND kind = ?');
      const insert = this.db.prepare(
        'INSERT INTO links (source_id, target_id, kind, block_id, snippet) VALUES (?, ?, ?, ?, ?)',
      );
      for (const [sourceId, links] of sources) {
        const wanted = links.filter((link) => link.target !== sourceId);
        const next = wanted.map((l) => key(l.target, l.blockId, l.snippet)).sort();
        const before = (existing.get(sourceId) ?? []).sort();
        if (next.length === before.length && next.every((k, i) => k === before[i])) continue;
        remove.run(sourceId, kind);
        for (const link of wanted) {
          insert.run(sourceId, link.target, kind, link.blockId, link.snippet);
        }
      }
    });
  }

  /** Live pages and rows that link to `targetId` (one entry per linking block). */
  backlinks(targetId: string, kinds: readonly string[]): Backlink[] {
    const placeholders = kinds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.icon, p.database_id AS databaseId,
                l.block_id AS blockId, l.kind, l.snippet
         FROM links l
         JOIN pages p ON p.id = l.source_id
         LEFT JOIN pages d ON d.id = p.database_id
         WHERE l.target_id = ? AND l.kind IN (${placeholders})
           AND p.in_trash = 0 AND COALESCE(d.in_trash, 0) = 0
         ORDER BY p.updated_at DESC`,
      )
      .all(targetId, ...kinds) as unknown as Backlink[];
    return rows.map((r) => ({ ...r }));
  }

  /** How many live pages show a synced block (its original included). */
  syncedPlaces(syncedId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT l.source_id) AS n FROM links l
         JOIN pages p ON p.id = l.source_id
         WHERE l.target_id = ? AND l.kind = 'synced' AND p.in_trash = 0`,
      )
      .get(syncedId) as { n: number };
    return row.n;
  }

  // --- Page history -----------------------------------------------------------

  addVersion(docId: string, state: Uint8Array, reason: string, now = Date.now()): number {
    const result = this.db
      .prepare('INSERT INTO doc_versions (doc_id, created_at, reason, state) VALUES (?, ?, ?, ?)')
      .run(docId, now, reason, state);
    return Number(result.lastInsertRowid);
  }

  /** A doc's versions, newest first. */
  listVersions(docId: string): DocVersion[] {
    return (
      this.db
        .prepare(
          `SELECT id, doc_id AS docId, created_at AS createdAt, reason FROM doc_versions
           WHERE doc_id = ? ORDER BY created_at DESC, id DESC`,
        )
        .all(docId) as unknown as DocVersion[]
    ).map((r) => ({ ...r }));
  }

  lastVersionTime(docId: string): number | null {
    const row = this.db
      .prepare('SELECT MAX(created_at) AS t FROM doc_versions WHERE doc_id = ?')
      .get(docId) as { t: number | null };
    return row.t;
  }

  getVersionState(id: number): { docId: string; state: Uint8Array } | null {
    const row = this.db
      .prepare('SELECT doc_id AS docId, state FROM doc_versions WHERE id = ?')
      .get(id) as { docId: string; state: Uint8Array } | undefined;
    return row ? { docId: row.docId, state: row.state } : null;
  }

  /**
   * Keep every version from the last `keepAllDays`, then the newest one per day for
   * up to `maxDays`; delete the rest. Returns how many were deleted.
   */
  pruneVersions(now = Date.now(), keepAllDays = 7, maxDays = 90): number {
    const day = 86_400_000;
    let deleted = 0;
    this.transaction(() => {
      deleted += Number(
        this.db.prepare('DELETE FROM doc_versions WHERE created_at < ?').run(now - maxDays * day)
          .changes,
      );
      // Older than a week: keep the newest version of each doc per day.
      deleted += Number(
        this.db
          .prepare(
            `DELETE FROM doc_versions WHERE created_at < ? AND id NOT IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                   PARTITION BY doc_id, created_at / ${day}
                   ORDER BY created_at DESC, id DESC
                 ) AS n
                 FROM doc_versions WHERE created_at < ?
               ) WHERE n = 1
             )`,
          )
          .run(now - keepAllDays * day, now - keepAllDays * day).changes,
      );
    });
    return deleted;
  }

  deleteVersions(docId: string): void {
    this.db.prepare('DELETE FROM doc_versions WHERE doc_id = ?').run(docId);
  }

  getPageIndex(id: string): PageIndexRow | null {
    const row = this.db.prepare('SELECT * FROM pages WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      parentId: row.parent_id as string | null,
      title: row.title as string,
      icon: row.icon as string | null,
      sortKey: row.sort_key as string,
      inTrash: row.in_trash === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  setPageBody(id: string, body: string): void {
    const rowid = this.ftsRowidOf(id);
    if (rowid !== null)
      this.db.prepare('UPDATE page_fts SET body = ? WHERE rowid = ?').run(body, rowid);
  }

  search(query: string, limit = 20): SearchResult[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.icon, p.database_id AS databaseId,
                snippet(page_fts, -1, '[', ']', '…', 12) AS snippet
         FROM page_fts
         JOIN pages p ON p.id = page_fts.page_id
         LEFT JOIN pages d ON d.id = p.database_id
         WHERE page_fts MATCH ? AND p.in_trash = 0 AND COALESCE(d.in_trash, 0) = 0
         ORDER BY bm25(page_fts, 0, 10.0, 1.0, 2.0)
         LIMIT ?`,
      )
      .all(fts, limit) as unknown as SearchResult[];
    return rows.map((r) => ({ ...r }));
  }

  // --- Files and link previews ------------------------------------------------

  putFileRecord(file: FileRecord): void {
    this.db
      .prepare(
        `INSERT INTO files (id, name, mime, size, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(file.id, file.name, file.mime, file.size, file.createdAt);
  }

  getFileRecord(id: string): FileRecord | null {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as
      { id: string; name: string; mime: string; size: number; created_at: number } | undefined;
    return row
      ? { id: row.id, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at }
      : null;
  }

  listFileRecords(): FileRecord[] {
    const rows = this.db.prepare('SELECT * FROM files ORDER BY created_at').all() as {
      id: string;
      name: string;
      mime: string;
      size: number;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mime: row.mime,
      size: row.size,
      createdAt: row.created_at,
    }));
  }

  getLinkPreview<T>(url: string, maxAgeMs: number): T | null {
    const row = this.db
      .prepare('SELECT data, fetched_at FROM link_previews WHERE url = ?')
      .get(url) as { data: string; fetched_at: number } | undefined;
    if (!row || Date.now() - row.fetched_at > maxAgeMs) return null;
    return JSON.parse(row.data) as T;
  }

  putLinkPreview(url: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (url) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
      )
      .run(url, JSON.stringify(data), Date.now());
  }

  // --- Reminders ------------------------------------------------------------

  /**
   * Make a page's reminders match `reminders`. A reminder is identified by its block
   * and time, so editing the text around it keeps its `fired` flag (no second
   * notification) while picking up the new text.
   */
  /** Replace a page's content reminders (`@remind` mentions), keeping fired state. */
  replaceReminders(
    pageId: string,
    reminders: { blockId: string; fireAt: number; text: string }[],
  ): void {
    this.transaction(() => {
      const scope = `page_id = ? AND block_id NOT LIKE '${PROPERTY_REMINDER}%'`;
      const fired = new Set(
        (
          this.db
            .prepare(`SELECT block_id, fire_at FROM reminders WHERE ${scope} AND fired = 1`)
            .all(pageId) as { block_id: string; fire_at: number }[]
        ).map((r) => `${r.block_id}@${r.fire_at}`),
      );
      this.db.prepare(`DELETE FROM reminders WHERE ${scope}`).run(pageId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO reminders (page_id, block_id, fire_at, text, fired) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of reminders) {
        insert.run(
          pageId,
          r.blockId,
          r.fireAt,
          r.text,
          fired.has(`${r.blockId}@${r.fireAt}`) ? 1 : 0,
        );
      }
    });
  }

  /**
   * Replace the reminders on date properties of a database's rows (block ids
   * `prop:<propertyId>`), keeping fired state. Call after `syncRowIndex`.
   */
  replacePropertyReminders(
    databaseId: string,
    reminders: { rowId: string; propertyId: string; fireAt: number; text: string }[],
  ): void {
    this.transaction(() => {
      const scope = `block_id LIKE '${PROPERTY_REMINDER}%'
        AND page_id IN (SELECT id FROM pages WHERE database_id = ?)`;
      const fired = new Set(
        (
          this.db
            .prepare(
              `SELECT page_id, block_id, fire_at FROM reminders WHERE ${scope} AND fired = 1`,
            )
            .all(databaseId) as { page_id: string; block_id: string; fire_at: number }[]
        ).map((r) => `${r.page_id}/${r.block_id}@${r.fire_at}`),
      );
      this.db.prepare(`DELETE FROM reminders WHERE ${scope}`).run(databaseId);
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO reminders (page_id, block_id, fire_at, text, fired) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of reminders) {
        const blockId = `${PROPERTY_REMINDER}${r.propertyId}`;
        insert.run(
          r.rowId,
          blockId,
          r.fireAt,
          r.text,
          fired.has(`${r.rowId}/${blockId}@${r.fireAt}`) ? 1 : 0,
        );
      }
    });
  }

  /** Unfired reminders due by `now`, on pages that are not in the trash. */
  /**
   * Replace the date-property reminders of some rows (`rowIds`) of a database with
   * `reminders`, keeping whether each one already fired; other rows' are kept.
   */
  updatePropertyReminders(
    rowIds: readonly string[],
    reminders: { rowId: string; propertyId: string; fireAt: number; text: string }[],
  ): void {
    if (rowIds.length === 0) return;
    this.transaction(() => {
      const ofRow = `page_id = ? AND block_id LIKE '${PROPERTY_REMINDER}%'`;
      const firedOf = this.db.prepare(
        `SELECT page_id, block_id, fire_at FROM reminders WHERE ${ofRow} AND fired = 1`,
      );
      const remove = this.db.prepare(`DELETE FROM reminders WHERE ${ofRow}`);
      const fired = new Set<string>();
      for (const rowId of rowIds) {
        for (const r of firedOf.all(rowId) as {
          page_id: string;
          block_id: string;
          fire_at: number;
        }[]) {
          fired.add(`${r.page_id}/${r.block_id}@${r.fire_at}`);
        }
        remove.run(rowId);
      }
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO reminders (page_id, block_id, fire_at, text, fired) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of reminders) {
        const blockId = `${PROPERTY_REMINDER}${r.propertyId}`;
        const key = `${r.rowId}/${blockId}@${r.fireAt}`;
        insert.run(r.rowId, blockId, r.fireAt, r.text, fired.has(key) ? 1 : 0);
      }
    });
  }

  dueReminders(now: number): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT r.page_id, r.block_id, r.fire_at, r.text, p.title
         FROM reminders r JOIN pages p ON p.id = r.page_id
         WHERE r.fired = 0 AND r.fire_at <= ? AND p.in_trash = 0
         ORDER BY r.fire_at`,
      )
      .all(now) as {
      page_id: string;
      block_id: string;
      fire_at: number;
      text: string;
      title: string;
    }[];
    return rows.map((r) => ({
      pageId: r.page_id,
      blockId: r.block_id,
      fireAt: r.fire_at,
      text: r.text,
      pageTitle: r.title,
    }));
  }

  markReminderFired(reminder: Pick<Reminder, 'pageId' | 'blockId' | 'fireAt'>): void {
    this.db
      .prepare('UPDATE reminders SET fired = 1 WHERE page_id = ? AND block_id = ? AND fire_at = ?')
      .run(reminder.pageId, reminder.blockId, reminder.fireAt);
  }

  /** Has this reminder fired here (null: there's no such reminder)? */
  reminderFired(reminder: Pick<Reminder, 'pageId' | 'blockId' | 'fireAt'>): boolean | null {
    const row = this.db
      .prepare('SELECT fired FROM reminders WHERE page_id = ? AND block_id = ? AND fire_at = ?')
      .get(reminder.pageId, reminder.blockId, reminder.fireAt) as { fired: number } | undefined;
    return row ? row.fired === 1 : null;
  }

  /** When the next unfired reminder is due, or `null` if none is pending. */
  nextReminderAt(): number | null {
    const row = this.db
      .prepare('SELECT MIN(fire_at) AS next FROM reminders WHERE fired = 0')
      .get() as { next: number | null };
    return row.next;
  }

  deleteReminders(pageId: string): void {
    this.db.prepare('DELETE FROM reminders WHERE page_id = ?').run(pageId);
  }

  // --- Settings -------------------------------------------------------------

  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  /** Every setting, for backups (except this device's sync settings: the token!). */
  listSettings(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(
      rows
        .filter((row) => !isSyncSetting(row.key))
        .map((row) => [row.key, JSON.parse(row.value) as unknown]),
    );
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  close(): void {
    this.db.close();
  }
}
