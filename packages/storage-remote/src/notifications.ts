import type pg from 'pg';

export type NotificationKindName =
  'mention' | 'comment' | 'reply' | 'reminder' | 'access' | 'form' | 'automation';

export interface NewNotification {
  workspaceId: string;
  userId: string;
  kind: NotificationKindName;
  pageId: string | null;
  title: string;
  blockId?: string | null;
  threadId?: string | null;
  actorId?: string | null;
  text: string;
  /** The doc that has to stay readable for it to be shown. */
  docId: string | null;
  /** Makes it happen once (per person and workspace). */
  key?: string | null;
}

export interface StoredNotification {
  id: string;
  kind: NotificationKindName;
  pageId: string | null;
  title: string;
  blockId: string | null;
  threadId: string | null;
  actorId: string | null;
  text: string;
  docId: string | null;
  key: string | null;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
}

export type NotificationFilter = 'all' | 'mentions' | 'unread' | 'archived';

export interface StoredReminder {
  workspaceId: string;
  docId: string;
  key: string;
  userId: string;
  pageId: string;
  blockId: string;
  fireAt: number;
  text: string;
}

interface Row {
  id: string;
  kind: NotificationKindName;
  page_id: string | null;
  title: string;
  block_id: string | null;
  thread_id: string | null;
  actor_id: string | null;
  text: string;
  doc_id: string | null;
  key: string | null;
  created_at: Date;
  read_at: Date | null;
  archived_at: Date | null;
}

const fromRow = (r: Row): StoredNotification => ({
  id: r.id,
  kind: r.kind,
  pageId: r.page_id,
  title: r.title,
  blockId: r.block_id,
  threadId: r.thread_id,
  actorId: r.actor_id,
  text: r.text,
  docId: r.doc_id,
  key: r.key,
  createdAt: r.created_at.getTime(),
  readAt: r.read_at?.getTime() ?? null,
  archivedAt: r.archived_at?.getTime() ?? null,
});

const FILTERS: Record<NotificationFilter, string> = {
  all: 'archived_at IS NULL',
  mentions: "archived_at IS NULL AND kind = 'mention'",
  unread: 'archived_at IS NULL AND read_at IS NULL',
  archived: 'archived_at IS NOT NULL',
};

/** Notifications, page follows, reminders and log followers' positions (migration 8). */
export class Notifications {
  constructor(private readonly pool: pg.Pool) {}

  // --- Notifications ----------------------------------------------------------------

