import {
  WORKSPACE_DOC_ID,
  getPagesMap,
  isInTrash,
  listPages,
  pageText,
  touchPage,
} from '@workspace/core';
import * as Y from 'yjs';
import type { PageIndexRow, SqliteStore } from './sqlite-store';

export type UpdateListener = (docId: string, update: Uint8Array, origin: unknown) => void;

export interface DocManagerOptions {
  /** Compact a document's update log into one row once it has more rows than this. */
  compactThreshold?: number;
  /** Debounce for search-index and `updatedAt` writes after an edit. */
  indexDelayMs?: number;
}

/** Origin for changes the manager makes itself (e.g. bumping `updatedAt`). */
export const MAIN_ORIGIN = Symbol('main');
const LOAD_ORIGIN = Symbol('load');

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
  readonly workspace: Y.Doc;
  private readonly docs = new Map<string, LoadedDoc>();
  private readonly listeners = new Set<UpdateListener>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly compactThreshold: number;
  private readonly indexDelayMs: number;

  constructor(
    private readonly store: SqliteStore,
    options: DocManagerOptions = {},
  ) {
    this.compactThreshold = options.compactThreshold ?? 200;
    this.indexDelayMs = options.indexDelayMs ?? 750;
    this.workspace = this.load(WORKSPACE_DOC_ID);
    this.docs.get(WORKSPACE_DOC_ID)!.refs = Infinity; // never unloaded

    getPagesMap(this.workspace).observe((event) => {
      event.changes.keys.forEach((change, pageId) => {
        if (change.action === 'delete') this.dropPageDoc(pageId);
      });
    });
    this.indexWorkspace();
  }

  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Load (or reuse) a document and return its full state. Pair with `release`. */
  open(docId: string): Uint8Array {
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
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.flush(docId);
    entry.doc.destroy();
    this.docs.delete(docId);
  }

  applyUpdate(docId: string, update: Uint8Array, origin: unknown): void {
    const entry = this.docs.get(docId);
    if (entry) {
      Y.applyUpdate(entry.doc, update, origin);
      return;
    }
    // An update for a doc nobody has open (e.g. a late update from a closing window).
    const doc = this.load(docId);
    Y.applyUpdate(doc, update, origin);
    this.docs.get(docId)!.refs = 0;
    this.release(docId);
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
      this.store.appendUpdate(docId, update);
      for (const listener of this.listeners) listener(docId, update, origin);
      if (origin !== MAIN_ORIGIN) this.scheduleIndex(docId);
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
    if (docId === WORKSPACE_DOC_ID) {
      this.indexWorkspace();
      return;
    }
    const entry = this.docs.get(docId);
    if (!entry || !getPagesMap(this.workspace).has(docId)) return;
    this.store.setPageBody(docId, pageText(entry.doc));
    this.workspace.transact(() => touchPage(this.workspace, docId), MAIN_ORIGIN);
    this.indexWorkspace();
  }

  private indexWorkspace(): void {
    const rows: PageIndexRow[] = listPages(this.workspace).map((page) => ({
      id: page.id,
      parentId: page.parentId,
      title: page.title,
      icon: page.icon,
      sortKey: page.sortKey,
      inTrash: isInTrash(this.workspace, page.id),
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    }));
    this.store.syncPageIndex(rows);
  }

  private dropPageDoc(pageId: string): void {
    const timer = this.pending.get(pageId);
    if (timer !== undefined) clearTimeout(timer);
    this.pending.delete(pageId);
    const entry = this.docs.get(pageId);
    if (entry) {
      entry.doc.destroy();
      this.docs.delete(pageId);
    }
    this.store.deleteDoc(pageId);
  }
}
