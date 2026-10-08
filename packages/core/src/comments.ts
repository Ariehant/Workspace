/**
 * Comments and suggested edits (Phase 5 M5). Each page has a comments doc,
 * `comments:<pageId>`, separate from the page so that someone who may only comment never
 * writes the page itself.
 *
 *   threads: Y.Map<threadId, Y.Map>
 *     id, anchor (JSON), createdBy, createdAt, resolvedBy, resolvedAt
 *     comments: Y.Array<Y.Map>   id, author, body, createdAt, editedAt,
 *                                reactions: Y.Map<emoji, Y.Map<userId, true>>
 *     suggestion?: Y.Map         insert, status (open | accepted | rejected), decidedBy, decidedAt
 *
 * A text anchor holds Yjs relative positions into the page content (base64), so it
 * follows the text through anyone's edits. A suggestion is a thread on the range it would
 * replace, with the text to put there.
 */
import * as Y from 'yjs';
import { newId } from './ids';

export const COMMENTS_PREFIX = 'comments:';
export const commentsDocId = (pageId: string) => `${COMMENTS_PREFIX}${pageId}`;
export const isCommentsDocId = (docId: string) => docId.startsWith(COMMENTS_PREFIX);

export type CommentAnchor =
  | { kind: 'page' }
  | { kind: 'block'; blockId: string }
  /** `start`/`end`: encoded Yjs relative positions (base64); `quote`: the text then. */
  | { kind: 'range'; start: string; end: string; quote: string }
  /** A database property on a row page. */
  | { kind: 'property'; propertyId: string };

export interface CommentData {
  id: string;
  author: string;
  /** Plain text; `<@userId>` is a mention. */
  body: string;
  createdAt: number;
  editedAt: number | null;
  /** emoji -> who reacted */
  reactions: Record<string, string[]>;
}

export type SuggestionStatus = 'open' | 'accepted' | 'rejected';

export interface SuggestionData {
  /** The text that would replace the anchored range (which may be empty: an insertion). */
  insert: string;
  status: SuggestionStatus;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface ThreadData {
  id: string;
  anchor: CommentAnchor;
  createdBy: string;
  createdAt: number;
  resolvedBy: string | null;
  resolvedAt: number | null;
  comments: CommentData[];
  suggestion: SuggestionData | null;
}

/** Reactions offered under a comment. */
export const REACTIONS = ['👍', '❤️', '🎉', '😄', '👀'] as const;

const threadsOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('threads');

function readComment(map: Y.Map<unknown>): CommentData {
  const reactions: Record<string, string[]> = {};
  const r = map.get('reactions');
  if (r instanceof Y.Map) {
    for (const [emoji, who] of r) {
      if (who instanceof Y.Map && who.size > 0) reactions[emoji] = [...who.keys()].sort();
    }
  }
  return {
    id: map.get('id') as string,
    author: map.get('author') as string,
    body: (map.get('body') as string | undefined) ?? '',
    createdAt: map.get('createdAt') as number,
    editedAt: (map.get('editedAt') as number | null | undefined) ?? null,
    reactions,
  };
}

function readThread(map: Y.Map<unknown>): ThreadData {
  const comments = map.get('comments');
  const s = map.get('suggestion');
  return {
    id: map.get('id') as string,
    anchor: (map.get('anchor') as CommentAnchor | undefined) ?? { kind: 'page' },
    createdBy: map.get('createdBy') as string,
    createdAt: map.get('createdAt') as number,
    resolvedBy: (map.get('resolvedBy') as string | null | undefined) ?? null,
    resolvedAt: (map.get('resolvedAt') as number | null | undefined) ?? null,
    comments:
      comments instanceof Y.Array ? (comments.toArray() as Y.Map<unknown>[]).map(readComment) : [],
    suggestion:
      s instanceof Y.Map
        ? {
            insert: (s.get('insert') as string | undefined) ?? '',
            status: (s.get('status') as SuggestionStatus | undefined) ?? 'open',
            decidedBy: (s.get('decidedBy') as string | null | undefined) ?? null,
            decidedAt: (s.get('decidedAt') as number | null | undefined) ?? null,
          }
        : null,
  };
}

/** Every thread, oldest first. */
export function readThreads(doc: Y.Doc): ThreadData[] {
  // The key is the id (not a field inside, which anyone writing the doc could set).
  return [...threadsOf(doc)]
    .map(([id, map]) => ({ ...readThread(map), id }))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

export function getThread(doc: Y.Doc, threadId: string): ThreadData | null {
  const map = threadsOf(doc).get(threadId);
  return map ? { ...readThread(map), id: threadId } : null;
}

/** Open threads that are discussions (not decided suggestions): the count on the page. */
export const openThreadCount = (doc: Y.Doc) =>
  readThreads(doc).filter(
    (t) => t.resolvedAt === null && (!t.suggestion || t.suggestion.status === 'open'),
  ).length;

function newComment(author: string, body: string, now: number): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set('id', newId());
  map.set('author', author);
  map.set('body', body);
  map.set('createdAt', now);
  map.set('editedAt', null);
  map.set('reactions', new Y.Map());
  return map;
}

/** Start a thread (a discussion, or with `suggestion`, a suggested edit). */
export function createThread(
  doc: Y.Doc,
  input: {
    anchor: CommentAnchor;
    author: string;
    /** The first comment (a suggestion may have none). */
    body?: string;
    suggestion?: { insert: string };
    now?: number;
  },
): string {
  const id = newId();
  const now = input.now ?? Date.now();
  doc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set('id', id);
    map.set('anchor', input.anchor);
    map.set('createdBy', input.author);
    map.set('createdAt', now);
    map.set('resolvedBy', null);
    map.set('resolvedAt', null);
    const comments = new Y.Array<Y.Map<unknown>>();
    if (input.body?.trim()) comments.push([newComment(input.author, input.body.trim(), now)]);
    map.set('comments', comments);
    if (input.suggestion) {
      const s = new Y.Map<unknown>();
      s.set('insert', input.suggestion.insert);
      s.set('status', 'open');
      s.set('decidedBy', null);
      s.set('decidedAt', null);
      map.set('suggestion', s);
    }
    threadsOf(doc).set(id, map);
  });
  return id;
}

