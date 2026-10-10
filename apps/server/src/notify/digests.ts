/**
 * Email digests (Phase 6 M7): when SMTP is set up, people get an email about inbox items
 * they haven't seen, as a queue job (`email.digest`), never one email per comment.
 *
 * - **When** (each person's setting): mentions, 10 minutes after one arrives unread; a
 *   daily digest at 9:00 in their time zone; or never. One job per person is open at a
 *   time (by key), so a burst of notifications is one email.
 * - **What:** every unread item not emailed before, in every workspace, with only the
 *   titles of pages they can still read (checked when the email is sent).
 * - **Unsubscribe:** a one-click link (`List-Unsubscribe`, RFC 8058) with a token per
 *   person, served outside `/api` (mail clients POST it without our client header).
 */
import { reminderTime } from '@workspace/core';
import type {
  EmailDigest,
  Job,
  NewNotification,
  StoredNotification,
} from '@workspace/storage-remote';
import type { ServerContext } from '../context';

export interface DigestOptions {
  /** How long a mention waits unread before it's emailed. */
  mentionDelayMs?: number;
  now?: () => number;
}

interface DigestPayload {
  userId: string;
}

type Ctx = Pick<ServerContext, 'store' | 'access' | 'jobs' | 'mailer' | 'config'>;

const MINUTE = 60_000;
const MAX_TEXT = 200;

/** The next 9:00 in `timeZone` after `now`. */
export function nextMorning(now: number, timeZone: string): number {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  for (let day = 0; day < 3; day++) {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    const iso = new Date(Date.UTC(y, m - 1, d + day)).toISOString().slice(0, 10);
    const at = reminderTime(iso, timeZone);
    if (at !== null && at > now) return at;
  }
  return now + 24 * 60 * MINUTE;
}

/** The address of a person's one-click unsubscribe. */
export const unsubscribeUrl = (publicUrl: string, userId: string, token: string) =>
  `${publicUrl}/email/unsubscribe?u=${userId}&t=${token}`;

export class EmailDigests {
  private readonly mentionDelayMs: number;
  private readonly now: () => number;

  constructor(
    private readonly ctx: Ctx,
    options: DigestOptions = {},
  ) {
    this.mentionDelayMs = options.mentionDelayMs ?? 10 * MINUTE;
    this.now = options.now ?? Date.now;
    ctx.jobs.register('email.digest', (job) => this.send(job));
  }

  /** A notification was stored: line up the person's email, if they want one. */
  async noticed(n: NewNotification): Promise<void> {
    if (!this.ctx.mailer) return;
    const prefs = await this.ctx.store.accounts.emailPrefs(n.userId);
    if (!prefs || prefs.digest === 'never') return;
    let runAt: number;
    if (prefs.digest === 'mentions') {
      if (n.kind !== 'mention') return;
      runAt = this.now() + this.mentionDelayMs;
    } else {
      const zone = (await this.ctx.store.accounts.timeZones([n.userId])).get(n.userId) ?? 'UTC';
      runAt = nextMorning(this.now(), zone);
    }
    const payload: DigestPayload = { userId: n.userId };
    await this.ctx.store.jobs.enqueue([
      {
        workspaceId: null,
        kind: 'email.digest',
        payload,
        runAt,
        maxAttempts: 3,
        key: `digest:${n.userId}`,
      },
    ]);
    void this.ctx.jobs.poke();
  }

  private async send(job: Job): Promise<unknown> {
    const { userId } = job.payload as DigestPayload;
    const { store, mailer } = this.ctx;
    if (!mailer) return { skipped: 'no mail server' };
    const prefs = await store.accounts.emailPrefs(userId);
    if (!prefs || prefs.digest === 'never') return { skipped: 'off' };
    const unread = await store.notifications.toEmail(userId);
    // Mentions only: sent when one is still unread (then with everything else unread too).
    if (prefs.digest === 'mentions' && !unread.some((n) => n.kind === 'mention')) {
      return { skipped: 'read' };
    }
    const items: typeof unread = [];
    for (const n of unread) {
      const access = await this.ctx.access.workspace(n.workspaceId);
      if (!access.isMember(userId)) continue;
      if (n.docId && !access.canRead(access.roles(userId), n.docId)) continue;
      items.push(n);
    }
    if (items.length === 0) return { skipped: 'nothing' };
    const mail = await this.compose(prefs, userId, items, prefs.digest);
    await mailer.send({ to: prefs.email, ...mail });
    await store.notifications.markEmailed(items.map((n) => n.id));
    return { sent: items.length };
  }

