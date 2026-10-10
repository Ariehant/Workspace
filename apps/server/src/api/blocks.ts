/**
 * Blocks (Phase 6 M6): `GET|PATCH|DELETE /v1/blocks/:id` and
 * `GET|PATCH /v1/blocks/:id/children`. A page (or a row's page) is a block too, as in
 * Notion: its children are its content, then its sub-pages.
 */
import {
  blockChangeIn,
  blockValue,
  blocksIn,
  findBlock,
  invalid,
  listObject,
  parseId,
  parsePaging,
  type ApiBlock,
} from '@workspace/api-model';
import { trashPage } from '@workspace/core';
import { trashRow } from '@workspace/database';
import type { FastifyInstance } from 'fastify';
import {
  appendBlocks,
  deleteBlock,
  locateBlock,
  pageBlocks,
  titleOf,
  updateBlock,
} from './content';
import { viewOf } from './plugin';
import type { ApiView, Located } from './view';

const iso = (ms: number) => new Date(ms).toISOString();

function timesOf(page: Located) {
  if (page.kind === 'row') return { created: page.row.createdAt, edited: page.row.updatedAt };
  return { created: page.meta.createdAt, edited: page.meta.updatedAt };
}

/** A content block's object (its parent: the page, or the block it's in). */
export function blockJson(page: Located, b: ApiBlock, parent: string | null, trashed = false) {
  const { created, edited } = timesOf(page);
  return {
    object: 'block',
    id: b.id,
    parent: parent ? { type: 'block_id', block_id: parent } : { type: 'page_id', page_id: page.id },
    created_time: iso(created),
    last_edited_time: iso(edited),
    created_by: { object: 'user', id: null },
    last_edited_by: { object: 'user', id: null },
    archived: trashed,
    in_trash: trashed,
    ...blockValue(b),
  };
}

/** A page or a database as a block (`child_page` / `child_database`). */
async function pageAsBlock(api: ApiView, found: Located) {
  const { created, edited } = timesOf(found);
  const parent =
    found.kind === 'row'
      ? { type: 'database_id', database_id: found.database.id }
      : found.meta.parentId
        ? { type: 'page_id', page_id: found.meta.parentId }
        : { type: 'workspace', workspace: true };
  const isDatabase = found.kind === 'database';
  const children = isDatabase ? [] : await pageBlocks(api, found);
  return {
    object: 'block',
    id: found.id,
    parent,
    created_time: iso(created),
    last_edited_time: iso(edited),
    created_by: { object: 'user', id: null },
    last_edited_by: { object: 'user', id: null },
    has_children: isDatabase || children.length > 0,
    archived: false,
    in_trash: false,
    type: isDatabase ? 'child_database' : 'child_page',
    [isDatabase ? 'child_database' : 'child_page']: { title: titleOf(found) },
  };
}

const pathId = (raw: string) => {
  const id = parseId(raw);
  if (!id) throw invalid('path.block_id should be a valid uuid.');
  return id;
};

const asBody = (raw: unknown): Record<string, unknown> => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('body should be an object.');
  return raw as Record<string, unknown>;
};

/** The block's children as a list (a page's content and sub-pages). */
async function children(api: ApiView, id: string) {
  const page = await api.find(id);
  if (page) return { page, parent: null, blocks: await pageBlocks(api, page) };
  const found = await locateBlock(api, id);
  return { page: found.page, parent: id, blocks: found.block.children };
}

export function blockRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/blocks/:id', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    const id = pathId(request.params.id);
    const page = await api.find(id);
    if (page) return pageAsBlock(api, page);
    const found = await locateBlock(api, id);
    return blockJson(found.page, found.block, found.parent);
  });

  app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(
    '/blocks/:id/children',
    async (request) => {
      const api = viewOf(request);
      api.need('readContent');
      const { page, parent, blocks } = await children(api, pathId(request.params.id));
      return listObject(
        blocks,
        (b) => b.id,
        parsePaging(request.query),
        'block',
        (b) =>
          b.type === 'child_page' || b.type === 'child_database'
            ? blockJson(page, b, null)
            : blockJson(page, b, parent),
      );
    },
  );

  app.patch<{ Params: { id: string }; Body: unknown }>('/blocks/:id/children', async (request) => {
    const api = viewOf(request);
    api.need('insertContent');
    const id = pathId(request.params.id);
    const body = asBody(request.body);
    const nodes = blocksIn(body.children, 'body.children', {
      isUser: (u) => api.access.isMember(u),
    });
    const after = body.after === undefined ? null : parseId(body.after);
    if (body.after !== undefined && !after) throw invalid('body.after should be a valid uuid.');
    const page = await api.find(id);
    let target: Located;
    let into: string | null = null;
    if (page) {
      if (page.kind === 'database') throw invalid(`${id} is a database: add pages to it instead.`);
      target = page;
    } else {
      target = (await locateBlock(api, id)).page;
      into = id;
    }
    const ids = await appendBlocks(api, target, into, after, nodes);
    const blocks = await pageBlocks(api, target);
    const made = ids.map((n) => findBlock(blocks, n)).filter((x) => x !== null);
    return listObject(
      made,
      (m) => m.block.id,
      { startCursor: null, pageSize: 100 },
      'block',
      (m) => blockJson(target, m.block, m.parent),
    );
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/blocks/:id', async (request) => {
    const api = viewOf(request);
    api.need('updateContent');
    const id = pathId(request.params.id);
    const body = asBody(request.body);
    const trash = body.in_trash ?? body.archived;
    if (trash !== undefined && typeof trash !== 'boolean')
      throw invalid('body.in_trash should be a boolean.');
    const page = await api.find(id);
    if (page) {
      if (trash !== true)
        throw invalid('A page is changed with PATCH /v1/pages/:id; here it can only be trashed.');
      return trashPageBlock(api, page);
    }
    const found = await locateBlock(api, id);
    if (found.block.type === 'table_row')
      throw invalid("Table rows can't be changed through the API yet.");
    if (trash === true) {
      await deleteBlock(api, found.page, id);
      return blockJson(found.page, found.block, found.parent, true);
    }
    const change = blockChangeIn(found.block.type, body, { isUser: (u) => api.access.isMember(u) });
    if (!change.inline && !change.attrs) {
      throw invalid(
        `body.${found.block.type} should have what to change (it's a ${found.block.type} block).`,
      );
    }
    await updateBlock(api, found.page, id, change);
    const again = await locateBlock(api, id);
    return blockJson(again.page, again.block, again.parent);
  });

  app.delete<{ Params: { id: string } }>('/blocks/:id', async (request) => {
    const api = viewOf(request);
    api.need('updateContent');
    const id = pathId(request.params.id);
    const page = await api.find(id);
    if (page) return trashPageBlock(api, page);
    const found = await locateBlock(api, id);
    if (found.block.type === 'table_row')
      throw invalid("Table rows can't be deleted through the API yet.");
    await deleteBlock(api, found.page, id);
    return blockJson(found.page, found.block, found.parent, true);
  });
}

/** Trash a page through the blocks endpoints (as Notion allows). */
async function trashPageBlock(api: ApiView, page: Located) {
  const before = await pageAsBlock(api, page);
  if (page.kind === 'row') await api.edit(page.database.id, (doc) => trashRow(doc, page.id));
  else await api.edit(page.scope.treeDoc, (tree) => trashPage(tree, page.id));
  return { ...before, archived: true, in_trash: true };
}
