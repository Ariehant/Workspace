/**
 * Page content through the API (Phase 6 M6): blocks read from a page's doc (as the
 * editor's JSON, then Notion's blocks), and written back as Yjs elements made with the
 * editor's own schema, so what the API writes is what the editor would.
 *
 * Every block has an id (`id` on its node). Content from before ids were set on every
 * block gets them the first time the API reads it (a server edit, as anyone's).
 */
import {
  ApiError,
  blocksOut,
  findBlock,
  invalid,
  notFound,
  type ApiBlock,
  type BlockContext,
  type BlockChange,
  type PMNode,
} from '@workspace/api-model';
import {
  MEMBERS_DOC_ID,
  PAGE_CONTENT_FIELD,
  WORKSPACE_DOC_ID,
  getPage,
  isInTrash,
  listPages,
  newId,
  userNames,
} from '@workspace/core';
import { contentElements, contentJson, inlineElements } from '@workspace/editor';
import * as Y from 'yjs';
import type { ApiView, Located } from './view';

/** Node types that carry a block id. */
const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'details',
  'callout',
  'blockMath',
  'table',
  'columnList',
  'column',
  'pageLink',
  'database',
  'linkedDatabase',
  'syncedBlock',
  'button',
  'breadcrumb',
  'tableOfContents',
  'image',
  'video',
  'audio',
  'pdf',
  'file',
  'bookmark',
  'embed',
]);

/** The page's content doc: a page's own, or a row's page. */
export const contentDocOf = (found: Located) => found.id;

/** The scope a new content doc goes in (its page's, or its database's). */
export const scopeOf = (found: Located) =>
  found.kind === 'row' ? found.database.scope.id : found.scope.id;

function* elements(parent: Y.XmlFragment | Y.XmlElement): Generator<Y.XmlElement> {
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      yield child;
      yield* elements(child);
    }
  }
}

/** The element of a block, by id. */
export function elementById(doc: Y.Doc, id: string): Y.XmlElement | null {
  for (const el of elements(doc.getXmlFragment(PAGE_CONTENT_FIELD))) {
    if (el.getAttribute('id') === id) return el;
  }
  return null;
}

/** Give blocks without an id one (once, as a trusted server edit). */
async function ensureIds(api: ApiView, found: Located): Promise<void> {
  const doc = await api.doc(contentDocOf(found));
  if (!doc) return;
  const missing = [...elements(doc.getXmlFragment(PAGE_CONTENT_FIELD))].some(
    (el) => BLOCK_TYPES.has(el.nodeName) && !el.getAttribute('id'),
  );
  if (!missing) return;
  await api.ctx.docs.edit(
    api.workspaceId,
    contentDocOf(found),
    { trusted: true, userId: null },
    (d) => {
      for (const el of elements(d.getXmlFragment(PAGE_CONTENT_FIELD))) {
        if (BLOCK_TYPES.has(el.nodeName) && !el.getAttribute('id')) el.setAttribute('id', newId());
      }
    },
  );
  api.forget(contentDocOf(found));
}

/** What converting content needs: titles of pages, names of people, file links. */
export async function blockContext(api: ApiView): Promise<BlockContext> {
  const titles = new Map<string, string>();
  for (const scope of api.readableScopes()) {
    const tree = await api.doc(scope.treeDoc);
    if (tree) for (const page of listPages(tree)) titles.set(page.id, page.title);
  }
  const names = userNames(await api.doc(WORKSPACE_DOC_ID), await api.doc(MEMBERS_DOC_ID));
  const links = api.links;
  return {
    fileUrl: links.fileUrl,
    pageUrl: links.pageUrl,
    pageTitle: (id) => titles.get(id) ?? null,
    userName: (id) => names.get(id) ?? null,
  };
}

/** A page's blocks: its content, then its sub-pages and databases (as Notion lists them). */
export async function pageBlocks(api: ApiView, found: Located): Promise<ApiBlock[]> {
  if (found.kind === 'database') {
    throw invalid(`${found.id} is a database: its pages are queried, not listed as blocks.`);
  }
  await ensureIds(api, found);
  const doc = await api.doc(contentDocOf(found));
  const content = doc ? (contentJson(doc) as PMNode[]) : [];
  const blocks = blocksOut(content, await blockContext(api));
  if (found.kind === 'page') {
    const subpages = listPages(found.tree)
      .filter((p) => p.parentId === found.id && !isInTrash(found.tree, p.id))
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    for (const p of subpages) {
      blocks.push(
        p.kind === 'database'
          ? { id: p.id, type: 'child_database', value: { title: p.title }, children: [] }
          : { id: p.id, type: 'child_page', value: { title: p.title }, children: [] },
      );
    }
  }
  return blocks;
}

