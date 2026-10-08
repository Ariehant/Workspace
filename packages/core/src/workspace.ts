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
import { Forest, ScopeMoveError, type Tree } from './forest';

type PageMap = Y.Map<unknown>;

/**
 * A page tree: one tree doc, or the trees of every scope someone can read (`Forest`).
 * The page functions below accept either.
 */
export type PageTree = Y.Doc | Forest;

const isForest = (tree: PageTree): tree is Forest => tree instanceof Forest;

const detached = new WeakMap<Forest, Y.Doc>();

/**
 * The doc holding workspace-wide data that isn't pages (math macros, the old list of
 * users): the workspace doc. Someone who can't read it gets a doc of their own that
 * isn't synced, so those settings are at their defaults for them.
 */
export function workspaceDataDoc(tree: PageTree): Y.Doc {
  if (!isForest(tree)) return tree;
  const own = tree.get('workspace')?.doc;
  if (own) return own;
  let doc = detached.get(tree);
  if (!doc) detached.set(tree, (doc = new Y.Doc()));
  return doc;
}

/** Run `fn` in one transaction on the tree (every tree of a forest). */
export function transactTree(tree: PageTree, fn: () => void, origin?: unknown): void {
  if (isForest(tree)) tree.transact(fn, origin);
  else tree.transact(fn, origin);
}

/** The doc holding the page itself (not a stub of it). */
function docOf(tree: PageTree, id: PageId): Y.Doc {
  if (!isForest(tree)) return tree;
  const entry = tree.entryOf(id);
  if (!entry) throw new Error(`Page not found: ${id}`);
  return entry.tree.doc;
}

export function getPagesMap(doc: Y.Doc): Y.Map<PageMap> {
  return doc.getMap<PageMap>(PAGES_MAP);
}