const threadMap = (doc: Y.Doc, threadId: string) => {
  const map = threadsOf(doc).get(threadId);
  if (!map) throw new Error(`No such thread: ${threadId}`);
  return map;
};
const commentsArray = (doc: Y.Doc, threadId: string) =>
  threadMap(doc, threadId).get('comments') as Y.Array<Y.Map<unknown>>;
const commentIndex = (doc: Y.Doc, threadId: string, commentId: string) => {
  const list = commentsArray(doc, threadId);
  const i = list.toArray().findIndex((c) => c.get('id') === commentId);
  if (i < 0) throw new Error(`No such comment: ${commentId}`);
  return { list, i, map: list.get(i) };
};

export function addComment(
  doc: Y.Doc,
  threadId: string,
  author: string,
  body: string,
  now = Date.now(),
): string {
  const comment = newComment(author, body.trim(), now);
  commentsArray(doc, threadId).push([comment]);
  return comment.get('id') as string;
}

export function editComment(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  body: string,
  now = Date.now(),
): void {
  const { map } = commentIndex(doc, threadId, commentId);
  doc.transact(() => {
    map.set('body', body.trim());
    map.set('editedAt', now);
  });
}

/** Delete a comment; a thread left with no comments (and no suggestion) goes too. */
export function deleteComment(doc: Y.Doc, threadId: string, commentId: string): void {
  doc.transact(() => {
    const { list, i } = commentIndex(doc, threadId, commentId);
    list.delete(i, 1);
    const thread = threadMap(doc, threadId);
    if (list.length === 0 && !thread.get('suggestion')) threadsOf(doc).delete(threadId);
  });
}

export function deleteThread(doc: Y.Doc, threadId: string): void {
  threadsOf(doc).delete(threadId);
}

export function setResolved(
  doc: Y.Doc,
  threadId: string,
  by: string | null,
  now = Date.now(),
): void {
  const map = threadMap(doc, threadId);
  doc.transact(() => {
    map.set('resolvedBy', by);
    map.set('resolvedAt', by ? now : null);
  });
}

export function toggleReaction(
  doc: Y.Doc,
  threadId: string,
  commentId: string,
  emoji: string,
  userId: string,
): void {
  const { map } = commentIndex(doc, threadId, commentId);
  doc.transact(() => {
    let reactions = map.get('reactions') as Y.Map<Y.Map<boolean>> | undefined;
    if (!reactions) map.set('reactions', (reactions = new Y.Map()));
    let who = reactions.get(emoji);
    if (!who) reactions.set(emoji, (who = new Y.Map()));
    if (who.has(userId)) who.delete(userId);
    else who.set(userId, true);
  });
}

// --- Suggested edits --------------------------------------------------------------------

/** Change an open suggestion's text and range (its author typing on). */
export function updateSuggestion(
  doc: Y.Doc,
  threadId: string,
  change: { insert?: string; anchor?: CommentAnchor },
): void {
  const map = threadMap(doc, threadId);
  doc.transact(() => {
    if (change.anchor) map.set('anchor', change.anchor);
    if (change.insert !== undefined) {
      (map.get('suggestion') as Y.Map<unknown>).set('insert', change.insert);
    }
  });
}

/** Accept (the caller applies it to the page) or reject a suggestion. */
export function decideSuggestion(
  doc: Y.Doc,
  threadId: string,
  status: Exclude<SuggestionStatus, 'open'>,
  by: string,
  now = Date.now(),
): void {
  const s = threadMap(doc, threadId).get('suggestion') as Y.Map<unknown> | undefined;
  if (!s) throw new Error('Not a suggestion');
  doc.transact(() => {
    s.set('status', status);
    s.set('decidedBy', by);
    s.set('decidedAt', now);
  });
}

