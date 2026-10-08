/**
 * Keeps each workspace's search index (and the links between pages, for backlinks) up
 * to date by following its update log: it
 * remembers how far it got (`search_state`), and on each run re-reads the docs changed
 * since then (their merged state) and indexes them with the same pure functions the
 * desktop uses. Restarts, catch-ups and compactions need nothing special.
 */
import {
  MEMBERS_DOC_ID,
  WORKSPACE_DOC_ID,
  isCommentsDocId,
  readLinks,
  isInTrash,
  listPages,
  pageText,
  userNames,
} from '@workspace/core';
import { isDatabaseDoc, readDatabase, rowPropertiesText } from '@workspace/database';
import type { PgStore } from '@workspace/storage-remote';
import * as Y from 'yjs';

export interface IndexerOptions {
  /** Wait this long after a change before indexing (edits come in bursts). */
  delayMs?: number;
  onError?: (error: unknown, workspaceId: string) => void;
}

/** The workspace doc, or a scope's own tree (`tree:<scope id>`). */
const isTreeDoc = (docId: string) => docId === WORKSPACE_DOC_ID || docId.startsWith('tree:');

/** Docs read per step (a large catch-up is indexed in several). */
const BATCH = 2000;

export class Indexer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private closed = false;
  private readonly delayMs: number;

  constructor(
    private readonly store: PgStore,
    private readonly options: IndexerOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 1000;
  }

  /** Index every workspace that's behind its log (at startup). */
  async catchUp(): Promise<void> {
    for (const id of await this.store.search.behind()) this.schedule(id, 0);
  }

  /** A workspace's log grew: index it soon. */
  schedule(workspaceId: string, delayMs = this.delayMs): void {
    if (this.closed || this.timers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(workspaceId);
      void this.run(workspaceId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(workspaceId, timer);
  }

  /** Index a workspace now (one run at a time per workspace). Resolves when up to date. */
  run(workspaceId: string): Promise<void> {
    const current = this.running.get(workspaceId);
    if (current) {
      this.again.add(workspaceId);
      return current;
    }
    const job = (async () => {
      try {
        do {
          this.again.delete(workspaceId);
          await this.indexWorkspace(workspaceId);
        } while (this.again.has(workspaceId) && !this.closed);
      } catch (error) {
        this.options.onError?.(error, workspaceId);
      } finally {
        this.running.delete(workspaceId);
      }
    })();
    this.running.set(workspaceId, job);
    return job;
  }

  /** Stop scheduling; wait for runs in progress. */
  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all(this.running.values());
  }

  private async indexWorkspace(workspaceId: string) {
    const { search } = this.store;
    for (;;) {
      const from = await search.indexedSeq(workspaceId);
      const { docIds, lastSeq } = await search.changedSince(workspaceId, from, BATCH);
      if (docIds.length === 0) return;
      // Page trees first: they say which docs are pages.
      const ordered = [...docIds.filter(isTreeDoc), ...docIds.filter((id) => !isTreeDoc(id))];
      let users: ReadonlyMap<string, string> | null = null;
      for (const docId of ordered) {
        if (this.closed) return;
        const doc = await this.load(workspaceId, docId);
        if (!doc) continue;
        try {
          if (isTreeDoc(docId)) {
            // A scope's tree: its pages are searchable by whoever may read the scope.
            await search.setPages(
              workspaceId,
              await this.store.scopes.placementOf(workspaceId, docId),
              listPages(doc).map((p) => ({
                id: p.id,
                title: p.title,
                icon: p.icon,
                inTrash: isInTrash(doc, p.id),
                updatedAt: p.updatedAt,
              })),
            );
          } else if (isDatabaseDoc(doc)) {
            users ??= await this.users(workspaceId);
            const db = readDatabase(doc);
            await search.setRows(
              workspaceId,
              docId,
              await this.store.scopes.placementOf(workspaceId, docId),
              db.rows.map((row) => ({
                id: row.id,
                title: row.title,
                icon: row.icon,
                // Templates aren't search results (as on the desktop).
                inTrash: row.trashedAt !== null || row.isTemplate,
                updatedAt: row.updatedAt,
                props: rowPropertiesText(row, db.properties, { users: users! }),
              })),
            );
          } else if (!isCommentsDocId(docId)) {
            await search.setBody(workspaceId, docId, pageText(doc));
            // Links in its content (backlinks), with the same function the desktop uses.
            await this.store.pages.setLinks(workspaceId, docId, readLinks(doc));
          }
        } finally {
          doc.destroy();
        }
      }
      await search.setIndexedSeq(workspaceId, lastSeq);
    }
  }

  private async load(workspaceId: string, docId: string): Promise<Y.Doc | null> {
    const state = await this.store.docState(workspaceId, docId);
    if (!state) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  }

  private async users(workspaceId: string): Promise<ReadonlyMap<string, string>> {
    const doc = await this.load(workspaceId, WORKSPACE_DOC_ID);
    const members = await this.load(workspaceId, MEMBERS_DOC_ID);
    try {
      return userNames(doc, members);
    } finally {
      doc?.destroy();
      members?.destroy();
    }
  }
}