function getPageMap(tree: PageTree, id: PageId): PageMap {
  const page = isForest(tree) ? tree.entryOf(id)?.map : getPagesMap(tree).get(id);
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

/** A page of a forest: placed where its stub is (if one is readable), else its own place. */
function readForestPage(page: PageMap, home: Tree, own: Tree, place: PageMap | null): PageMeta {
  const meta = readPageMap(page);
  if (place) {
    meta.parentId = (place.get(PageField.parentId) as string | null | undefined) ?? null;
    meta.sortKey = place.get(PageField.sortKey) as string;
  }
  meta.tree = own.info.id;
  meta.home = home.info.id;
  return meta;
}

export function getPage(tree: PageTree, id: PageId): PageMeta | null {
  if (isForest(tree)) {
    const entry = tree.entryOf(id);
    if (!entry) return null;
    const placed = tree.stubOf(id);
    const page = readForestPage(entry.map, (placed ?? entry).tree, entry.tree, placed?.map ?? null);
    // A parent this person can't see: the page shows at the top level.
    if (page.parentId !== null && !tree.entryOf(page.parentId)) page.parentId = null;
    return page;
  }
  const page = getPagesMap(tree).get(id);
  return page && !isStub(page) ? readPageMap(page) : null;
}

/** The pages of the tree (stubs of pages in other scopes left out: see `listStubs`). */
export function listPages(tree: PageTree): PageMeta[] {
  const pages: PageMeta[] = [];
  if (isForest(tree)) {
    const own = new Map<string, { map: PageMap; tree: Tree }>();
    const stubs = new Map<string, { map: PageMap; tree: Tree }>();
    for (const t of tree.list()) {
      for (const [id, page] of getPagesMap(t.doc)) {
        const into = isStub(page) ? stubs : own;
        if (!into.has(id)) into.set(id, { map: page, tree: t });
      }
    }
    for (const [id, entry] of own) {
      const placed = stubs.get(id);
      const page = readForestPage(
        entry.map,
        (placed ?? entry).tree,
        entry.tree,
        placed?.map ?? null,
      );
      if (page.parentId !== null && !own.has(page.parentId)) page.parentId = null;
      pages.push(page);
    }
    return pages;
  }
  for (const page of getPagesMap(tree).values()) if (!isStub(page)) pages.push(readPageMap(page));
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

/** A page's siblings; at the top level of a forest, those in the same tree (`home`). */
function siblingsOf(
  tree: PageTree,
  parentId: PageId | null,
  excludeId?: PageId,
  home?: string,
): PageMeta[] {
  return listPages(tree)
    .filter(
      (p) =>
        p.parentId === parentId &&
        p.id !== excludeId &&
        (parentId !== null || home === undefined || p.home === home),
    )
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
  /**
   * A forest's tree for a top-level page (default: `Forest.primary`). A sub-page goes to
   * its parent's tree.
   */
  tree?: string;
}

export function createPage(tree: PageTree, options: CreatePageOptions = {}): PageId {
  const id = options.id ?? newId();
  const parentId = options.parentId ?? null;
  const now = options.now ?? Date.now();
  let doc: Y.Doc;
  let home: string | undefined;
  if (isForest(tree)) {
    if (parentId !== null) {
      doc = docOf(tree, parentId);
    } else {
      const target = options.tree ? tree.get(options.tree) : tree.primary;
      if (!target) throw new Error('No page tree to add the page to');
      doc = target.doc;
      home = target.info.id;
    }
  } else {
    doc = tree;
    if (parentId !== null && !getPagesMap(doc).has(parentId)) {
      throw new Error(`Parent page not found: ${parentId}`);
    }
  }

  doc.transact(() => {
    const siblings = siblingsOf(tree, parentId, undefined, home);
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
export function getPageTitleText(tree: PageTree, id: PageId): Y.Text {
  return pageMapTitle(getPageMap(tree, id));
}

/** Title Y.Text of a page-shaped map (page or database row). */
export function pageMapTitle(page: Y.Map<unknown>): Y.Text {
  const title = page.get(PageField.title);
  if (!(title instanceof Y.Text)) throw new Error('Page has no title text');
  return title;
}

/** Turn an empty page into a database (the caller sets up its database doc). */
export function setPageKind(tree: PageTree, id: PageId, kind: PageKind): void {
  getPageMap(tree, id).set(PageField.kind, kind);
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

export function setPageTitle(tree: PageTree, id: PageId, title: string, now = Date.now()): void {
  docOf(tree, id).transact(() => {
    applyTextDiff(getPageTitleText(tree, id), title);
    getPageMap(tree, id).set(PageField.updatedAt, now);
  });
}

export function setPageIcon(
  tree: PageTree,
  id: PageId,
  icon: string | null,
  now = Date.now(),
): void {
  docOf(tree, id).transact(() => {
    const page = getPageMap(tree, id);
    page.set(PageField.icon, icon);
    page.set(PageField.updatedAt, now);
  });
}

/** Change page-menu options (cover, width, text size, font, lock). */
export function setPageOptions(
  tree: PageTree,
  id: PageId,
  options: Partial<PageOptions>,
  now = Date.now(),
): void {
  docOf(tree, id).transact(() => {
    const page = getPageMap(tree, id);
    for (const [key, value] of Object.entries(options)) page.set(key, value);
    page.set(PageField.updatedAt, now);
  });
}

/** Record that a page's content changed. */
export function touchPage(tree: PageTree, id: PageId, now = Date.now()): void {
  getPageMap(tree, id).set(PageField.updatedAt, now);
}

/** Ancestor ids from the direct parent upward. Stops on a cycle. */
export function getAncestorIds(tree: PageTree, id: PageId): PageId[] {
  const parentOf = isForest(tree)
    ? (pid: PageId) => (tree.entryOf(pid) ? (getPage(tree, pid)?.parentId ?? null) : null)
    : (pid: PageId) =>
        (getPagesMap(tree).get(pid)?.get(PageField.parentId) as PageId | null | undefined) ?? null;
  const exists = isForest(tree)
    ? (pid: PageId) => !!tree.entryOf(pid)
    : (pid: PageId) => getPagesMap(tree).has(pid);
  const ancestors: PageId[] = [];
  const seen = new Set<PageId>([id]);
  let current = parentOf(id);
  while (current && !seen.has(current) && exists(current)) {
    ancestors.push(current);
    seen.add(current);
    current = parentOf(current);
  }
  return ancestors;
}

export function getDescendantIds(tree: PageTree, id: PageId): PageId[] {
  const children = new Map<PageId, PageId[]>();
  for (const page of listPages(tree)) {
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
  /** A forest's tree to move a page to the top level of (default: where it is now). */
  tree?: string;
}

/**
 * Move a page within its tree. In a forest, a move that would take it to another tree
 * (another scope) throws `ScopeMoveError`: the server does those.
 */
export function movePage(
  tree: PageTree,
  id: PageId,
  target: MovePageTarget,
  now = Date.now(),
): void {
  const { parentId } = target;
  if (parentId === id) throw new Error('A page cannot be moved into itself');
  if (parentId !== null) {
    const exists = isForest(tree) ? !!tree.entryOf(parentId) : getPagesMap(tree).has(parentId);
    if (!exists) throw new Error(`Parent page not found: ${parentId}`);
    if (getAncestorIds(tree, parentId).includes(id)) {
      throw new Error('A page cannot be moved into one of its own sub-pages');
    }
  }
  if (!isForest(tree)) {
    tree.transact(() => {
      const page = getPageMap(tree, id);
      const siblings = siblingsOf(tree, parentId, id);
      page.set(PageField.parentId, parentId);
      page.set(PageField.sortKey, sortKeyAt(siblings, target.index ?? siblings.length));
      page.set(PageField.updatedAt, now);
    });
    return;
  }
  // The entry that places the page: its stub (shown there), or the page itself.
  const own = tree.entryOf(id);
  if (!own) throw new Error(`Page not found: ${id}`);
  const place = tree.stubOf(id) ?? own;
  const to =
    parentId !== null
      ? tree.entryOf(parentId)!.tree
      : target.tree
        ? tree.get(target.tree)
        : place.tree;
  if (!to) throw new Error(`No such tree: ${target.tree}`);
  if (to !== place.tree) throw new ScopeMoveError(id, place.tree.info.id, to.info.id, parentId);
  place.tree.doc.transact(() => {
    const siblings = siblingsOf(tree, parentId, id, to.info.id);
    place.map.set(PageField.parentId, parentId);
    place.map.set(PageField.sortKey, sortKeyAt(siblings, target.index ?? siblings.length));
    if (place === own) own.map.set(PageField.updatedAt, now);
  });
}

/** Move a page (and with it, its sub-pages) to the trash. */
export function trashPage(tree: PageTree, id: PageId, now = Date.now()): void {
  getPageMap(tree, id).set(PageField.trashedAt, now);
}

export function restorePage(tree: PageTree, id: PageId): void {
  getPageMap(tree, id).set(PageField.trashedAt, null);
}

/** True when the page or any ancestor is in the trash. */
export function isInTrash(tree: PageTree, id: PageId): boolean {
  const mapOf = (pid: PageId) =>
    isForest(tree) ? tree.entryOf(pid)?.map : getPagesMap(tree).get(pid);
  return [id, ...getAncestorIds(tree, id)].some(
    (pid) => mapOf(pid)?.get(PageField.trashedAt) != null,
  );
}

/**
 * Permanently delete a page and all its sub-pages.
 * Returns the deleted ids so callers can drop the matching page docs.
 */
export function deletePagePermanently(tree: PageTree, id: PageId): PageId[] {
  const ids = [id, ...getDescendantIds(tree, id)];
  if (!isForest(tree)) {
    tree.transact(() => {
      const pages = getPagesMap(tree);
      for (const pid of ids) pages.delete(pid);
    });
    return ids;
  }
  tree.transact(() => {
    for (const pid of ids) {
      for (const entry of [tree.entryOf(pid), tree.stubOf(pid)]) {
        if (entry) getPagesMap(entry.tree.doc).delete(pid);
      }
    }
  });
  return ids;
}

/**
 * Copy a page and all its sub-pages (metadata only; see `copyPageContent` for the
 * content). The copy goes right after the original and gets " (1)" appended to its
 * title, like Notion. Returns a map from each original id to its copy.
 */
export function duplicatePageTree(
  tree: PageTree,
  id: PageId,
  now = Date.now(),
): Map<PageId, PageId> {
  const root = getPage(tree, id);
  if (!root) throw new Error(`Page not found: ${id}`);
  const mapping = new Map<PageId, PageId>();

  transactTree(tree, () => {
    const copy = (page: PageMeta, parentId: PageId | null, index?: number, title = page.title) => {
      const newId = createPage(tree, {
        parentId,
        title,
        icon: page.icon,
        kind: page.kind,
        index,
        now,
        tree: root.home,
      });
      const { cover, fullWidth, smallText, font, locked } = page;
      setPageOptions(tree, newId, { cover, fullWidth, smallText, font, locked }, now);
      mapping.set(page.id, newId);
      for (const child of siblingsOf(tree, page.id)) {
        if (!mapping.has(child.id)) copy(child, newId);
      }
    };
    const siblings = siblingsOf(tree, root.parentId, undefined, root.home);
    const index = siblings.findIndex((p) => p.id === id) + 1;
    copy(root, root.parentId, index, `${root.title || 'Untitled'} (1)`);
  });
  return mapping;
}
