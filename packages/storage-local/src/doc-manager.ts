import {
  Forest,
  WORKSPACE_DOC_ID,
  getPagesMap,
  isTreeDocId,
  isCommentsDocId,
  localTree,
  isInTrash,
  listPages,
  MEMBERS_DOC_ID,
  userNames,
  pageText,
  readReminders,
  reminderTime,
  touchPage,
  syncedBlockIds,
  readLinks,
} from '@workspace/core';
import {
  hasRow,
  isDatabaseDoc,
  readDatabase,
  readDateReminders,
  relationIds,
  rowPropertiesText,
  touchRow,
} from '@workspace/database';
import * as Y from 'yjs';
import type { PageIndexRow, RowIndexRow, SqliteStore } from './sqlite-store';

export type UpdateListener = (docId: string, update: Uint8Array, origin: unknown) => void;

export interface DocManagerOptions {
  /** Compact a document's update log into one row once it has more rows than this. */
  compactThreshold?: number;
  /** Debounce for search-index and `updatedAt` writes after an edit. */
  indexDelayMs?: number;
  /** Called after a page's reminders were re-indexed (to reschedule notifications). */
  onRemindersChanged?: () => void;
  /**
   * Page history: a snapshot is taken before an edit when the last one is older than
   * this (so every editing session starts from a saved version).
   */
  versionIntervalMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

/** Links found in page content (relations are indexed from databases). */
const CONTENT_LINK_KINDS = ['mention', 'link', 'pageLink', 'synced', 'linkedDatabase'] as const;

/** Origin for changes the manager makes itself (e.g. bumping `updatedAt`). */
export const MAIN_ORIGIN = Symbol('main');
const LOAD_ORIGIN = Symbol('load');
/** Origin for updates that came from the sync server (never sent back to it). */
export const SYNC_ORIGIN = Symbol('sync');

interface LoadedDoc {
  doc: Y.Doc;
  refs: number;
}

/**
 * Authoritative copy of every open Yjs document, living in the Electron main process.
 *
 * Every change, from any window, is applied here, appended to SQLite and fanned out
 * to listeners (other windows now, the sync server later). The search index and page
 * `updatedAt` stamps are derived here so they stay correct whichever window edits.
 */
export class DocManager {
  /**
   * Every page tree this device holds: the workspace doc, and in a synced workspace the
   * tree docs of the other scopes the person can read (Phase 5). Held for the manager's
   * whole life; the page index covers all of them.
   */
  readonly forest = new Forest();
  private readonly treeObservers = new Map<string, () => void>();
  private readonly docs = new Map<string, LoadedDoc>();
  private readonly listeners = new Set<UpdateListener>();
  private readonly resetListeners = new Set<(docId: string) => void>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly compactThreshold: number;
  private readonly indexDelayMs: number;
  private readonly onRemindersChanged: () => void;
  private readonly versionIntervalMs: number;
  private readonly now: () => number;
  /** Time of each doc's newest version (cached from the store). */
  private readonly lastVersion = new Map<string, number>();
  /** Docs changed on this device since they were last indexed. */
  private readonly editedHere = new Set<string>();
  /** Queue local changes for the sync server (while sync is on). */
  private outbox = false;

  constructor(
    private readonly store: SqliteStore,
    options: DocManagerOptions = {},
  ) {
    this.compactThreshold = options.compactThreshold ?? 200;
    this.indexDelayMs = options.indexDelayMs ?? 750;
    this.onRemindersChanged = options.onRemindersChanged ?? (() => {});
    this.versionIntervalMs = options.versionIntervalMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
    this.store.pruneVersions(this.now());
    this.addTree(WORKSPACE_DOC_ID);
    for (const docId of this.store.listDocIds()) {
      if (isTreeDocId(docId) && docId !== WORKSPACE_DOC_ID) this.addTree(docId);
    }
    this.indexWorkspace();
  }

  /** The first scope's tree doc (a local workspace's only one). */
  get workspace(): Y.Doc {
    return this.docs.get(WORKSPACE_DOC_ID)!.doc;
  }

