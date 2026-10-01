import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { newId } from './ids';
import { PAGES_MAP, PageField, type PageId, type PageMeta } from './schema';
import { applyTextDiff } from './text';

type PageMap = Y.Map<unknown>;

export function getPagesMap(doc: Y.Doc): Y.Map<PageMap> {
  return doc.getMap<PageMap>(PAGES_MAP);
}

function getPageMap(doc: Y.Doc, id: PageId): PageMap {
  const page = getPagesMap(doc).get(id);
  if (!page) throw new Error(`Page not found: ${id}`);
  return page;
}

function readPage(page: PageMap): PageMeta {
  const title = page.get(PageField.title);
  return {
    id: page.get(PageField.id) as string,
    parentId: (page.get(PageField.parentId) as string | null | undefined) ?? null,
    title: title instanceof Y.Text ? title.toString() : '',
    icon: (page.get(PageField.icon) as string | null | undefined) ?? null,
    sortKey: page.get(PageField.sortKey) as string,
    createdAt: page.get(PageField.createdAt) as number,
    updatedAt: page.get(PageField.updatedAt) as number,
    trashedAt: (page.get(PageField.trashedAt) as number | null | undefined) ?? null,
  };
}

export function getPage(doc: Y.Doc, id: PageId): PageMeta | null {
  const page = getPagesMap(doc).get(id);
  return page ? readPage(page) : null;
}

export function listPages(doc: Y.Doc): PageMeta[] {
  return Array.from(getPagesMap(doc).values(), readPage);
}