/** Ids made by `derivedId` (table rows). */
const DERIVED = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-9[0-9a-f]{3}-[0-9a-f]{12}$/;

/** Block id → the page it's in (blocks found before; looked for again on a miss). */
const pageOfBlock = new Map<string, string>();
const MAX_KNOWN = 50_000;

/** A block in a page the bot reads: the page, the block, and its parent's id. */
export async function locateBlock(
  api: ApiView,
  id: string,
): Promise<{ page: Located; block: ApiBlock; parent: string | null }> {
  const known = pageOfBlock.get(id);
  const candidates: Located[] = [];
  if (known) {
    const page = await api.find(known);
    if (page) candidates.push(page);
  }
  if (candidates.length === 0) {
    for (const scope of api.readableScopes()) {
      const tree = await api.doc(scope.treeDoc);
      if (!tree) continue;
      for (const meta of listPages(tree)) {
        const page = await api.find(meta.id);
        if (!page) continue;
        if (page.kind === 'database') {
          for (const row of (await api.snapshot(page)).rows) {
            const located = await api.find(row.id);
            if (located) candidates.push(located);
          }
        } else candidates.push(page);
      }
    }
  }
  for (const page of candidates) {
    const doc = await api.doc(contentDocOf(page));
    // (A table row's id is made from its table's, so it isn't on any element.)
    if (!doc || (!known && !DERIVED.test(id) && !elementById(doc, id))) continue;
    const blocks = await pageBlocks(api, page);
    const found = findBlock(blocks, id);
    if (found) {
      if (pageOfBlock.size >= MAX_KNOWN) pageOfBlock.clear();
      pageOfBlock.set(id, page.id);
      return { page, block: found.block, parent: found.parent };
    }
  }
  throw notFound(id);
}

export const rememberBlocks = (pageId: string, ids: readonly string[]) => {
  for (const id of ids) pageOfBlock.set(id, pageId);
};

// --- Writing ----------------------------------------------------------------------------