  /** Hold a tree doc for good, and keep the page index and page docs in step with it. */
  private addTree(docId: string): Y.Doc {
    const existing = this.docs.get(docId);
    if (existing && this.treeObservers.has(docId)) return existing.doc;
    const doc = existing?.doc ?? this.load(docId);
    this.docs.get(docId)!.refs = Infinity; // never unloaded
    const pages = getPagesMap(doc);
    const observer = (event: Y.YMapEvent<Y.Map<unknown>>) => {
      const fromSync = event.transaction.origin === SYNC_ORIGIN;
      event.changes.keys.forEach((change, pageId) => {
        if (change.action === 'delete') {
          // Still in another tree: it moved there (or this was its stub).
          if (this.forest.entryOf(pageId)) return;
          // Gone by sync: maybe on its way to another scope's tree (the server moves
          // shared pages), so only its index entries go; deleted here: all of it.
          if (fromSync) this.store.removePageIndex(pageId);
          else this.dropPageDoc(pageId);
        } else if (change.action === 'add') {
          // A synced page's content can arrive before the page itself: index it now.
          this.indexStoredLater(pageId);
        }
      });
    };
    pages.observe(observer);
    this.treeObservers.set(docId, () => pages.unobserve(observer));
    this.syncForest();
    return doc;
  }

  private dropTree(docId: string): void {
    this.treeObservers.get(docId)?.();
    this.treeObservers.delete(docId);
    const entry = this.docs.get(docId);
    entry?.doc.destroy();
    this.docs.delete(docId);
    this.syncForest();
  }

  private syncForest(): void {
    this.forest.set(
      [...this.treeObservers.keys()].map((id) => localTree(this.docs.get(id)!.doc, id)),
    );
  }

  /** Start (or stop) queueing every local change in the sync outbox. */
  setOutbox(enabled: boolean): void {
    this.outbox = enabled;
  }

