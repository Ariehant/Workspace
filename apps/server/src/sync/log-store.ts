import type { PgStore } from '@workspace/storage-remote';
import type { LogStore } from '@workspace/sync';

/** The sync hub's view of the Postgres update log. */
export function pgLogStore(store: PgStore): LogStore {
  return {
    append: (workspaceId, updates) => store.appendUpdates(workspaceId, updates),
    since: (workspaceId, cursor, limit) => store.updatesSince(workspaceId, cursor, limit),
    latest: (workspaceId) => store.latestSeq(workspaceId),
    docState: (workspaceId, docId) => store.docState(workspaceId, docId),
  };
}
