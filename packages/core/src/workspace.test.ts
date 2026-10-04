import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  duplicatePageTree,
  listUsers,
  upsertUser,
  buildPageTree,
  createPage,
  deletePagePermanently,
  getPage,
  getPageTitleText,
  isInTrash,
  listPages,
  movePage,
  restorePage,
  setPageIcon,
  setPageTitle,
  trashPage,
  type PageTreeNode,
} from './index';

const titles = (nodes: PageTreeNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.page.title, titles(n.children)] : n.page.title));

const sync = (a: Y.Doc, b: Y.Doc) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
};

describe('pages', () => {
  it('creates pages with metadata', () => {
    const doc = new Y.Doc();
    const id = createPage(doc, { title: 'Hello', icon: '👋', now: 1000 });
    expect(getPage(doc, id)).toEqual({
      id,
      kind: 'page',
      parentId: null,
      title: 'Hello',
      icon: '👋',
      sortKey: expect.any(String),
      createdAt: 1000,
      updatedAt: 1000,
      trashedAt: null,
      cover: null,
      fullWidth: false,
      smallText: false,
      font: 'default',
      locked: false,
    });
  });

  it('creates databases and keeps the kind when duplicating', () => {
    const doc = new Y.Doc();
    const id = createPage(doc, { title: 'Tasks', kind: 'database' });
    expect(getPage(doc, id)?.kind).toBe('database');
    const copy = duplicatePageTree(doc, id).get(id)!;
    expect(getPage(doc, copy)?.kind).toBe('database');
  });

  it('keeps one entry per user', () => {
    const doc = new Y.Doc();
    upsertUser(doc, { id: 'u1', name: 'ravi' });
    upsertUser(doc, { id: 'u1', name: 'Ravi' });
    expect(listUsers(doc)).toEqual([{ id: 'u1', name: 'Ravi' }]);
  });

  it('rejects a missing parent', () => {
    expect(() => createPage(new Y.Doc(), { parentId: 'nope' })).toThrow(/Parent page not found/);
  });

  it('orders siblings by insertion index', () => {
    const doc = new Y.Doc();
    createPage(doc, { title: 'B' });
    createPage(doc, { title: 'C' });
    createPage(doc, { title: 'A', index: 0 });
    createPage(doc, { title: 'B2', index: 2 });
    expect(titles(buildPageTree(listPages(doc)))).toEqual(['A', 'B', 'B2', 'C']);
  });

  it('nests pages and moves them', () => {
    const doc = new Y.Doc();
    const a = createPage(doc, { title: 'A' });
    const b = createPage(doc, { title: 'B' });
    const a1 = createPage(doc, { title: 'A1', parentId: a });
    expect(titles(buildPageTree(listPages(doc)))).toEqual([['A', ['A1']], 'B']);

    movePage(doc, a1, { parentId: b });
    movePage(doc, b, { parentId: null, index: 0 });
    expect(titles(buildPageTree(listPages(doc)))).toEqual([['B', ['A1']], 'A']);
  });

  it('refuses to move a page into its own subtree', () => {
    const doc = new Y.Doc();
    const a = createPage(doc, { title: 'A' });
    const a1 = createPage(doc, { title: 'A1', parentId: a });
    expect(() => movePage(doc, a, { parentId: a })).toThrow();
    expect(() => movePage(doc, a, { parentId: a1 })).toThrow(/sub-pages/);
  });

  it('edits titles and icons', () => {
    const doc = new Y.Doc();
    const id = createPage(doc, { title: 'Draft', now: 1 });
    setPageTitle(doc, id, 'Draft plan', 2);
    setPageIcon(doc, id, '📄', 3);
    expect(getPage(doc, id)).toMatchObject({ title: 'Draft plan', icon: '📄', updatedAt: 3 });
  });

  it('trashes, restores and permanently deletes subtrees', () => {
    const doc = new Y.Doc();
    const a = createPage(doc, { title: 'A' });
    const a1 = createPage(doc, { title: 'A1', parentId: a });
    const a2 = createPage(doc, { title: 'A2', parentId: a1 });
    createPage(doc, { title: 'B' });

    trashPage(doc, a);
    expect(isInTrash(doc, a2)).toBe(true);
    expect(titles(buildPageTree(listPages(doc)))).toEqual(['B']);
    expect(titles(buildPageTree(listPages(doc), { includeTrashed: true }))).toEqual([
      ['A', [['A1', ['A2']]]],
      'B',
    ]);

    restorePage(doc, a);
    expect(isInTrash(doc, a2)).toBe(false);

    expect(deletePagePermanently(doc, a1).sort()).toEqual([a1, a2].sort());
    expect(titles(buildPageTree(listPages(doc)))).toEqual(['A', 'B']);
  });
});

describe('merging edits from two devices', () => {
  it('merges concurrent title edits', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const id = createPage(a, { title: 'Meeting notes' });
    sync(a, b);

    setPageTitle(a, id, 'Weekly meeting notes');
    setPageTitle(b, id, 'Meeting notes (draft)');
    sync(a, b);

    expect(getPageTitleText(a, id).toString()).toBe('Weekly meeting notes (draft)');
    expect(getPage(b, id)?.title).toBe('Weekly meeting notes (draft)');
  });

  it('keeps pages visible when concurrent moves form a cycle', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const x = createPage(a, { title: 'X' });
    const y = createPage(a, { title: 'Y' });
    sync(a, b);

    movePage(a, x, { parentId: y });
    movePage(b, y, { parentId: x });
    sync(a, b);

    const tree = buildPageTree(listPages(a));
    const count = (nodes: PageTreeNode[]): number =>
      nodes.reduce((n, node) => n + 1 + count(node.children), 0);
    expect(count(tree)).toBe(2);
    expect(buildPageTree(listPages(b))).toEqual(tree);
  });

  it('shows pages whose parent was deleted at the top level', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const parent = createPage(a, { title: 'Parent' });
    sync(a, b);

    createPage(b, { title: 'Child', parentId: parent });
    deletePagePermanently(a, parent);
    sync(a, b);

    expect(titles(buildPageTree(listPages(a)))).toEqual(['Child']);
  });
});
