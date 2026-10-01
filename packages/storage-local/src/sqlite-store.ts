import { DatabaseSync } from 'node:sqlite';

/**
 * Local persistence for one workspace, in a single SQLite file.
 *
 * Uses Node's built-in `node:sqlite` (bundled with Electron), so there is no native
 * module to rebuild per Electron version or CPU architecture.
 *
 * - `doc_updates`: append-only log of Yjs updates per document; compacted on load.
 * - `pages` + `page_fts`: a query index derived from the Yjs docs, for search and
 *   (later) database views. It can always be rebuilt from `doc_updates`.
 * - `settings`: small JSON key/value store for app preferences.
 * - `files`: metadata of attachments stored by `FileStore`.
 * - `link_previews`: cached bookmark metadata, keyed by URL.
 */

const MIGRATIONS: string[] = [
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
];

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

export interface FileRecord {
  /** `<sha256>.<ext>`: content-addressed, so identical files are stored once. */
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
}

export interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  /** Matching excerpt with hits wrapped in `[` `]`. */
  snippet: string;
}

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
      'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;',
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

  appendUpdate(docId: string, update: Uint8Array): void {
    this.db
      .prepare('INSERT INTO doc_updates (doc_id, data, created_at) VALUES (?, ?, ?)')
      .run(docId, update, Date.now());
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

  /** Make the page index match `rows` exactly. */
  syncPageIndex(rows: PageIndexRow[]): void {
    this.transaction(() => {
      const existing = new Set(
        (this.db.prepare('SELECT id FROM pages').all() as { id: string }[]).map((r) => r.id),
      );
      const upsert = this.db.prepare(`
        INSERT INTO pages (id, parent_id, title, icon, sort_key, in_trash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          parent_id = excluded.parent_id, title = excluded.title, icon = excluded.icon,
          sort_key = excluded.sort_key, in_trash = excluded.in_trash,
          created_at = excluded.created_at, updated_at = excluded.updated_at
      `);
      const ftsTitle = this.db.prepare('UPDATE page_fts SET title = ? WHERE page_id = ?');
      const ftsInsert = this.db.prepare(
        "INSERT INTO page_fts (page_id, title, body) VALUES (?, ?, '')",
      );
      for (const row of rows) {
        upsert.run(
          row.id,
          row.parentId,
          row.title,
          row.icon,
          row.sortKey,
          row.inTrash ? 1 : 0,
          row.createdAt,
          row.updatedAt,
        );
        if (existing.has(row.id)) ftsTitle.run(row.title, row.id);
        else ftsInsert.run(row.id, row.title);
        existing.delete(row.id);
      }
      for (const id of existing) this.removePageIndex(id);
    });
  }

  private removePageIndex(id: string): void {
    this.db.prepare('DELETE FROM pages WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM page_fts WHERE page_id = ?').run(id);
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
    this.db.prepare('UPDATE page_fts SET body = ? WHERE page_id = ?').run(body, id);
  }

  search(query: string, limit = 20): SearchResult[] {
    const fts = toFtsQuery(query);
    if (!fts) return [];
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.icon,
                snippet(page_fts, -1, '[', ']', '…', 12) AS snippet
         FROM page_fts
         JOIN pages p ON p.id = page_fts.page_id
         WHERE page_fts MATCH ? AND p.in_trash = 0
         ORDER BY bm25(page_fts, 0, 10.0, 1.0)
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

  close(): void {
    this.db.close();
  }
}