/** Order siblings by fractional index; ties (concurrent inserts) break on id. */
export function compareSiblings(a: PageMeta, b: PageMeta): number {
  if (a.sortKey < b.sortKey) return -1;
  if (a.sortKey > b.sortKey) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function siblingsOf(doc: Y.Doc, parentId: PageId | null, excludeId?: PageId): PageMeta[] {
  return listPages(doc)
    .filter((p) => p.parentId === parentId && p.id !== excludeId)
    .sort(compareSiblings);
}

/** Sort key that places an item at `index` among `siblings` (clamped to the ends). */
function sortKeyAt(siblings: PageMeta[], index: number): string {
  const i = Math.max(0, Math.min(index, siblings.length));
  const before = siblings[i - 1]?.sortKey ?? null;
  const after = siblings[i]?.sortKey ?? null;
  // Concurrent inserts can leave equal keys; fall back to appending after `before`.
  if (before !== null && after !== null && before >= after) {
    return generateKeyBetween(before, null);
  }
  return generateKeyBetween(before, after);
}

export interface CreatePageOptions {
  id?: PageId;
  parentId?: PageId | null;
  title?: string;
  icon?: string | null;
  /** Position among siblings; defaults to the end. */
  index?: number;
  now?: number;
}

export function createPage(doc: Y.Doc, options: CreatePageOptions = {}): PageId {
  const id = options.id ?? newId();
  const parentId = options.parentId ?? null;
  const now = options.now ?? Date.now();
  if (parentId !== null && !getPagesMap(doc).has(parentId)) {
    throw new Error(`Parent page not found: ${parentId}`);
  }

  doc.transact(() => {
    const siblings = siblingsOf(doc, parentId);
    const page = new Y.Map<unknown>();
    const title = new Y.Text();
    if (options.title) title.insert(0, options.title);
    page.set(PageField.id, id);
    page.set(PageField.parentId, parentId);
    page.set(PageField.title, title);
    page.set(PageField.icon, options.icon ?? null);
    page.set(PageField.sortKey, sortKeyAt(siblings, options.index ?? siblings.length));
    page.set(PageField.createdAt, now);
    page.set(PageField.updatedAt, now);
    page.set(PageField.trashedAt, null);
    getPagesMap(doc).set(id, page);
  });
  return id;
}

/** The collaborative Y.Text holding a page's title, for binding to an input. */
export function getPageTitleText(doc: Y.Doc, id: PageId): Y.Text {
  const title = getPageMap(doc, id).get(PageField.title);
  if (!(title instanceof Y.Text)) throw new Error(`Page has no title text: ${id}`);
  return title;
}

export function setPageTitle(doc: Y.Doc, id: PageId, title: string, now = Date.now()): void {
  doc.transact(() => {
    applyTextDiff(getPageTitleText(doc, id), title);
    getPageMap(doc, id).set(PageField.updatedAt, now);
  });
}

export function setPageIcon(doc: Y.Doc, id: PageId, icon: string | null, now = Date.now()): void {
  doc.transact(() => {
    const page = getPageMap(doc, id);
    page.set(PageField.icon, icon);
    page.set(PageField.updatedAt, now);
  });
}

/** Record that a page's content changed. */
export function touchPage(doc: Y.Doc, id: PageId, now = Date.now()): void {
  getPageMap(doc, id).set(PageField.updatedAt, now);
}

/** Ancestor ids from the direct parent upward. Stops on a cycle. */
export function getAncestorIds(doc: Y.Doc, id: PageId): PageId[] {
  const pages = getPagesMap(doc);
  const ancestors: PageId[] = [];
  const seen = new Set<PageId>([id]);
  let current = pages.get(id)?.get(PageField.parentId) as PageId | null | undefined;
  while (current && !seen.has(current) && pages.has(current)) {
    ancestors.push(current);
    seen.add(current);
    current = pages.get(current)?.get(PageField.parentId) as PageId | null | undefined;
  }
  return ancestors;
}

export function getDescendantIds(doc: Y.Doc, id: PageId): PageId[] {
  const children = new Map<PageId, PageId[]>();
  for (const page of listPages(doc)) {
    if (page.parentId === null) continue;
    const list = children.get(page.parentId) ?? [];
    list.push(page.id);
    children.set(page.parentId, list);
  }
  const result: PageId[] = [];
  const seen = new Set<PageId>([id]);
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    result.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return result;
}

export interface MovePageTarget {
  parentId: PageId | null;
  /** Position among the new siblings; defaults to the end. */
  index?: number;
}

export function movePage(doc: Y.Doc, id: PageId, target: MovePageTarget, now = Date.now()): void {
  const { parentId } = target;
  if (parentId === id) throw new Error('A page cannot be moved into itself');
  if (parentId !== null) {
    if (!getPagesMap(doc).has(parentId)) throw new Error(`Parent page not found: ${parentId}`);
    if (getAncestorIds(doc, parentId).includes(id)) {
      throw new Error('A page cannot be moved into one of its own sub-pages');
    }
  }
  doc.transact(() => {
    const page = getPageMap(doc, id);
    const siblings = siblingsOf(doc, parentId, id);
    page.set(PageField.parentId, parentId);
    page.set(PageField.sortKey, sortKeyAt(siblings, target.index ?? siblings.length));
    page.set(PageField.updatedAt, now);
  });
}

/** Move a page (and with it, its sub-pages) to the trash. */
export function trashPage(doc: Y.Doc, id: PageId, now = Date.now()): void {
  getPageMap(doc, id).set(PageField.trashedAt, now);
}

export function restorePage(doc: Y.Doc, id: PageId): void {
  getPageMap(doc, id).set(PageField.trashedAt, null);
}

/** True when the page or any ancestor is in the trash. */
export function isInTrash(doc: Y.Doc, id: PageId): boolean {
  const pages = getPagesMap(doc);
  return [id, ...getAncestorIds(doc, id)].some(
    (pid) => pages.get(pid)?.get(PageField.trashedAt) != null,
  );
}

/**
 * Permanently delete a page and all its sub-pages.
 * Returns the deleted ids so callers can drop the matching page docs.
 */
export function deletePagePermanently(doc: Y.Doc, id: PageId): PageId[] {
  const ids = [id, ...getDescendantIds(doc, id)];
  doc.transact(() => {
    const pages = getPagesMap(doc);
    for (const pid of ids) pages.delete(pid);
  });
  return ids;
}
