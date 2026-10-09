/**
 * Notifications (Phase 5 M6). Follows each workspace's update log, like the search
 * indexer, with its own cursor (`log_followers`): for every doc changed since, it replays
 * the new updates on the doc as it was, one author at a time, and compares what each
 * added:
 *
 * - **Pages:** person mentions (`@Bob`) notify the person; whoever edits a page follows
 *   it; `@remind` mentions become reminders for whoever set them.
 * - **Comments:** mentions notify; a new thread notifies the page's followers, a reply
 *   them and the thread's participants; commenting follows the page.
 * - **Databases:** date properties with a reminder become reminders for whoever set them.
 *
 * Reminders fire from a loop that polls for due ones. Nothing goes to someone who can't
 * read the doc (when it's made, and again when listed), and each notification is made
 * once (a key per person). History before the notifier existed notifies nobody.
 */
import {
  COMMENTS_PREFIX,
  MEMBERS_DOC_ID,
  WORKSPACE_DOC_ID,
  commentEvents,
  commentText,
  isCommentsDocId,
  listPages,
  readPersonMentions,
  readReminders,
  readThreads,
  reminderKey,
  reminderTime,
  userNames,
  type NotificationData,
} from '@workspace/core';
import { isDatabaseDoc, readDatabase, readDateReminders } from '@workspace/database';
import type {
  LoggedUpdate,
  NewNotification,
  PgStore,
  StoredNotification,
  StoredReminder,
} from '@workspace/storage-remote';
import * as Y from 'yjs';
import type { AccessService, WorkspaceAccess } from '../access/service';

const FOLLOWER = 'notify';
/** Log rows read per step. */
const BATCH = 500;

export interface NotifierOptions {
  /** Wait this long after a change (edits come in bursts). */
  delayMs?: number;
  /** Look for due reminders this often. */
  reminderPollMs?: number;
  /** Send a notification to the person's open connections. */
  deliver?: (workspaceId: string, userId: string, notification: NotificationData) => void;
  onError?: (error: unknown, workspaceId: string | null) => void;
  now?: () => number;
}

const isTreeDoc = (docId: string) => docId === WORKSPACE_DOC_ID || docId.startsWith('tree:');

/** A notification as clients get it (without the doc it's checked against). */
export function toData(n: StoredNotification): NotificationData {
  return {
    id: n.id,
    kind: n.kind,
    pageId: n.pageId,
    title: n.title,
    blockId: n.blockId,
    threadId: n.threadId,
    actorId: n.actorId,
    text: n.text,
    createdAt: n.createdAt,
    readAt: n.readAt,
    archivedAt: n.archivedAt,
    key: n.key,
  };
}

/** Consecutive updates by the same person. */
function byAuthor(updates: LoggedUpdate[]): { userId: string | null; updates: LoggedUpdate[] }[] {
  const runs: { userId: string | null; updates: LoggedUpdate[] }[] = [];
  for (const u of updates) {
    const userId = u.userId ?? null;
    const last = runs.at(-1);
    if (last && last.userId === userId) last.updates.push(u);
    else runs.push({ userId, updates: [u] });
  }
  return runs;
}

