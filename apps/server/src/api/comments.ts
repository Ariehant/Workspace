/**
 * Comments (Phase 6 M6): `GET /v1/comments?block_id=` lists a page's or a block's open
 * discussions, and `POST /v1/comments` starts one on a page or replies in one. They're
 * the threads of the page's comments doc, as the app's: a discussion is a thread.
 */
import {
  commentBodyIn,
  commentRichText,
  invalid,
  listObject,
  notFound,
  parseId,
  parsePaging,
  type BlockContext,
} from '@workspace/api-model';
import {
  addComment,
  commentsDocId,
  createThread,
  getThread,
  listPages,
  readThreads,
  type CommentData,
  type ThreadData,
} from '@workspace/core';
import type { FastifyInstance } from 'fastify';
import { blockContext, locateBlock, scopeOf } from './content';
import { viewOf } from './plugin';
import type { ApiView, Located } from './view';

const iso = (ms: number) => new Date(ms).toISOString();

/** Where a thread is, in Notion's terms (a block's, or else the page's). */
const parentOf = (page: Located, thread: ThreadData) =>
  thread.anchor.kind === 'block'
    ? { type: 'block_id', block_id: thread.anchor.blockId }
    : { type: 'page_id', page_id: page.id };

function commentJson(page: Located, thread: ThreadData, c: CommentData, ctx: BlockContext) {
  return {
    object: 'comment',
    id: c.id,
    parent: parentOf(page, thread),
    discussion_id: thread.id,
    created_time: iso(c.createdAt),
    last_edited_time: iso(c.editedAt ?? c.createdAt),
    created_by: { object: 'user', id: c.author },
    rich_text: commentRichText(c.body, ctx),
  };
}

/** Discussion id → the page it's on (found before; looked for again on a miss). */
const pageOfThread = new Map<string, string>();
const MAX_KNOWN = 50_000;

/** The page a discussion is on (among the pages the bot reads). */
async function locateThread(api: ApiView, threadId: string): Promise<Located> {
  const known = pageOfThread.get(threadId);
  if (known) {
    const page = await api.find(known);
    const doc = page && (await api.doc(commentsDocId(page.id)));
    if (page && doc && getThread(doc, threadId)) return page;
  }
  for (const scope of api.readableScopes()) {
    const tree = await api.doc(scope.treeDoc);
    if (!tree) continue;
    for (const meta of listPages(tree)) {
      const id = meta.id;
      const candidates = [id];
      const page = await api.find(id);
      if (page?.kind === 'database') {
        for (const row of (await api.snapshot(page)).rows) candidates.push(row.id);
      }
      for (const candidate of candidates) {
        const doc = await api.doc(commentsDocId(candidate));
        if (!doc || !getThread(doc, threadId)) continue;
        const found = await api.find(candidate);
        if (!found) continue;
        if (pageOfThread.size >= MAX_KNOWN) pageOfThread.clear();
        pageOfThread.set(threadId, candidate);
        return found;
      }
    }
  }
  throw notFound(threadId);
}

export function commentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: Record<string, unknown> }>('/comments', async (request) => {
    const api = viewOf(request);
    api.need('readComments');
    const raw = request.query.block_id;
    if (raw === undefined) throw invalid('query.block_id should be defined.');
    const id = parseId(raw);
    if (!id) throw invalid('query.block_id should be a valid uuid.');
    let page = await api.find(id);
    let blockId: string | null = null;
    if (!page) {
      page = (await locateBlock(api, id)).page;
      blockId = id;
    }
    if (page.kind === 'database') throw invalid(`${id} is a database: it has no comments.`);
    const doc = await api.doc(commentsDocId(page.id));
    const threads = (doc ? readThreads(doc) : []).filter(
      (t) =>
        t.resolvedAt === null &&
        !t.suggestion &&
        (blockId
          ? t.anchor.kind === 'block' && t.anchor.blockId === blockId
          : t.anchor.kind !== 'block'),
    );
    const comments = threads.flatMap((thread) => thread.comments.map((c) => ({ thread, c })));
    const ctx = await blockContext(api);
    const found = page;
    return listObject(
      comments,
      (x) => x.c.id,
      parsePaging(request.query),
      'comment',
      (x) => commentJson(found, x.thread, x.c, ctx),
    );
  });

  app.post<{ Body: unknown }>('/comments', async (request) => {
    const api = viewOf(request);
    api.need('insertComments');
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw invalid('body should be an object.');
    }
    const { parent, discussion_id, rich_text } = body as Record<string, unknown>;
    const text = commentBodyIn(rich_text, { isUser: (u) => api.access.isMember(u) });
    let page: Located;
    let threadId: string;
    let commentId: string;
    if (discussion_id !== undefined) {
      if (parent !== undefined)
        throw invalid('body should have parent or discussion_id, not both.');
      const id = parseId(discussion_id);
      if (!id) throw invalid('body.discussion_id should be a valid uuid.');
      page = await locateThread(api, id);
      threadId = id;
      commentId = await api.edit(
        commentsDocId(page.id),
        (doc) => addComment(doc, id, api.botId, text),
        scopeOf(page),
      );
    } else {
      const p = parent as { page_id?: unknown; block_id?: unknown } | undefined;
      if (!p || typeof p !== 'object')
        throw invalid('body.parent or body.discussion_id should be defined.');
      if (p.block_id !== undefined) {
        throw invalid('body.parent.page_id should be defined: new discussions go on a page.');
      }
      const id = parseId(p.page_id);
      if (!id) throw invalid('body.parent.page_id should be a valid uuid.');
      page = await api.locate(id);
      if (page.kind === 'database') throw invalid(`${id} is a database: comment on its pages.`);
      const made = await api.edit(
        commentsDocId(page.id),
        (doc) => {
          const thread = createThread(doc, {
            anchor: { kind: 'page' },
            author: api.botId,
            body: text,
          });
          return { thread, comment: getThread(doc, thread)!.comments[0]!.id };
        },
        scopeOf(page),
      );
      threadId = made.thread;
      commentId = made.comment;
    }
    if (pageOfThread.size >= MAX_KNOWN) pageOfThread.clear();
    pageOfThread.set(threadId, page.id);
    const doc = await api.doc(commentsDocId(page.id));
    const thread = getThread(doc!, threadId)!;
    const comment = thread.comments.find((c) => c.id === commentId)!;
    return commentJson(page, thread, comment, await blockContext(api));
  });
}