  /**
   * Queue the full state of every doc for the server: when a workspace starts syncing
   * (its existing content), or when the server turns out to have lost data. Merging is
   * idempotent, so sending what the server already has is harmless.
   */
  queueFullState(): number {
    const ids = new Set([...this.store.listDocIds(), ...this.docs.keys()]);
    let queued = 0;
    for (const id of ids) {
      const open = this.docs.get(id)?.doc;
      let state: Uint8Array | null = null;
      if (open) state = Y.encodeStateAsUpdate(open);
      else {
        const updates = this.store.getUpdates(id);
        if (updates.length) state = Y.mergeUpdates(updates);
      }
      if (state && state.byteLength > 2) {
        this.store.outboxAdd(id, state);
        queued++;
      }
    }
    return queued;
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load (or reuse) a document and return its full state. Pair with `release`. */
  open(docId: string): Uint8Array {
    if (isTreeDocId(docId)) this.addTree(docId);
    const entry = this.docs.get(docId);
    if (entry) {
      entry.refs++;
      return Y.encodeStateAsUpdate(entry.doc);
    }
    const doc = this.load(docId);
    this.docs.get(docId)!.refs = 1;
    return Y.encodeStateAsUpdate(doc);
  }

  release(docId: string): void {
    const entry = this.docs.get(docId);
    if (!entry || entry.refs === Infinity) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.flush(docId);
    entry.doc.destroy();
    this.docs.delete(docId);
  }

  applyUpdate(docId: string, update: Uint8Array, origin: unknown): void {
    if (isTreeDocId(docId)) this.addTree(docId);
    const entry = this.docs.get(docId);
    if (entry) {
      this.maybeSnapshot(docId, entry.doc);
      Y.applyUpdate(entry.doc, update, origin);
      return;
    }
    // An update for a doc nobody has open (e.g. a late update from a closing window).
    const doc = this.load(docId);
    this.maybeSnapshot(docId, doc);
    Y.applyUpdate(doc, update, origin);
    this.docs.get(docId)!.refs = 0;
    this.release(docId);
  }

  // --- Access changes (sync) -----------------------------------------------------

  /**
   * A doc was replaced (`reset`) or taken away (`forget`): what windows show of it is
   * out of date, and must be loaded again.
   */
  onReset(listener: (docId: string) => void): () => void {
    this.resetListeners.add(listener);
    return () => this.resetListeners.delete(listener);
  }

  /**
   * Replace a doc with `state`: the server's copy, after it refused this device's
   * changes (the person may not change it). Unsent changes to it are dropped.
   */
  reset(docId: string, state: Uint8Array): void {
    // (A crash in between leaves unsent changes: they're refused again, and reset again.)
    this.store.replaceUpdates(docId, state);
    this.store.outboxRemoveDoc(docId);
    const entry = this.docs.get(docId);
    if (this.treeObservers.has(docId)) {
      // A tree: held for good, so swapped for the new state in place.
      this.dropTree(docId);
      this.addTree(docId);
    } else if (entry) {
      // Reload it from the new state, keeping the windows' references.
      const refs = entry.refs;
      entry.doc.destroy();
      this.docs.delete(docId);
      this.load(docId);
      this.docs.get(docId)!.refs = refs;
    }
    this.scheduleIndex(docId);
    for (const listener of this.resetListeners) listener(docId);
  }

  /**
   * Delete docs the person may no longer read: their content, index entries, history,
   * reminders and unsent changes (a database takes its rows along).
   */
  forget(docIds: readonly string[]): void {
    for (const docId of docIds) {
      this.store.outboxRemoveDoc(docId);
      if (isTreeDocId(docId)) {
        this.dropTree(docId);
        this.store.deleteDoc(docId);
        // The workspace doc stays held (empty): it's always part of the forest.
        if (docId === WORKSPACE_DOC_ID) this.addTree(docId);
      } else {
        this.dropPageDoc(docId);
        this.store.removePageIndex(docId);
      }
    }
    for (const docId of docIds) for (const listener of this.resetListeners) listener(docId);
  }

  // --- Page history ------------------------------------------------------------

  /** Save a doc's current state as a version (if it has any content). */
  snapshot(docId: string, reason: string): number | null {
    if (isTreeDocId(docId) || isCommentsDocId(docId)) return null;
    const open = this.docs.get(docId);
    const doc = open?.doc ?? this.load(docId);
    try {
      // An empty doc (a page nobody has typed in yet) has nothing to go back to.
      if (Y.encodeStateVector(doc).length <= 1) return null;
      const now = this.now();
      this.lastVersion.set(docId, now);
      return this.store.addVersion(docId, Y.encodeStateAsUpdate(doc), reason, now);
    } finally {
      if (!open) {
        this.docs.get(docId)!.refs = 0;
        this.release(docId);
      }
    }
  }

  versions(docId: string) {
    return this.store.listVersions(docId);
  }

  versionState(id: number): Uint8Array | null {
    return this.store.getVersionState(id)?.state ?? null;
  }

  /** Before an edit: snapshot when the last version is older than the interval. */
  private maybeSnapshot(docId: string, doc: Y.Doc): void {
    // Comments have no history of their own (a page's version doesn't include them).
    if (isTreeDocId(docId) || isCommentsDocId(docId)) return;
    let last = this.lastVersion.get(docId);
    if (last === undefined) {
      last = this.store.lastVersionTime(docId) ?? -Infinity;
      this.lastVersion.set(docId, last);
    }
    if (this.now() - last < this.versionIntervalMs) return;
    if (Y.encodeStateVector(doc).length <= 1) return;
    this.lastVersion.set(docId, this.now());
    this.store.addVersion(docId, Y.encodeStateAsUpdate(doc), 'edit', this.now());
  }

  /**
   * Rebuild the search index, links and reminders from every stored doc (after a
   * restore). Databases go first, so their rows are known when row pages are indexed.
   */
  reindexAll(): void {
    this.indexWorkspace();
    const later: string[] = [];
    const indexOne = (docId: string, onlyDatabases: boolean) => {
      const open = this.docs.has(docId);
      const doc = open ? this.docs.get(docId)!.doc : this.load(docId);
      if (!onlyDatabases || isDatabaseDoc(doc)) this.index(docId);
      else later.push(docId);
      if (!open) {
        this.docs.get(docId)!.refs = 1;
        this.release(docId);
      }
    };
    for (const docId of this.store.listDocIds()) {
      if (!isTreeDocId(docId)) indexOne(docId, true);
    }
    for (const docId of later) indexOne(docId, false);
  }

  /** Write any debounced index updates now. Call before quitting. */
  flush(docId?: string): void {
    const ids = docId === undefined ? [...this.pending.keys()] : [docId];
    for (const id of ids) {
      const timer = this.pending.get(id);
      if (timer === undefined) continue;
      clearTimeout(timer);
      this.pending.delete(id);
      this.index(id);
    }
  }

  close(): void {
    if (this.storedTimer) clearTimeout(this.storedTimer);
    this.storedTimer = null;
    this.flush();
    for (const { doc } of this.docs.values()) doc.destroy();
    this.docs.clear();
    this.listeners.clear();
  }

  private load(docId: string): Y.Doc {
    const doc = new Y.Doc({ guid: docId });
    const updates = this.store.getUpdates(docId);
    if (updates.length > 0) {
      Y.applyUpdate(doc, Y.mergeUpdates(updates), LOAD_ORIGIN);
      if (updates.length > this.compactThreshold) {
        this.store.replaceUpdates(docId, Y.encodeStateAsUpdate(doc));
      }
    }
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.store.appendUpdate(docId, update, this.outbox && origin !== SYNC_ORIGIN);
      for (const listener of this.listeners) listener(docId, update, origin);
      if (origin === MAIN_ORIGIN) return;
      // Only a change made here bumps "last edited": the device that made a synced
      // change already did (and bumping it again would echo back to every device).
      if (origin !== SYNC_ORIGIN) this.editedHere.add(docId);
      this.scheduleIndex(docId);
    });
    this.docs.set(docId, { doc, refs: 0 });
    return doc;
  }

