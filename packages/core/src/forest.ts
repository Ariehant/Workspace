/**
 * The page trees someone can see, as one tree (Phase 5).
 *
 * A server workspace keeps its pages' metadata in one tree doc per scope (a teamspace,
 * someone's private pages, a page shared on its own; see docs/PHASE5.md). A `Forest`
 * holds the tree docs the person can read, and the page functions in `workspace.ts`
 * accept it wherever they accept a single tree doc: reads see the union, and each write
 * goes to the tree the page lives in.
 *
 * A page shared on its own lives in its own scope's tree, and the tree it was shared from
 * keeps a *stub* (its id, parent and position). Whoever can read both sees the page in
 * the stub's place; whoever can read only the shared scope sees it at the top level.
 */
import type * as Y from 'yjs';
import { PAGES_MAP, PageField, type PageId } from './schema';

/** Is this the id of a tree doc (the first scope's `workspace`, or another scope's)? */
export const isTreeDocId = (docId: string): boolean =>
  docId === 'workspace' || docId.startsWith('tree:');

export type TreeKind = 'teamspace' | 'private' | 'shared' | 'local';
export type TreeRole = 'full' | 'edit' | 'content' | 'comment' | 'view';

export interface TreeInfo {
  /** The tree doc's id: `workspace`, or `tree:<scopeId>`. */
  id: string;
  /** The scope; `null` for a workspace that isn't synced (one tree, all the user's). */
  scope: string | null;
  kind: TreeKind;
  name: string;
  role: TreeRole;
  /** The scope this one inherits access from (a shared page's), if any. */
  parent: string | null;
}

export interface Tree {
  info: TreeInfo;
  doc: Y.Doc;
}

const RANK: Record<TreeRole, number> = { view: 1, comment: 2, content: 3, edit: 4, full: 5 };

/** Does `role` allow at least `needed`? */
export const roleAllows = (role: TreeRole | null | undefined, needed: TreeRole): boolean =>
  !!role && RANK[role] >= RANK[needed];

/** A local workspace's single tree. */
export const localTree = (doc: Y.Doc, id = 'workspace'): Tree => ({
  info: { id, scope: null, kind: 'local', name: 'Private', role: 'full', parent: null },
  doc,
});

/** A page's entry in a tree doc, real or a stub. */
export interface TreeEntry {
  tree: Tree;
  map: Y.Map<unknown>;
}

/**
 * Moving a page there means moving it to another scope, which the server does (it
 * re-places the pages' docs and changes who can see them).
 */
export class ScopeMoveError extends Error {
  constructor(
    readonly pageId: PageId,
    /** The tree the page is placed in now. */
    readonly from: string,
    /** The tree it would go to. */
    readonly to: string,
    readonly parentId: PageId | null,
  ) {
    super('Moving this page changes who can see it');
    this.name = 'ScopeMoveError';
  }
}

const pagesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>(PAGES_MAP);
const stub = (map: Y.Map<unknown>) => typeof map.get(PageField.scope) === 'string';

export class Forest {
  private trees: Tree[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly onDocUpdate = () => this.emit();

  constructor(trees: readonly Tree[] = []) {
    this.set(trees);
  }

  /** Replace the trees (when access changes); listeners hear about it. */
  set(trees: readonly Tree[]): void {
    const next = [...trees];
    for (const old of this.trees) {
      if (!next.some((t) => t.doc === old.doc)) old.doc.off('update', this.onDocUpdate);
    }
    for (const tree of next) {
      if (!this.trees.some((t) => t.doc === tree.doc)) tree.doc.on('update', this.onDocUpdate);
    }
    this.trees = next;
    this.emit();
  }

  list(): readonly Tree[] {
    return this.trees;
  }

  get(id: string): Tree | undefined {
    return this.trees.find((t) => t.info.id === id);
  }

  byScope(scopeId: string): Tree | undefined {
    return this.trees.find((t) => t.info.scope === scopeId);
  }

  /** Where a page really lives (not a stub of it). */
  entryOf(pageId: PageId): TreeEntry | undefined {
    for (const tree of this.trees) {
      const map = pagesOf(tree.doc).get(pageId);
      if (map && !stub(map)) return { tree, map };
    }
    return undefined;
  }

  /** A stub placing the page in another tree, if one is readable here. */
  stubOf(pageId: PageId): TreeEntry | undefined {
    for (const tree of this.trees) {
      const map = pagesOf(tree.doc).get(pageId);
      if (map && stub(map)) return { tree, map };
    }
    return undefined;
  }

  treeOf(pageId: PageId): Tree | undefined {
    return this.entryOf(pageId)?.tree;
  }

  /** The tree a page shows in: its stub's, or its own. */
  homeOf(pageId: PageId): Tree | undefined {
    return (this.stubOf(pageId) ?? this.entryOf(pageId))?.tree;
  }

  /**
   * Where new top-level pages go unless a section is named: a local workspace's tree,
   * else the person's private pages, else the first tree they can edit.
   */
  get primary(): Tree | undefined {
    return (
      this.trees.find((t) => t.info.kind === 'local') ??
      this.trees.find((t) => t.info.kind === 'private' && t.info.role === 'full') ??
      this.trees.find((t) => roleAllows(t.info.role, 'edit'))
    );
  }

  /** Run `fn` in a transaction on every tree (so observers see one change). */
  transact(fn: () => void, origin?: unknown): void {
    const run = (i: number): void => {
      if (i === this.trees.length) fn();
      else this.trees[i]!.doc.transact(() => run(i + 1), origin);
    };
    run(0);
  }

  /** Like `Y.Doc.on('update')`: any tree changed, or the set of trees did. */
  on(_event: 'update', listener: () => void): void {
    this.listeners.add(listener);
  }

  off(_event: 'update', listener: () => void): void {
    this.listeners.delete(listener);
  }

  destroy(): void {
    for (const tree of this.trees) tree.doc.off('update', this.onDocUpdate);
    this.trees = [];
    this.listeners.clear();
  }

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }
}
