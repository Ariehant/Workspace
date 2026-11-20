/**
 * Pages as Markdown (Phase 8 #43), a Workspace addition to Notion's API:
 *
 * - `GET /v1/pages/:id/markdown`: the page's content as Markdown (the exporter's), with links
 *   to pages and files as URLs (files signed for an hour, as file objects are).
 * - `PATCH /v1/pages/:id/markdown`, `{ markdown, mode? }`: Markdown (the editor's reader:
 *   headings, lists, to-dos, quotes, code, tables, links, bold…) appended to the page
 *   (`mode: "append"`, the default), or in place of its content (`"replace"`). Answers with
 *   the page's Markdown after the change.
 *
 * Works for pages and database rows; a database has no content (its pages are queried).
 */
import { ApiError, parseId } from '@workspace/api-model';
import { MEMBERS_DOC_ID, WORKSPACE_DOC_ID, listPages, userNames } from '@workspace/core';
import { parseMarkdown } from '@workspace/editor';
import { blocksMarkdown, readContent, walk, type ContentNode } from '@workspace/exporters';
import type { FastifyInstance } from 'fastify';
import { appendBlocks, contentDocOf, replaceContent } from './content';
import { viewOf } from './plugin';
import type { ApiView, Located } from './view';

/** Markdown accepted in one request (the API's body limit is 500 KB). */
const MAX_MARKDOWN = 200_000;

const invalid = (message: string) => new ApiError('validation_error', message);

async function pageMarkdown(api: ApiView, page: Located): Promise<string> {
  const doc = await api.doc(contentDocOf(page));
  if (!doc) return '';
  const nodes = readContent(doc);
  // Synced blocks show their content (one level: a synced block in one is left out).
  const synced = new Map<string, ContentNode[]>();
  for (const node of walk(nodes)) {
    const id = node.type === 'syncedBlock' ? String(node.attrs?.syncedId ?? '') : '';
    if (!id || synced.has(id)) continue;
    const source = await api.doc(id);
    synced.set(id, source ? readContent(source) : []);
  }
  const titles = new Map<string, string>();
  for (const scope of api.readableScopes()) {
    const tree = await api.doc(scope.treeDoc);
    if (tree) for (const p of listPages(tree)) titles.set(p.id, p.title);
  }
  const names = userNames(await api.doc(WORKSPACE_DOC_ID), await api.doc(MEMBERS_DOC_ID));
  const links = api.links;
  return blocksMarkdown(nodes, {
    // Pages the integration can't read show as text.
    pageHref: (id) => (titles.has(id) ? links.pageUrl(id) : ''),
    pageTitle: (id) => titles.get(id) || 'Untitled',
    userName: (id) => names.get(id) ?? 'Someone',
    fileHref: (id, name) => links.fileUrl(id, name ?? '').url,
    synced: (id) => synced.get(id) ?? [],
  });
}

async function located(api: ApiView, raw: string): Promise<Located> {
  const id = parseId(raw);
  if (!id) throw invalid('path.page_id should be a valid uuid.');
  const page = await api.find(id);
  if (!page) {
    throw new ApiError(
      'object_not_found',
      `Could not find page with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
    );
  }
  if (page.kind === 'database') {
    throw invalid(`${id} is a database: its pages have content, it doesn't.`);
  }
  return page;
}

const json = (page: Located, markdown: string) => ({
  object: 'page_markdown',
  id: page.id,
  markdown,
});

export function markdownRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/pages/:id/markdown', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    const page = await located(api, request.params.id);
    return json(page, await pageMarkdown(api, page));
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/pages/:id/markdown', async (request) => {
    const api = viewOf(request);
    const body = request.body as { markdown?: unknown; mode?: unknown } | null;
    if (!body || typeof body !== 'object') throw invalid('body should be an object.');
    if (typeof body.markdown !== 'string') throw invalid('body.markdown should be a string.');
    if (body.markdown.length > MAX_MARKDOWN) {
      throw invalid(`body.markdown should be at most ${MAX_MARKDOWN} characters.`);
    }
    const mode = body.mode ?? 'append';
    if (mode !== 'append' && mode !== 'replace') {
      throw invalid('body.mode should be "append" or "replace".');
    }
    api.need('insertContent');
    if (mode === 'replace') api.need('updateContent');
    const page = await located(api, request.params.id);
    const nodes = parseMarkdown(body.markdown) as Parameters<typeof appendBlocks>[4];
    if (mode === 'replace') await replaceContent(api, page, nodes);
    else await appendBlocks(api, page, null, null, nodes);
    api.forget(contentDocOf(page));
    return json(page, await pageMarkdown(api, page));
  });
}