  private scheduleIndex(docId: string): void {
    const existing = this.pending.get(docId);
    if (existing !== undefined) clearTimeout(existing);
    this.pending.set(
      docId,
      setTimeout(() => {
        this.pending.delete(docId);
        this.index(docId);
      }, this.indexDelayMs),
    );
  }

  private index(docId: string): void {
    const edited = this.editedHere.delete(docId);
    if (isTreeDocId(docId)) {
      this.indexWorkspace();
      return;
    }
    const entry = this.docs.get(docId);
    if (!entry || isCommentsDocId(docId)) return;
    if (isDatabaseDoc(entry.doc)) {
      this.indexDatabase(docId, entry.doc);
      return;
    }
    const isPage = !!this.forest.entryOf(docId);
    const databaseId = isPage ? null : this.store.locatePage(docId)?.databaseId;
    if (!isPage && !databaseId) {
      // A synced block's doc: re-index the pages that show it.
      for (const host of this.syncedHosts.get(docId) ?? []) {
        const hostDoc = this.docs.get(host)?.doc;
        if (hostDoc) this.indexContent(host, hostDoc);
      }
      return;
    }
    this.indexContent(docId, entry.doc);
    if (!edited) return;
    if (databaseId) {
      // A row's page: "last edited" lives in its database doc (if it's open).
      const db = this.docs.get(databaseId)?.doc;
      if (db && hasRow(db, docId)) db.transact(() => touchRow(db, docId, undefined), MAIN_ORIGIN);
      return;
    }
    const tree = this.forest.treeOf(docId)!.doc;
    tree.transact(() => touchPage(tree, docId), MAIN_ORIGIN);
    this.indexWorkspace();
  }

  private readonly storedToIndex = new Set<string>();
  private storedTimer: ReturnType<typeof setTimeout> | null = null;

  /** Index the stored content of pages that just appeared (soon, all at once). */
  private indexStoredLater(docId: string): void {
    this.storedToIndex.add(docId);
    this.storedTimer ??= setTimeout(() => {
      this.storedTimer = null;
      const ids = [...this.storedToIndex];
      this.storedToIndex.clear();
      // The pages' index rows first, so their bodies have somewhere to go.
      this.indexWorkspace();
      for (const id of ids) {
        if (this.docs.has(id) || this.store.getUpdates(id).length === 0) continue;
        this.load(id);
        this.index(id);
        this.docs.get(id)!.refs = 1;
        this.release(id);
      }
    }, this.indexDelayMs);
  }

  /** Pages that show each synced block (filled as pages are indexed). */
  private readonly syncedHosts = new Map<string, Set<string>>();

