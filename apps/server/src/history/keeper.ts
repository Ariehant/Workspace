/**
 * Page history on the server (Phase 5 M7): a log follower notes which docs changed, and
 * once one has been quiet for a while (10 minutes) its state is kept as a snapshot, with
 * who changed it since the last one. Snapshots are pruned like the desktop's versions.
 */
import { COMMENTS_PREFIX, MEMBERS_DOC_ID, WORKSPACE_DOC_ID } from '@workspace/core';
import type { PgStore } from '@workspace/storage-remote';
import * as Y from 'yjs';

const FOLLOWER = 'history';

export interface HistoryOptions {
  /** Snapshot a doc once it has had no changes for this long. */
  quietMs?: number;
  /** Look for quiet docs this often. */
  pollMs?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
}

/** Docs with history: page and row content, and databases (not trees, comments, members). */
export const hasHistory = (docId: string) =>
  docId !== WORKSPACE_DOC_ID &&
  docId !== MEMBERS_DOC_ID &&
  !docId.startsWith('tree:') &&
  !docId.startsWith(COMMENTS_PREFIX);

export class HistoryKeeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private readonly following = new Map<string, Promise<void>>();
  private closed = false;
  private readonly quietMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: PgStore,
    private readonly options: HistoryOptions = {},
  ) {
    this.quietMs = options.quietMs ?? 10 * 60_000;
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    for (const id of await this.store.notifications.followersBehind(FOLLOWER)) {
      await this.follow(id);
    }
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 60_000);
    this.timer.unref?.();
  }

  /** A workspace's log grew: note the docs that changed. */
  follow(workspaceId: string): Promise<void> {
    const previous = this.following.get(workspaceId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (this.closed) return;
      try {
        const { notifications, pages } = this.store;
        const from = await notifications.followerSeq(workspaceId, FOLLOWER);
        const to = await this.store.latestSeq(workspaceId);
        if (to <= from) return;
        await pages.markChanged(workspaceId, from, to);
        await notifications.setFollowerSeq(workspaceId, FOLLOWER, to);
      } catch (error) {
        this.options.onError?.(error);
      }
    });
    this.following.set(workspaceId, next);
    void next.finally(() => {
      if (this.following.get(workspaceId) === next) this.following.delete(workspaceId);
    });
    return next;
  }

  /** Snapshot the docs that have been quiet long enough (one pass at a time). */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      try {
        const { pages } = this.store;
        for (const due of await pages.quietDocs(this.now() - this.quietMs)) {
          if (this.closed) return;
          if (hasHistory(due.docId)) await this.snapshot(due.workspaceId, due.docId, 'edit');
          await pages.donePending(due.workspaceId, due.docId, due.lastChange);
        }
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        this.ticking = null;
      }
    })();
    return this.ticking;
  }

  /**
   * Keep a doc's state now (also asked for by a client, e.g. before restoring a version).
   * Null if there's nothing new since the last snapshot, or nothing at all.
   */
  async snapshot(workspaceId: string, docId: string, reason: string): Promise<number | null> {
    const { pages } = this.store;
    const { rows } = await this.store.pool.query<{ seq: number | null }>(
      'SELECT max(seq) AS seq FROM doc_updates WHERE workspace_id = $1 AND doc_id = $2',
      [workspaceId, docId],
    );
    const seq = rows[0]?.seq ?? 0;
    const last = await pages.lastSnapshotSeq(workspaceId, docId);
    if (!seq || (seq <= last && reason === 'edit')) return null;
    const state = await this.store.docState(workspaceId, docId);
    if (!state) return null;
    // A doc nobody has written in has nothing to go back to.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const empty = Y.encodeStateVector(doc).length <= 1;
    doc.destroy();
    if (empty) return null;
    const id = await pages.addSnapshot({
      workspaceId,
      docId,
      seq,
      state,
      reason,
      authors: await pages.authorsSince(workspaceId, docId, last),
      now: this.now(),
    });
    await pages.pruneSnapshots(workspaceId, docId, this.now());
    return id;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.following.values(), this.ticking]);
  }
}