  private async compose(
    prefs: { token: string; name: string },
    userId: string,
    items: (StoredNotification & { workspaceId: string })[],
    digest: EmailDigest,
  ) {
    const { store, config } = this.ctx;
    const names = await store.accounts.names([
      ...new Set(items.map((n) => n.actorId).filter((id): id is string => !!id)),
    ]);
    const { rows } = await store.pool.query<{ id: string; name: string }>(
      'SELECT id, name FROM workspaces WHERE id = ANY($1::uuid[])',
      [[...new Set(items.map((n) => n.workspaceId))]],
    );
    const workspaces = new Map(rows.map((r) => [r.id, r.name]));
    // Titles as they are now (a notification made before its page was indexed has none).
    const titles = await store.pool.query<{ workspace_id: string; id: string; title: string }>(
      `SELECT workspace_id, id, title FROM search_index
       WHERE (workspace_id, id) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))`,
      [items.map((n) => n.workspaceId), items.map((n) => n.pageId ?? '')],
    );
    const titleOf = new Map(titles.rows.map((r) => [`${r.workspace_id}:${r.id}`, r.title]));
    for (const n of items) {
      const now = n.pageId ? titleOf.get(`${n.workspaceId}:${n.pageId}`) : undefined;
      if (now && n.kind !== 'automation' && n.kind !== 'access') n.title = now;
    }
    const lines: string[] = [];
    for (const [workspaceId, name] of workspaces) {
      const here = items.filter((n) => n.workspaceId === workspaceId);
      if (workspaces.size > 1) lines.push(`${name}`, '');
      for (const n of here) {
        lines.push(`• ${describe(n, names.get(n.actorId ?? '') ?? 'Someone')}`);
        const text = quoted(n);
        if (text) lines.push(`  “${text}”`);
        if (n.pageId) lines.push(`  ${config.publicUrl}/w/${workspaceId}#page=${n.pageId}`);
        lines.push('');
      }
    }
    const unsubscribe = unsubscribeUrl(config.publicUrl, userId, prefs.token);
    const why =
      digest === 'daily'
        ? 'You get a daily email about what you haven’t seen.'
        : 'You get an email when you’re mentioned and haven’t seen it for 10 minutes.';
    lines.push('—', `${why} Change it in Your profile, or stop these emails: ${unsubscribe}`);
    const only = items.length === 1 ? items[0]! : null;
    const workspaceName = workspaces.size === 1 ? [...workspaces.values()][0]! : 'your workspaces';
    const subject = only
      ? describe(only, names.get(only.actorId ?? '') ?? 'Someone')
      : `${items.length} updates in ${workspaceName}`;
    return {
      subject: subject.slice(0, 200),
      text: `Hi ${prefs.name},\n\n${lines.join('\n')}\n`,
      headers: {
        'List-Unsubscribe': `<${unsubscribe}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }
}

/** One line about a notification. */
function describe(n: StoredNotification, actor: string): string {
  const title = n.title ? `“${n.title}”` : 'a page';
  switch (n.kind) {
    case 'mention':
      return `${actor} mentioned you in ${title}`;
    case 'comment':
      return `${actor} commented on ${title}`;
    case 'reply':
      return `${actor} replied in ${title}`;
    case 'reminder':
      return `Reminder: ${title}`;
    case 'access':
      return `${actor}: ${n.text}`;
    case 'form':
      return `New response to ${title}`;
    case 'automation':
      return `${n.title}: ${n.text}`;
  }
}

/** The text shown under a line (what was said), if any. */
function quoted(n: StoredNotification): string | null {
  if (n.kind === 'access' || n.kind === 'automation' || !n.text) return null;
  return n.text.length > MAX_TEXT ? `${n.text.slice(0, MAX_TEXT - 1)}…` : n.text;
}