/** Where a block's children go (its element, or a part of it); null if it can't have any. */
function childrenOf(el: Y.XmlElement): Y.XmlElement | null {
  switch (el.nodeName) {
    case 'listItem':
    case 'taskItem':
    case 'blockquote':
    case 'callout':
    case 'column':
      return el;
    case 'details':
      return (
        (el.toArray().find((c) => c instanceof Y.XmlElement && c.nodeName === 'detailsContent') as
          Y.XmlElement | undefined) ?? null
      );
    default:
      return null;
  }
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

/** The ids of new top-level blocks (list items for lists). */
function newIds(made: readonly (Y.XmlElement | Y.XmlText)[]): string[] {
  const ids: string[] = [];
  for (const el of made) {
    if (!(el instanceof Y.XmlElement)) continue;
    if (LISTS.has(el.nodeName)) {
      for (const item of el.toArray()) {
        if (item instanceof Y.XmlElement) ids.push(String(item.getAttribute('id') ?? ''));
      }
    } else ids.push(String(el.getAttribute('id') ?? ''));
  }
  return ids;
}

/**
 * Append blocks (editor JSON) to a page or into a block, after one of its children if
 * `after` is given. Returns the new blocks' ids.
 */
export async function appendBlocks(
  api: ApiView,
  page: Located,
  into: string | null,
  after: string | null,
  nodes: readonly PMNode[],
): Promise<string[]> {
  if (nodes.length === 0) return [];
  const { elements: made, dropped } = contentElements(nodes);
  if (dropped.length) throw invalid(`body.children: ${dropped.join(', ')} couldn't be made.`);
  const ids = await api.edit(
    contentDocOf(page),
    (doc) => {
      const fragment = doc.getXmlFragment(PAGE_CONTENT_FIELD);
      let container: Y.XmlFragment | Y.XmlElement = fragment;
      if (into) {
        const el = elementById(doc, into);
        if (!el) throw notFound(into);
        const inner = childrenOf(el);
        if (!inner) throw invalid(`Blocks of this type can't have children here.`);
        container = inner;
      }
      const children = container.toArray();
      let index = container.length;
      let pending = [...made];
      const merged: Y.XmlElement[] = [];
      if (after) {
        const direct = children.findIndex(
          (c) => c instanceof Y.XmlElement && c.getAttribute('id') === after,
        );
        if (direct >= 0) index = direct + 1;
        else {
          // After a list item: into its list when the first new block is the same kind.
          const listIndex = children.findIndex(
            (c) =>
              c instanceof Y.XmlElement &&
              LISTS.has(c.nodeName) &&
              c.toArray().some((i) => i instanceof Y.XmlElement && i.getAttribute('id') === after),
          );
          if (listIndex < 0) throw invalid(`body.after: ${after} isn't a child of this block.`);
          const list = children[listIndex] as Y.XmlElement;
          const first = pending[0];
          index = listIndex + 1;
          if (first instanceof Y.XmlElement && first.nodeName === list.nodeName) {
            // Its items move into the list (once in the doc: new elements can't be read).
            container.insert(index, [first]);
            const items = first.toArray().map((i) => (i as Y.XmlElement).clone());
            container.delete(index, 1);
            const at = list
              .toArray()
              .findIndex((i) => i instanceof Y.XmlElement && i.getAttribute('id') === after);
            list.insert(at + 1, items);
            merged.push(...items);
            pending = pending.slice(1);
          }
        }
      }
      if (pending.length) container.insert(index, pending);
      // (Ids are read once the elements are in the doc.)
      return [...merged.map((el) => String(el.getAttribute('id') ?? '')), ...newIds(pending)];
    },
    scopeOf(page),
  );
  rememberBlocks(page.id, ids);
  return ids;
}

/** The element holding a block's text (a list item's paragraph, a toggle's summary…). */
function textHolder(el: Y.XmlElement): Y.XmlElement | null {
  switch (el.nodeName) {
    case 'paragraph':
    case 'heading':
    case 'codeBlock':
      return el;
    case 'listItem':
    case 'taskItem':
    case 'blockquote':
    case 'callout': {
      const first = el.get(0);
      return first instanceof Y.XmlElement && first.nodeName === 'paragraph' ? first : null;
    }
    case 'details': {
      const summary = el
        .toArray()
        .find((c) => c instanceof Y.XmlElement && c.nodeName === 'detailsSummary');
      return (summary as Y.XmlElement | undefined) ?? null;
    }
    default:
      return null;
  }
}

/** Change a block's text and settings (it keeps its id and children). */
export async function updateBlock(api: ApiView, page: Located, id: string, change: BlockChange) {
  await api.edit(contentDocOf(page), (doc) => {
    const el = elementById(doc, id);
    if (!el) throw notFound(id);
    if (change.inline) {
      const holder = textHolder(el);
      if (!holder) throw invalid('This block has no text to change.');
      const inline =
        holder.nodeName === 'detailsSummary'
          ? change.inline.filter((n) => n.type === 'text')
          : change.inline;
      const made = inlineElements(
        holder.nodeName === 'codeBlock' ? 'codeBlock' : 'paragraph',
        inline,
      );
      holder.delete(0, holder.length);
      if (made.length) holder.insert(0, made);
    }
    for (const [key, value] of Object.entries(change.attrs ?? {})) {
      if (key === 'color' && (el.nodeName === 'listItem' || el.nodeName === 'taskItem')) {
        // A list's color is the list's.
        const list = el.parent;
        if (list instanceof Y.XmlElement) {
          if (value === null) list.removeAttribute('color');
          else list.setAttribute('color', value as string);
        }
        continue;
      }
      if (value === null) el.removeAttribute(key);
      else el.setAttribute(key, value as string);
    }
  });
}

/** Delete a block (and a list left empty). */
export async function deleteBlock(api: ApiView, page: Located, id: string) {
  await api.edit(contentDocOf(page), (doc) => {
    const el = elementById(doc, id);
    if (!el) throw notFound(id);
    const parent = el.parent as Y.XmlElement | Y.XmlFragment | null;
    if (!parent) throw new ApiError('conflict_error', 'The block moved; try again.');
    const index = parent.toArray().indexOf(el);
    parent.delete(index, 1);
    if (parent instanceof Y.XmlElement && LISTS.has(parent.nodeName) && parent.length === 0) {
      const outer = parent.parent as Y.XmlElement | Y.XmlFragment | null;
      if (outer) outer.delete(outer.toArray().indexOf(parent), 1);
    }
  });
}

/** A page's own title (for child_page blocks of pages and rows). */
export function titleOf(found: Located): string {
  if (found.kind === 'row') return found.row.title;
  return getPage(found.tree, found.id)?.title ?? '';
}