  /** A doc that may not be open (read-only): from memory, or from its stored updates. */
  private storedDoc(docId: string): Y.Doc | null {
    const open = this.docs.get(docId)?.doc;
    if (open) return open;
    const updates = this.store.getUpdates(docId);
    if (updates.length === 0) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.mergeUpdates(updates));
    return doc;
  }

  /** Text of a doc that may not be open: from memory, or from its stored updates. */
  private docText(docId: string): string {
    const open = this.docs.get(docId)?.doc;
    if (open) return pageText(open);
    const updates = this.store.getUpdates(docId);
    if (updates.length === 0) return '';
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, Y.mergeUpdates(updates));
      return pageText(doc);
    } finally {
      doc.destroy();
    }
  }

  /** Search text and reminders of a page's (or row's) content. */
  private indexContent(docId: string, doc: Y.Doc): void {
    // Synced blocks' content is searchable on every page that shows it.
    const synced = syncedBlockIds(doc);
    for (const id of synced) {
      let hosts = this.syncedHosts.get(id);
      if (!hosts) this.syncedHosts.set(id, (hosts = new Set()));
      hosts.add(docId);
    }
    this.store.replaceLinks(docId, CONTENT_LINK_KINDS, readLinks(doc));
    const text = [pageText(doc), ...synced.map((id) => this.docText(id))]
      .filter(Boolean)
      .join('\n');
    this.store.setPageBody(docId, text);
    this.store.replaceReminders(
      docId,
      readReminders(doc).flatMap(({ blockId, date, text }, index) => {
        const fireAt = reminderTime(date);
        // Blocks always have ids in the editor; fall back to position for older content.
        return fireAt === null ? [] : [{ blockId: blockId ?? `#${index}`, fireAt, text }];
      }),
    );
    this.onRemindersChanged();
  }

  /** Index a database's rows: titles and property text, for search and links. */
  private indexDatabase(databaseId: string, doc: Y.Doc): void {
    const users = userNames(this.workspace, this.storedDoc(MEMBERS_DOC_ID));
    const db = readDatabase(doc);
    const rows: RowIndexRow[] = db.rows.map((row) => ({
      id: row.id,
      title: row.title,
      icon: row.icon,
      sortKey: row.sortKey,
      // Templates stay indexed (so their content is kept) but don't show in search.
      inTrash: row.trashedAt !== null || row.isTemplate,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      props: rowPropertiesText(row, db.properties, { users }),
    }));
    const { added, removed } = this.store.syncRowIndex(databaseId, rows);
    // Relations count as links from a row to the pages it relates to.
    const relations = db.properties.filter((p) => p.type === 'relation');
    for (const row of db.rows) {
      if (row.isTemplate) continue;
      this.store.replaceLinks(
        row.id,
        ['relation'],
        relations.flatMap((p) =>
          relationIds(row.values[p.id]).map((target) => ({
            target,
            kind: 'relation',
            blockId: null,
            snippet: p.name,
          })),
        ),
      );
    }
    this.store.replacePropertyReminders(databaseId, readDateReminders(db));
    this.onRemindersChanged();
    // Content typed (or synced) before the row reached the index.
    for (const id of added) {
      const content = this.docs.get(id)?.doc;
      if (content) this.indexContent(id, content);
      else this.indexStoredLater(id);
    }
    for (const id of removed) this.dropDoc(id);
  }

  private indexWorkspace(): void {
    const rows: PageIndexRow[] = listPages(this.forest).map((page) => ({
      id: page.id,
      parentId: page.parentId,
      title: page.title,
      icon: page.icon,
      sortKey: page.sortKey,
      inTrash: isInTrash(this.forest, page.id),
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    }));
    this.store.syncPageIndex(rows);
  }

  private dropPageDoc(pageId: string): void {
    // A deleted database takes its rows (and their content) with it.
    for (const rowId of this.store.rowIdsOf(pageId)) {
      this.dropDoc(rowId);
      this.store.removePageIndex(rowId);
    }
    this.dropDoc(pageId);
  }

  /** Forget a doc for good: in memory, its update log and its reminders. */
  private dropDoc(pageId: string): void {
    const timer = this.pending.get(pageId);
    if (timer !== undefined) clearTimeout(timer);
    this.pending.delete(pageId);
    this.editedHere.delete(pageId);
    const entry = this.docs.get(pageId);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(pageId);
    }
    this.store.deleteDoc(pageId);
    this.store.deleteReminders(pageId);
    this.store.deleteVersions(pageId);
    this.lastVersion.delete(pageId);
  }
}