  /** Store a notification; null if one with its key exists already. */
  async add(n: NewNotification): Promise<StoredNotification | null> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO notifications
         (workspace_id, user_id, kind, page_id, title, block_id, thread_id, actor_id, text, doc_id, key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (user_id, workspace_id, key) WHERE key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        n.workspaceId,
        n.userId,
        n.kind,
        n.pageId,
        n.title.slice(0, 500),
        n.blockId ?? null,
        n.threadId ?? null,
        n.actorId ?? null,
        n.text.slice(0, 2000),
        n.docId,
        n.key ?? null,
      ],
    );
    return rows[0] ? fromRow(rows[0]) : null;
  }

  /** Newest first, older than `before` (ms) when given. */
  async list(
    workspaceId: string,
    userId: string,
    options: { filter?: NotificationFilter; limit?: number; before?: number | null } = {},
  ): Promise<StoredNotification[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM notifications
       WHERE workspace_id = $1 AND user_id = $2 AND ${FILTERS[options.filter ?? 'all']}
         AND ($3::timestamptz IS NULL OR created_at < $3)
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [workspaceId, userId, options.before ? new Date(options.before) : null, options.limit ?? 50],
    );
    return rows.map(fromRow);
  }

  /** Unread, not archived (with the doc each needs readable, for the caller to check). */
  async unread(workspaceId: string, userId: string): Promise<{ docId: string | null }[]> {
    const { rows } = await this.pool.query<{ doc_id: string | null }>(
      `SELECT doc_id FROM notifications
       WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL AND archived_at IS NULL`,
      [workspaceId, userId],
    );
    return rows.map((r) => ({ docId: r.doc_id }));
  }

  /** Mark some (or, with `ids` null, all) read or unread. */
  async setRead(
    workspaceId: string,
    userId: string,
    ids: readonly string[] | null,
    read: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE notifications SET read_at = CASE WHEN $4 THEN coalesce(read_at, now()) ELSE NULL END
       WHERE workspace_id = $1 AND user_id = $2 AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [workspaceId, userId, ids, read],
    );
  }

  async setArchived(
    workspaceId: string,
    userId: string,
    ids: readonly string[],
    archived: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE notifications
       SET archived_at = CASE WHEN $4 THEN coalesce(archived_at, now()) ELSE NULL END,
           read_at = CASE WHEN $4 THEN coalesce(read_at, now()) ELSE read_at END
       WHERE workspace_id = $1 AND user_id = $2 AND id = ANY($3::uuid[])`,
      [workspaceId, userId, ids, archived],
    );
  }

  // --- Page follows -----------------------------------------------------------------

  /**
   * Follow (or unfollow) a page. `auto`: only if the person never chose (they created,
   * edited or commented on it).
   */
  async setFollowing(
    workspaceId: string,
    pageId: string,
    userId: string,
    following: boolean,
    auto = false,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO page_follows (workspace_id, page_id, user_id, following) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, page_id, user_id) DO ${auto ? 'NOTHING' : 'UPDATE SET following = excluded.following'}`,
      [workspaceId, pageId, userId, following],
    );
  }

  async isFollowing(workspaceId: string, pageId: string, userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ following: boolean }>(
      'SELECT following FROM page_follows WHERE workspace_id = $1 AND page_id = $2 AND user_id = $3',
      [workspaceId, pageId, userId],
    );
    return rows[0]?.following ?? false;
  }

  async followers(workspaceId: string, pageId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ user_id: string }>(
      'SELECT user_id FROM page_follows WHERE workspace_id = $1 AND page_id = $2 AND following',
      [workspaceId, pageId],
    );
    return rows.map((r) => r.user_id);
  }

  // --- Reminders --------------------------------------------------------------------

  async remindersOf(workspaceId: string, docId: string): Promise<StoredReminder[]> {
    const { rows } = await this.pool.query<{
      key: string;
      user_id: string;
      page_id: string;
      block_id: string;
      fire_at: Date;
      text: string;
    }>(
      'SELECT key, user_id, page_id, block_id, fire_at, text FROM reminders WHERE workspace_id = $1 AND doc_id = $2',
      [workspaceId, docId],
    );
    return rows.map((r) => ({
      workspaceId,
      docId,
      key: r.key,
      userId: r.user_id,
      pageId: r.page_id,
      blockId: r.block_id,
      fireAt: r.fire_at.getTime(),
      text: r.text,
    }));
  }

  /**
   * Make a doc's reminders these. One whose time changed fires again; one that already
   * fired at the same time doesn't.
   */
  async replaceReminders(
    workspaceId: string,
    docId: string,
    reminders: readonly Omit<StoredReminder, 'workspaceId' | 'docId'>[],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM reminders WHERE workspace_id = $1 AND doc_id = $2 AND NOT (key = ANY($3::text[]))',
        [workspaceId, docId, reminders.map((r) => r.key)],
      );
      for (const r of reminders) {
        await client.query(
          `INSERT INTO reminders (workspace_id, doc_id, key, user_id, page_id, block_id, fire_at, text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (workspace_id, doc_id, key) DO UPDATE SET
             user_id = excluded.user_id, page_id = excluded.page_id, block_id = excluded.block_id,
             text = excluded.text, fire_at = excluded.fire_at,
             fired_at = CASE WHEN reminders.fire_at = excluded.fire_at THEN reminders.fired_at END`,
          [
            workspaceId,
            docId,
            r.key,
            r.userId,
            r.pageId,
            r.blockId,
            new Date(r.fireAt),
            r.text.slice(0, 500),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Reminders due by `now` that haven't fired (every workspace). */
  async dueReminders(now: number, limit = 200): Promise<StoredReminder[]> {
    const { rows } = await this.pool.query<{
      workspace_id: string;
      doc_id: string;
      key: string;
      user_id: string;
      page_id: string;
      block_id: string;
      fire_at: Date;
      text: string;
    }>(
      `SELECT workspace_id, doc_id, key, user_id, page_id, block_id, fire_at, text FROM reminders
       WHERE fired_at IS NULL AND fire_at <= $1 ORDER BY fire_at LIMIT $2`,
      [new Date(now), limit],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id,
      docId: r.doc_id,
      key: r.key,
      userId: r.user_id,
      pageId: r.page_id,
      blockId: r.block_id,
      fireAt: r.fire_at.getTime(),
      text: r.text,
    }));
  }

  /** The reminder fired (if it's still the one at `fireAt`). */
  async reminderFired(r: Pick<StoredReminder, 'workspaceId' | 'docId' | 'key' | 'fireAt'>) {
    await this.pool.query(
      `UPDATE reminders SET fired_at = now()
       WHERE workspace_id = $1 AND doc_id = $2 AND key = $3 AND fire_at = $4`,
      [r.workspaceId, r.docId, r.key, new Date(r.fireAt)],
    );
  }

  /** When the next unfired reminder is due (ms), or null. */
  async nextReminderAt(): Promise<number | null> {
    const { rows } = await this.pool.query<{ next: Date | null }>(
      'SELECT min(fire_at) AS next FROM reminders WHERE fired_at IS NULL',
    );
    return rows[0]?.next?.getTime() ?? null;
  }

  // --- Log followers ------------------------------------------------------------------

  async followerSeq(workspaceId: string, name: string): Promise<number> {
    const { rows } = await this.pool.query<{ seq: number }>(
      'SELECT seq FROM log_followers WHERE workspace_id = $1 AND name = $2',
      [workspaceId, name],
    );
    return rows[0]?.seq ?? 0;
  }

  /** Move a follower on (in a transaction's `db`, with what it found, if given). */
  async setFollowerSeq(
    workspaceId: string,
    name: string,
    seq: number,
    db: Pick<pg.Pool, 'query'> | pg.PoolClient = this.pool,
  ): Promise<void> {
    await db.query(
      `INSERT INTO log_followers (workspace_id, name, seq) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, name) DO UPDATE SET seq = greatest(log_followers.seq, excluded.seq)`,
      [workspaceId, name, seq],
    );
  }

  /** Workspaces whose log a follower hasn't read to the end. */
  async followersBehind(name: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT w.id FROM workspaces w
       LEFT JOIN log_followers f ON f.workspace_id = w.id AND f.name = $1
       WHERE w.last_seq > coalesce(f.seq, 0)`,
      [name],
    );
    return rows.map((r) => r.id);
  }
}
