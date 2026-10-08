import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { newId } from './ids';
import {
  PAGES_MAP,
  PageField,
  USERS_MAP,
  type PageCover,
  type PageFont,
  type PageId,
  type PageKind,
  type PageMeta,
  type PageOptions,
  type User,
} from './schema';
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

/**
 * Read a page-shaped Y.Map: a page in the workspace doc, or a database row (rows use
 * the same field names, so the page chrome works for both).
 */
export function readPageMap(page: Y.Map<unknown>): PageMeta {
  const title = page.get(PageField.title);
  return {
    id: page.get(PageField.id) as string,
    kind: (page.get(PageField.kind) as PageKind | undefined) ?? 'page',
    parentId: (page.get(PageField.parentId) as string | null | undefined) ?? null,
    title: title instanceof Y.Text ? title.toString() : '',
    icon: (page.get(PageField.icon) as string | null | undefined) ?? null,
    sortKey: page.get(PageField.sortKey) as string,
    createdAt: page.get(PageField.createdAt) as number,
    updatedAt: page.get(PageField.updatedAt) as number,
    trashedAt: (page.get(PageField.trashedAt) as number | null | undefined) ?? null,
    // Fields added after Phase 0 default when absent, so old workspaces need no migration.
    cover: (page.get(PageField.cover) as PageCover | null | undefined) ?? null,
    fullWidth: page.get(PageField.fullWidth) === true,
    smallText: page.get(PageField.smallText) === true,
    font: (page.get(PageField.font) as PageFont | undefined) ?? 'default',
    locked: page.get(PageField.locked) === true,
  };
}

/** A page that lives in another scope: only its place in this tree is kept here. */
export const isStub = (page: Y.Map<unknown>) => typeof page.get(PageField.scope) === 'string';

export function getPage(doc: Y.Doc, id: PageId): PageMeta | null {
  const page = getPagesMap(doc).get(id);
  return page && !isStub(page) ? readPageMap(page) : null;
}

/** The pages of this tree (stubs of pages in other scopes left out: see `listStubs`). */
export function listPages(doc: Y.Doc): PageMeta[] {
  const pages: PageMeta[] = [];
  for (const page of getPagesMap(doc).values()) if (!isStub(page)) pages.push(readPageMap(page));
  return pages;
}

export interface PageStub {
  id: PageId;
  parentId: PageId | null;
  sortKey: string;
  /** The scope the page lives in. */
  scope: string;
}

/** Pages of other scopes placed in this tree. */
export function listStubs(doc: Y.Doc): PageStub[] {
  const stubs: PageStub[] = [];
  for (const page of getPagesMap(doc).values()) {
    if (!isStub(page)) continue;
    stubs.push({
      id: page.get(PageField.id) as string,
      parentId: (page.get(PageField.parentId) as string | null | undefined) ?? null,
      sortKey: page.get(PageField.sortKey) as string,
      scope: page.get(PageField.scope) as string,
    });
  }
  return stubs;
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
  kind?: PageKind;
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
    if (options.kind && options.kind !== 'page') page.set(PageField.kind, options.kind);
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
  return pageMapTitle(getPageMap(doc, id));
}

/** Title Y.Text of a page-shaped map (page or database row). */
export function pageMapTitle(page: Y.Map<unknown>): Y.Text {
  const title = page.get(PageField.title);
  if (!(title instanceof Y.Text)) throw new Error('Page has no title text');
  return title;
}

/** Turn an empty page into a database (the caller sets up its database doc). */
export function setPageKind(doc: Y.Doc, id: PageId, kind: PageKind): void {
  getPageMap(doc, id).set(PageField.kind, kind);
}

// --- Users ---------------------------------------------------------------------------

export function getUsersMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap<Y.Map<unknown>>(USERS_MAP);
}

/** Add a user, or update their name. */
export function upsertUser(doc: Y.Doc, user: User): void {
  doc.transact(() => {
    const users = getUsersMap(doc);
    let entry = users.get(user.id);
    if (!entry) {
      entry = new Y.Map<unknown>();
      entry.set('id', user.id);
      users.set(user.id, entry);
    }
    if (entry.get('name') !== user.name) entry.set('name', user.name);
  });
}

export function listUsers(doc: Y.Doc): User[] {
  return Array.from(getUsersMap(doc).values(), (u) => ({
    id: u.get('id') as string,
    name: (u.get('name') as string | undefined) ?? '',
  }));
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

/** Change page-menu options (cover, width, text size, font, lock). */
export function setPageOptions(
  doc: Y.Doc,
  id: PageId,
  options: Partial<PageOptions>,
  now = Date.now(),
): void {
  doc.transact(() => {
    const page = getPageMap(doc, id);
    for (const [key, value] of Object.entries(options)) page.set(key, value);
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

/**
 * Copy a page and all its sub-pages (metadata only; see `copyPageContent` for the
 * content). The copy goes right after the original and gets " (1)" appended to its
 * title, like Notion. Returns a map from each original id to its copy.
 */
export function duplicatePageTree(doc: Y.Doc, id: PageId, now = Date.now()): Map<PageId, PageId> {
  const root = getPage(doc, id);
  if (!root) throw new Error(`Page not found: ${id}`);
  const mapping = new Map<PageId, PageId>();

  doc.transact(() => {
    const copy = (page: PageMeta, parentId: PageId | null, index?: number, title = page.title) => {
      const newId = createPage(doc, {
        parentId,
        title,
        icon: page.icon,
        kind: page.kind,
        index,
        now,
      });
      const { cover, fullWidth, smallText, font, locked } = page;
      setPageOptions(doc, newId, { cover, fullWidth, smallText, font, locked }, now);
      mapping.set(page.id, newId);
      for (const child of siblingsOf(doc, page.id)) {
        if (!mapping.has(child.id)) copy(child, newId);
      }
    };
    const siblings = siblingsOf(doc, root.parentId);
    const index = siblings.findIndex((p) => p.id === id) + 1;
    copy(root, root.parentId, index, `${root.title || 'Untitled'} (1)`);
  });
  return mapping;
}