// --- Anchors ---------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export const encodeAnchorPosition = (pos: Y.RelativePosition) =>
  toBase64(Y.encodeRelativePosition(pos));
export const decodeAnchorPosition = (text: string): Y.RelativePosition | null => {
  try {
    return Y.decodeRelativePosition(fromBase64(text));
  } catch {
    return null;
  }
};

/** Mentions in a comment body (`<@userId>`). */
export const mentionsIn = (body: string): string[] => [
  ...new Set([...body.matchAll(/<@([\w-]{1,64})>/g)].map((m) => m[1]!)),
];

// --- Checking an update (the server) ------------------------------------------------------

export interface CommentsWriter {
  userId: string;
  /** May edit the page (accept suggestions). */
  canEdit: boolean;
  /** Has full access (may delete anyone's comment). */
  canManage: boolean;
}

/**
 * May `writer` make this change to a comments doc? Everything a person writes must be
 * theirs: new threads and comments carry them as author, only authors edit their own
 * comments (or a suggestion's text), only they (or someone with full access) delete
 * them, reactions and resolutions are recorded under their own id, and only someone who
 * may edit the page accepts a suggestion. Returns a reason when it may not.
 */
export function checkCommentsChange(
  before: Y.Doc,
  update: Uint8Array,
  writer: CommentsWriter,
): string | null {
  const after = new Y.Doc();
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  try {
    Y.applyUpdate(after, update);
  } catch {
    return 'malformed update';
  }
  // Changes that wait for others this doc doesn't have can't be checked (and would land
  // unchecked later): refused.
  if (after.store.pendingStructs || after.store.pendingDs) return 'depends on unknown changes';
  for (const name of after.share.keys()) {
    if (name !== 'threads') return `unknown part "${name}"`;
  }
  const { userId, canEdit, canManage } = writer;
  const old = new Map(readThreads(before).map((t) => [t.id, t]));
  const now = new Map(readThreads(after).map((t) => [t.id, t]));
  for (const [id, t] of old) {
    if (!now.has(id) && t.createdBy !== userId && !canManage) return 'deleted a thread';
  }
  for (const [id, t] of now) {
    const was = old.get(id);
    if (!was) {
      if (t.createdBy !== userId) return 'thread by someone else';
      if (t.comments.some((c) => c.author !== userId)) return 'comment by someone else';
      if (t.suggestion && t.suggestion.status !== 'open') return 'suggestion already decided';
      continue;
    }
    if (t.createdBy !== was.createdBy || t.createdAt !== was.createdAt) return 'changed author';
    if (JSON.stringify(t.anchor) !== JSON.stringify(was.anchor) && t.createdBy !== userId) {
      return "moved someone else's thread";
    }
    if (t.resolvedBy !== was.resolvedBy && t.resolvedBy !== null && t.resolvedBy !== userId) {
      return 'resolved as someone else';
    }
    // Suggestions.
    if (t.suggestion || was.suggestion) {
      if (!t.suggestion || !was.suggestion) return 'added or removed a suggestion';
      if (t.suggestion.insert !== was.suggestion.insert && t.createdBy !== userId) {
        return "changed someone else's suggestion";
      }
      if (t.suggestion.status !== was.suggestion.status) {
        if (t.suggestion.decidedBy !== userId) return 'decided as someone else';
        if (t.suggestion.status === 'accepted' && !canEdit) return 'may not accept';
        if (t.suggestion.status === 'rejected' && !canEdit && t.createdBy !== userId) {
          return 'may not reject';
        }
      }
    }
    // Comments.
    const oldComments = new Map(was.comments.map((c) => [c.id, c]));
    const newIds = new Set(t.comments.map((c) => c.id));
    for (const [cid, c] of oldComments) {
      if (!newIds.has(cid) && c.author !== userId && !canManage) return 'deleted a comment';
    }
    for (const c of t.comments) {
      const prev = oldComments.get(c.id);
      if (!prev) {
        if (c.author !== userId) return 'comment by someone else';
        continue;
      }
      if (c.author !== prev.author || c.createdAt !== prev.createdAt) return 'changed author';
      if ((c.body !== prev.body || c.editedAt !== prev.editedAt) && c.author !== userId) {
        return "edited someone else's comment";
      }
      // Reactions: only one's own.
      const emojis = new Set([...Object.keys(c.reactions), ...Object.keys(prev.reactions)]);
      for (const emoji of emojis) {
        const a = new Set(prev.reactions[emoji] ?? []);
        const b = new Set(c.reactions[emoji] ?? []);
        for (const who of new Set([...a, ...b])) {
          if (a.has(who) !== b.has(who) && who !== userId) return "changed someone else's reaction";
        }
      }
    }
  }
  return null;
}
