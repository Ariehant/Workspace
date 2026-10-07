import type { ClientStore } from '@workspace/sync';
import { SYNC_ORIGIN, type DocManager } from './doc-manager';
import type { SqliteStore } from './sqlite-store';

/** The newest seq of the server's log applied here. */
export const SYNC_CURSOR = 'sync.cursor';

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
}