export class Notifier {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private reminding: Promise<void> | null = null;
  private closed = false;
  private readonly delayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: PgStore,
    private readonly access: AccessService,
    private readonly options: NotifierOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 1000;
    this.now = options.now ?? Date.now;
  }

  /** Catch up every workspace behind its log, and start firing reminders. */
  async start(): Promise<void> {
    for (const id of await this.store.notifications.followersBehind(FOLLOWER)) {
      this.schedule(id, 0);
    }
    const every = this.options.reminderPollMs ?? 30_000;
    this.reminderTimer = setInterval(() => void this.fireReminders(), every);
    this.reminderTimer.unref?.();
    void this.fireReminders();
  }

  /** A workspace's log grew. */
  schedule(workspaceId: string, delayMs = this.delayMs): void {
    if (this.closed || this.timers.has(workspaceId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(workspaceId);
      void this.run(workspaceId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(workspaceId, timer);
  }

  /** Read a workspace's log to the end now (one run at a time per workspace). */
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
          await this.follow(workspaceId);
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

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    await Promise.all([...this.running.values(), this.reminding]);
  }

  // --- Making notifications -----------------------------------------------------------

  /** Store and deliver one, if its person may read its doc. */
  private async notify(access: WorkspaceAccess, n: NewNotification): Promise<void> {
    if (!access.isMember(n.userId)) return;
    if (n.docId && !access.canRead(access.roles(n.userId), n.docId)) return;
    const stored = await this.store.notifications.add(n);
    if (stored) this.options.deliver?.(n.workspaceId, n.userId, toData(stored));
  }

  /** People were given access to a scope (a teamspace, or a page shared on its own). */
  async accessGranted(
    workspaceId: string,
    scopeId: string,
    actorId: string,
    userIds: readonly string[],
  ): Promise<void> {
    const access = await this.access.workspace(workspaceId);
    const scope = access.scope(scopeId);
    if (!scope) return;
    // A shared page: its tree's top page.
    let pageId: string | null = null;
    if (scope.kind !== 'teamspace') {
      const state = await this.store.docState(workspaceId, scope.treeDoc);
      if (state) {
        const tree = new Y.Doc();
        Y.applyUpdate(tree, state);
        const pages = listPages(tree);
        const ids = new Set(pages.map((p) => p.id));
        pageId = pages.find((p) => !p.parentId || !ids.has(p.parentId))?.id ?? null;
        tree.destroy();
      }
    }
    for (const userId of userIds) {
      if (userId === actorId) continue;
      await this.notify(access, {
        workspaceId,
        userId,
        kind: 'access',
        pageId,
        title: scope.name,
        actorId,
        text: scope.kind === 'teamspace' ? `Added you to ${scope.name}` : `Shared ${scope.name}`,
        docId: scope.treeDoc,
      });
    }
  }

  /** A response to a form whose maker asked to be told (`userId`: the maker). */
  async formResponse(
    workspaceId: string,
    response: {
      userId: string;
      databaseId: string;
      rowId: string;
      formTitle: string;
      title: string;
      actorId: string | null;
    },
  ): Promise<void> {
    const access = await this.access.workspace(workspaceId);
    await this.notify(access, {
      workspaceId,
      userId: response.userId,
      kind: 'form',
      pageId: response.rowId,
      title: response.formTitle,
      actorId: response.actorId,
      text: response.title || 'Untitled',
      // Shown while the maker can still see the database.
      docId: response.databaseId,
    });
  }

  /** An automation's "send notification", or a problem with one (to its maker). */
  async automationNotice(
    workspaceId: string,
    notice: {
      userId: string;
      databaseId: string;
      pageId: string | null;
      title: string;
      text: string;
      key?: string;
    },
  ): Promise<void> {
    const access = await this.access.workspace(workspaceId);
    await this.notify(access, {
      workspaceId,
      userId: notice.userId,
      kind: 'automation',
      pageId: notice.pageId ?? notice.databaseId,
      title: notice.title,
      actorId: null,
      text: notice.text.slice(0, 500),
      // Shown while they can still see the database.
      docId: notice.databaseId,
      key: notice.key ?? null,
    });
  }

  // --- Following the log --------------------------------------------------------------

  private async follow(workspaceId: string): Promise<void> {
    const { notifications } = this.store;
    for (;;) {
      if (this.closed) return;
      const from = await notifications.followerSeq(workspaceId, FOLLOWER);
      const rows = await this.store.updatesSince(workspaceId, from, BATCH);
      if (rows.length === 0) return;
      const byDoc = new Map<string, LoggedUpdate[]>();
      for (const row of rows) {
        if (isTreeDoc(row.docId) || row.docId === MEMBERS_DOC_ID) continue;
        const list = byDoc.get(row.docId);
        if (list) list.push(row);
        else byDoc.set(row.docId, [row]);
      }
      const run = new Run(this, workspaceId, await this.access.workspace(workspaceId));
      for (const [docId, updates] of byDoc) {
        if (this.closed) return;
        await run.doc(docId, updates, from);
      }
      await notifications.setFollowerSeq(workspaceId, FOLLOWER, rows.at(-1)!.seq);
    }
  }

  // --- Reminders ----------------------------------------------------------------------

  /** Fire the reminders that are due (one pass at a time). */
  fireReminders(): Promise<void> {
    if (this.reminding) return this.reminding;
    this.reminding = (async () => {
      try {
        for (;;) {
          const due = await this.store.notifications.dueReminders(this.now());
          if (due.length === 0 || this.closed) return;
          for (const r of due) await this.fire(r);
        }
      } catch (error) {
        this.options.onError?.(error, null);
      } finally {
        this.reminding = null;
      }
    })();
    return this.reminding;
  }

  private async fire(r: StoredReminder): Promise<void> {
    const access = await this.access.workspace(r.workspaceId);
    await this.notify(access, {
      workspaceId: r.workspaceId,
      userId: r.userId,
      kind: 'reminder',
      pageId: r.pageId,
      title: await this.title(r.workspaceId, r.pageId),
      blockId: r.blockId.startsWith('prop:') ? null : r.blockId,
      text: r.text,
      docId: r.docId,
      key: reminderKey(r.pageId, r.blockId, r.fireAt),
    });
    await this.store.notifications.reminderFired(r);
  }

  /** A page's (or row's) title, as last indexed. */
  async title(workspaceId: string, pageId: string): Promise<string> {
    const { rows } = await this.store.pool.query<{ title: string }>(
      'SELECT title FROM search_index WHERE workspace_id = $1 AND id = $2',
      [workspaceId, pageId],
    );
    return rows[0]?.title ?? '';
  }

  /** @internal */
  get db() {
    return this.store;
  }

  /** @internal */
  send(access: WorkspaceAccess, n: NewNotification) {
    return this.notify(access, n);
  }
}

/** One pass over a workspace's new log rows. */
class Run {
  private names: ReadonlyMap<string, string> | null = null;
  private readonly titles = new Map<string, string>();

  constructor(
    private readonly notifier: Notifier,
    private readonly workspaceId: string,
    private readonly access: WorkspaceAccess,
  ) {}

  private get store() {
    return this.notifier.db;
  }

  private async title(pageId: string) {
    let title = this.titles.get(pageId);
    if (title === undefined) {
      title = await this.notifier.title(this.workspaceId, pageId);
      this.titles.set(pageId, title);
    }
    return title;
  }

  private async userNames() {
    if (!this.names) {
      const load = async (docId: string) => {
        const state = await this.store.docState(this.workspaceId, docId);
        if (!state) return null;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state);
        return doc;
      };
      const workspace = await load(WORKSPACE_DOC_ID);
      const members = await load(MEMBERS_DOC_ID);
      this.names = userNames(workspace, members);
      workspace?.destroy();
      members?.destroy();
    }
    return this.names;
  }

  private send(n: Omit<NewNotification, 'workspaceId'>) {
    return this.notifier.send(this.access, { ...n, workspaceId: this.workspaceId });
  }

  private follow(pageId: string, userId: string | null) {
    if (!userId) return;
    return this.store.notifications.setFollowing(this.workspaceId, pageId, userId, true, true);
  }

  /** The new updates of one doc (after log position `from`). */
  async doc(docId: string, updates: LoggedUpdate[], from: number): Promise<void> {
    const doc = new Y.Doc();
    const before = await this.store.docStateAt(this.workspaceId, docId, from);
    if (before) Y.applyUpdate(doc, before);
    // A compaction rewrote its history: what's new can't be told apart (stay quiet).
    const quiet = updates.some((u) => !u.userId);
    try {
      if (isCommentsDocId(docId)) await this.comments(docId, doc, updates, quiet);
      else await this.page(docId, doc, updates, quiet);
    } finally {
      doc.destroy();
    }
  }

  private async comments(docId: string, doc: Y.Doc, updates: LoggedUpdate[], quiet: boolean) {
    const pageId = docId.slice(COMMENTS_PREFIX.length);
    let threads = readThreads(doc);
    for (const run of byAuthor(updates)) {
      for (const u of run.updates) Y.applyUpdate(doc, u.data);
      const next = readThreads(doc);
      const events = quiet ? [] : commentEvents(threads, next);
      threads = next;
      if (events.length === 0) continue;
      const names = await this.userNames();
      const title = await this.title(pageId);
      for (const e of events) {
        await this.follow(pageId, e.author);
        const text = commentText(e.body, names).slice(0, 500);
        const told = new Set<string>([e.author]);
        const base = { pageId, title, threadId: e.threadId, actorId: e.author, text, docId };
        for (const userId of e.mentions) {
          if (told.has(userId)) continue;
          told.add(userId);
          await this.send({ ...base, userId, kind: 'mention', key: `c:${e.commentId}:${userId}` });
        }
        if (e.kind === 'edit') continue;
        const followers = await this.store.notifications.followers(this.workspaceId, pageId);
        const audience = e.kind === 'reply' ? [...followers, ...e.participants] : followers;
        for (const userId of audience) {
          if (told.has(userId)) continue;
          told.add(userId);
          await this.send({
            ...base,
            userId,
            kind: e.kind === 'reply' ? 'reply' : 'comment',
            key: `c:${e.commentId}:${userId}`,
          });
        }
      }
    }
  }

  private async page(docId: string, doc: Y.Doc, updates: LoggedUpdate[], quiet: boolean) {
    const key = (m: { blockId: string | null; userId: string }) => `${m.blockId}:${m.userId}`;
    let mentions = new Set(readPersonMentions(doc).map(key));
    let author: string | null = null;
    for (const run of byAuthor(updates)) {
      for (const u of run.updates) Y.applyUpdate(doc, u.data);
      if (run.userId) author = run.userId;
      if (isDatabaseDoc(doc)) continue;
      const now = readPersonMentions(doc);
      const added = now.filter((m) => !mentions.has(key(m)));
      mentions = new Set(now.map(key));
      if (!run.userId) continue;
      await this.follow(docId, run.userId);
      if (quiet) continue;
      for (const m of added) {
        if (m.userId === run.userId) continue;
        await this.send({
          userId: m.userId,
          kind: 'mention',
          pageId: docId,
          title: await this.title(docId),
          blockId: m.blockId,
          actorId: run.userId,
          text: m.text.slice(0, 500),
          docId,
          key: `m:${docId}:${key(m)}`,
        });
      }
    }
    await this.reminders(docId, doc, author);
  }

  /**
   * A doc's reminders now: each for whoever set it (the mention says; otherwise who set
   * it first, or the last to change it), at its time in their time zone.
   */
  private async reminders(docId: string, doc: Y.Doc, author: string | null) {
    const { notifications, accounts } = this.store;
    const existing = new Map(
      (await notifications.remindersOf(this.workspaceId, docId)).map((r) => [r.key, r]),
    );
    const zone = async (userIds: string[]) => accounts.timeZones(userIds.filter(Boolean));
    const next: Omit<StoredReminder, 'workspaceId' | 'docId'>[] = [];
    if (isDatabaseDoc(doc)) {
      const snapshot = readDatabase(doc);
      const owners = [...new Set([...[...existing.values()].map((r) => r.userId), author ?? ''])];
      const zones = await zone(owners);
      const at = new Map<string, Map<string, number>>();
      for (const tz of new Set(zones.values())) {
        at.set(
          tz,
          new Map(
            readDateReminders(snapshot, tz).map((r) => [
              `${r.rowId}/prop:${r.propertyId}`,
              r.fireAt,
            ]),
          ),
        );
      }
      for (const r of readDateReminders(snapshot, 'UTC')) {
        const k = `${r.rowId}/prop:${r.propertyId}`;
        const old = existing.get(k);
        const keep = old && at.get(zones.get(old.userId) ?? 'UTC')?.get(k) === old.fireAt;
        const owner = keep ? old.userId : (author ?? old?.userId);
        if (!owner) continue;
        const fireAt = at.get(zones.get(owner) ?? 'UTC')?.get(k) ?? r.fireAt;
        next.push({
          key: k,
          userId: owner,
          pageId: r.rowId,
          blockId: `prop:${r.propertyId}`,
          fireAt,
          text: r.text,
        });
      }
    } else {
      const found = readReminders(doc);
      const owners = new Map<number, string | null>();
      found.forEach((r, i) => {
        const k = `${r.blockId ?? `#${i}`}/${r.date}`;
        owners.set(i, r.userId ?? existing.get(k)?.userId ?? author);
      });
      const zones = await zone([...new Set([...owners.values()].filter((v): v is string => !!v))]);
      found.forEach((r, i) => {
        const owner = owners.get(i);
        if (!owner) return;
        const blockId = r.blockId ?? `#${i}`;
        const fireAt = reminderTime(r.date, zones.get(owner) ?? 'UTC');
        if (fireAt === null) return;
        next.push({
          key: `${blockId}/${r.date}`,
          userId: owner,
          pageId: docId,
          blockId,
          fireAt,
          text: r.text,
        });
      });
    }
    if (next.length === 0 && existing.size === 0) return;
    await notifications.replaceReminders(this.workspaceId, docId, next);
  }
}
