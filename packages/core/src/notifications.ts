/**
 * Notifications (Phase 5 M6): what the server tells a person about (someone mentioned
 * them, commented on or replied in a page they follow, a reminder came due, a page was
 * shared with them), and what it reads out of docs to find them.
 */
import type * as Y from 'yjs';
import { readBlocks, type Block } from './blocks';
import { mentionsIn, type ThreadData } from './comments';

/**
 * `form`: a response to a form whose maker asked to be told; `automation`: an
 * automation's "send notification", or a problem with one (Phase 6).
 */
export type NotificationKind =
  'mention' | 'comment' | 'reply' | 'reminder' | 'access' | 'form' | 'automation';
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'mention',
  'comment',
  'reply',
  'reminder',
  'access',
  'form',
  'automation',
];

/** A notification as clients get it (over the socket, and from the list endpoint). */
export interface NotificationData {
  id: string;
  kind: NotificationKind;
  /** The page (or database row) it's about; null for a teamspace shared. */
  pageId: string | null;
  /** The page's title when it happened (the client shows the current one if it has it). */
  title: string;
  /** Where on the page: a block (a mention), or a comment thread. */
  blockId: string | null;
  threadId: string | null;
  /** Who did it (null for reminders). */
  actorId: string | null;
  /** What it says: the block's text, the comment, the reminder. */
  text: string;
  createdAt: number;
  readAt: number | null;
  archivedAt: number | null;
  /**
   * A reminder's identity on a device (`<page>/<block>/<fire time>`), so a desktop that
   * already showed it locally doesn't show it again.
   */
  key: string | null;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A notification from JSON (the socket), or null if it isn't one. */
export function parseNotification(json: string): NotificationData | null {
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const id = str(v.id);
  const kind = str(v.kind) as NotificationKind | null;
  const createdAt = num(v.createdAt);
  if (!id || !kind || !NOTIFICATION_KINDS.includes(kind) || createdAt === null) return null;
  return {
    id,
    kind,
    pageId: str(v.pageId),
    title: str(v.title) ?? '',
    blockId: str(v.blockId),
    threadId: str(v.threadId),
    actorId: str(v.actorId),
    text: str(v.text) ?? '',
    createdAt,
    readAt: num(v.readAt),
    archivedAt: num(v.archivedAt),
    key: str(v.key),
  };
}

/** The key of a reminder on a page (`blockId` as the desktop stores it) at `fireAt`. */
export const reminderKey = (pageId: string, blockId: string, fireAt: number) =>
  `${pageId}/${blockId}/${fireAt}`;

// --- Reading docs ------------------------------------------------------------------------

export interface PersonMention {
  /** The block it's in (with the person: identifies the mention). */
  blockId: string | null;
  userId: string;
  /** The block's text, for the notification. */
  text: string;
}

/** Person mentions (`@Name`) anywhere in a page. */
export function readPersonMentions(doc: Y.Doc): PersonMention[] {
  const out: PersonMention[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      for (const child of block.children) {
        const userId = child.props.userId;
        if (
          child.type === 'mention' &&
          child.props.kind === 'person' &&
          typeof userId === 'string'
        ) {
          out.push({
            blockId: typeof block.props.id === 'string' ? block.props.id : null,
            userId,
            text: block.text.replace(/\s+/g, ' ').trim(),
          });
        }
      }
      walk(block.children);
    }
  };
  walk(readBlocks(doc));
  return out;
}

/** What changed in a page's comments, as the server notifies it. */
export interface CommentEvent {
  /** `thread`: a new discussion; `reply`: a comment in an existing one; `edit`: new mentions. */
  kind: 'thread' | 'reply' | 'edit';
  threadId: string;
  commentId: string;
  author: string;
  body: string;
  /** People mentioned that weren't before. */
  mentions: string[];
  /** Everyone who wrote in the thread before (for replies). */
  participants: string[];
}

/** New comments (and new mentions in edited ones) between two readings of a comments doc. */
export function commentEvents(before: ThreadData[], after: ThreadData[]): CommentEvent[] {
  const was = new Map(before.map((t) => [t.id, t]));
  const events: CommentEvent[] = [];
  for (const thread of after) {
    const old = was.get(thread.id);
    const oldComments = new Map((old?.comments ?? []).map((c) => [c.id, c]));
    const participants = new Set<string>(old ? [old.createdBy] : []);
    for (const c of old?.comments ?? []) participants.add(c.author);
    thread.comments.forEach((comment, i) => {
      const prev = oldComments.get(comment.id);
      if (prev) {
        const had = new Set(mentionsIn(prev.body));
        const added = mentionsIn(comment.body).filter((id) => !had.has(id));
        if (added.length > 0) {
          events.push({
            kind: 'edit',
            threadId: thread.id,
            commentId: comment.id,
            author: comment.author,
            body: comment.body,
            mentions: added,
            participants: [],
          });
        }
        return;
      }
      events.push({
        kind: !old && i === 0 ? 'thread' : 'reply',
        threadId: thread.id,
        commentId: comment.id,
        author: comment.author,
        body: comment.body,
        mentions: mentionsIn(comment.body),
        participants: [...participants],
      });
      participants.add(comment.author);
    });
  }
  return events;
}

/** A comment body as plain text (`<@id>` mentions as `@Name`). */
export function commentText(body: string, names: ReadonlyMap<string, string>): string {
  return body.replace(/<@([\w-]{1,64})>/g, (_, id: string) => `@${names.get(id) ?? 'someone'}`);
}
