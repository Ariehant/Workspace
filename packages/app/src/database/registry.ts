import {
  TRASH_RETENTION_MS,
  createPage,
  getPage,
  listPages,
  setPageKind,
  type DocClient,
  type PageId,
  type PageTree,
} from '@workspace/core';
import {
  ComputedCache,
  DatabaseHandle,
  emptyRowTrashBefore,
  hasRow,
  initDatabase,
  type DatabaseSnapshot,
  type DisplayContext,
  type DocResolver,
  type Row,
} from '@workspace/database';
import type { Platform } from '../platform';

interface Entry {
  ready: Promise<DatabaseHandle>;
  handle: DatabaseHandle | null;
  release(): void;
}

/** How long a failed lookup is trusted before asking the index again. */
const MISS_TTL_MS = 2000;

/**
 * The database docs the window has open, and which database each row belongs to.
 *
 * Databases stay loaded for the rest of the session once something shows them (a
 * view, a row link, a mention). Rows that aren't in a loaded database are found
 * through the search index (`Platform.locatePage`), then their database is loaded.
 */
export class DatabaseRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly locating = new Map<string, Promise<string | null>>();
  private readonly misses = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(
    private readonly client: DocClient,
    private readonly platform: Platform,
    private readonly workspace: PageTree,
  ) {}

  /** Load a database doc (once) and resolve its handle. */
  load(databaseId: string): Promise<DatabaseHandle> {
    const existing = this.entries.get(databaseId);
    if (existing) return existing.ready;
    const docHandle = this.client.acquire(databaseId);
    const entry: Entry = {
      handle: null,
      release: () => docHandle.release(),
      ready: docHandle.ready.then(() => {
        const handle = new DatabaseHandle(databaseId, docHandle.doc);
        // Rows trashed over 30 days ago are deleted for good, like pages.
        emptyRowTrashBefore(docHandle.doc, Date.now() - TRASH_RETENTION_MS);
        handle.subscribe(this.changed);
        entry.handle = handle;
        this.changed();
        return handle;
      }),
    };
    this.entries.set(databaseId, entry);
    return entry.ready;
  }

  /** Whether a database page exists (so a relation's target can be loaded). */
  exists(databaseId: string): boolean {
    const page = getPage(this.workspace, databaseId);
    return page?.kind === 'database';
  }

  private readonly computedCaches = new WeakMap<DatabaseHandle, ComputedCache>();

  /**
   * A database snapshot with relations, rollups and formulas computed. Related
   * databases load in the background (subscribers hear when they arrive).
   */
  computed(databaseId: string, ctx: DisplayContext): DatabaseSnapshot | null {
    const visiting = new Set<string>();
    const resolve = (id: string, compute: boolean): DatabaseSnapshot | undefined => {
      const handle = this.get(id);
      if (!handle) {
        if (this.exists(id)) void this.load(id).catch(() => {});
        return undefined;
      }
      const raw = handle.snapshot();
      // A cycle of rollups reads the stored values of the database it started from.
      if (!compute || visiting.has(id)) return raw;
      let cache = this.computedCaches.get(handle);
      if (!cache) {
        cache = new ComputedCache();
        this.computedCaches.set(handle, cache);
      }
      visiting.add(id);
      try {
        return cache.apply(raw, ctx, resolve, id);
      } finally {
        visiting.delete(id);
      }
    };
    return resolve(databaseId, true) ?? null;
  }

  /** Loaded database docs, for relation edits that touch both sides. */
  readonly resolveDoc: DocResolver = (id) => this.get(id)?.doc;

  /** The handle, if the database is loaded. */
  get(databaseId: string): DatabaseHandle | null {
    return this.entries.get(databaseId)?.handle ?? null;
  }

  /** Load every database in the workspace (e.g. to list trashed rows). */
  async loadAll(): Promise<void> {
    await Promise.all(
      listPages(this.workspace)
        .filter((p) => p.kind === 'database')
        .map((p) => this.load(p.id)),
    );
  }

  loaded(): DatabaseHandle[] {
    return [...this.entries.values()].flatMap((e) => (e.handle ? [e.handle] : []));
  }

  /** The loaded database that has this row. */
  databaseOf(rowId: string): DatabaseHandle | null {
    for (const handle of this.loaded()) if (hasRow(handle.doc, rowId)) return handle;
    return null;
  }

  /**
   * A row and its database, if loaded. Otherwise starts looking it up in the
   * background (subscribers hear when it arrives) and returns null.
   */
  row(rowId: string): { row: Row; databaseId: string } | null {
    const handle = this.databaseOf(rowId);
    const row = handle?.row(rowId);
    if (handle && row) return { row, databaseId: handle.id };
    void this.locate(rowId);
    return null;
  }

  /** Whether a lookup for this id is still running. */
  isLocating(id: string): boolean {
    return this.locating.has(id);
  }

  /**
   * Find the database of a row and load it. Resolves the database id, or null when
   * `id` isn't a row (a page, or unknown).
   */
  locate(id: string): Promise<string | null> {
    const loaded = this.databaseOf(id);
    if (loaded) return Promise.resolve(loaded.id);
    const pending = this.locating.get(id);
    if (pending) return pending;
    const missedAt = this.misses.get(id);
    if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return Promise.resolve(null);
    const lookup = this.platform
      .locatePage(id)
      .then(async (found) => {
        if (!found?.databaseId) {
          this.misses.set(id, Date.now());
          return null;
        }
        await this.load(found.databaseId);
        return found.databaseId;
      })
      .catch((error: unknown) => {
        console.error(`Failed to locate ${id}`, error);
        return null;
      })
      .finally(() => {
        this.locating.delete(id);
        this.changed();
      });
    this.locating.set(id, lookup);
    return lookup;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private readonly changed = () => {
    this.version++;
    for (const listener of this.listeners) listener();
  };

  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.handle?.destroy();
      entry.release();
    }
    this.entries.clear();
    this.listeners.clear();
  }
}

/** Create a database page and set up its doc. Resolves its id. */
export async function createDatabase(
  client: DocClient,
  workspace: PageTree,
  options: { parentId: PageId | null; title?: string },
): Promise<PageId> {
  const id = createPage(workspace, { ...options, kind: 'database' });
  await setUpDatabaseDoc(client, id);
  return id;
}

/** Turn an empty page into a full-page database (Notion's "Get started with: Table"). */
export async function convertToDatabase(
  client: DocClient,
  workspace: PageTree,
  pageId: PageId,
): Promise<void> {
  await setUpDatabaseDoc(client, pageId);
  setPageKind(workspace, pageId, 'database');
}

async function setUpDatabaseDoc(client: DocClient, id: PageId): Promise<void> {
  const handle = client.acquire(id);
  try {
    await handle.ready;
    initDatabase(handle.doc, { databaseId: id });
  } finally {
    handle.release();
  }
}
