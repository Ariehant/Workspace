import { isTreeDocId } from '@workspace/core';
import type { AccessScope, ClientStore } from '@workspace/sync';
import { SYNC_ORIGIN, type DocManager } from './doc-manager';
import type { SqliteStore } from './sqlite-store';

/** The newest seq of the server's log applied here. */
export const SYNC_CURSOR = 'sync.cursor';
/** The scopes (and roles) this device holds, from the server's last `access`. */
export const SYNC_ACCESS = 'sync.access';

/**
 * The desktop's side of sync over the local database: the outbox (filled by the
 * DocManager as changes are stored), the cursor, and applying the server's updates
 * through the DocManager, so windows, the search index and history see them like any
 * other change, and they are never queued to go back.
 */
export class LocalSyncStore implements ClientStore {
  constructor(
    private readonly store: SqliteStore,
    private readonly manager: DocManager,
  ) {}

  cursor(): number {
    return this.store.getSetting<number>(SYNC_CURSOR) ?? 0;
  }

  pending(limit: number) {
    return this.store.outboxPending(limit);
  }

  acknowledge(localIds: number[]): void {
    this.store.outboxRemove(localIds);
  }

  applyRemote(items: { docId: string; update: Uint8Array }[], cursor: number): void {
    for (const item of items) this.manager.applyUpdate(item.docId, item.update, SYNC_ORIGIN);
    // After the updates: a crash in between applies them again next time (harmless),
    // where the other order could skip them for good.
    this.store.setSetting(SYNC_CURSOR, cursor);
  }

  /** Before the server's copy replaces them: keep the refused changes in the history. */
  denied(items: { localId: number; docId: string }[]): void {
    for (const docId of new Set(items.map((i) => i.docId))) {
      if (docId) this.manager.snapshot(docId, 'not-saved');
    }
  }

  reset(docId: string, state: Uint8Array): void {
    this.manager.reset(docId, state);
  }

  applyBackfill(items: { docId: string; update: Uint8Array }[]): void {
    for (const item of items) this.manager.applyUpdate(item.docId, item.update, SYNC_ORIGIN);
  }

  revoke(docIds: string[], scopes: string[]): void {
    // Stop claiming the scopes first: a crash midway gets the rest revoked again.
    if (scopes.length > 0) {
      this.store.setSetting(
        SYNC_ACCESS,
        this.access().filter((s) => !scopes.includes(s.id)),
      );
    }
    this.manager.forget(docIds);
  }

  setAccess(scopes: AccessScope[]): void {
    this.store.setSetting(SYNC_ACCESS, scopes);
  }

  knownScopes(): string[] {
    return this.access().map((s) => s.id);
  }

  /** The scopes and roles from the server's last word (also for showing read-only state). */
  access(): AccessScope[] {
    return this.store.getSetting<AccessScope[]>(SYNC_ACCESS) ?? [];
  }

  /**
   * The scope a doc the server may not have seen yet belongs in: its tree's, for a page
   * (or its comments); its database's, for a row. `null` (the workspace's default scope)
   * when this device can't tell.
   */
  scopeOf(docId: string): string | null {
    const scopes = this.access();
    const scopeOfTree = (treeId: string) => scopes.find((s) => s.treeDoc === treeId)?.id ?? null;
    if (isTreeDocId(docId)) return scopeOfTree(docId);
    const pageId = docId.startsWith('comments:') ? docId.slice('comments:'.length) : docId;
    const { forest } = this.manager;
    const databaseId = this.store.locatePage(pageId)?.databaseId;
    const tree = forest.treeOf(pageId) ?? (databaseId ? forest.treeOf(databaseId) : undefined);
    return tree ? scopeOfTree(tree.info.id) : null;
  }
}
