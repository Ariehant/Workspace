import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { moveSubtree, subtreeIds } from './scope-moves';
import { createPage, getPage, getPageTitleText, listPages, listStubs } from './workspace';

function tree() {
  const doc = new Y.Doc();
  const arm = createPage(doc, { id: 'arm', title: 'Arm' });
  createPage(doc, { id: 'wrist', title: 'Wrist', parentId: arm });
  createPage(doc, { id: 'grip', title: 'Grip', parentId: 'wrist' });
  createPage(doc, { id: 'base', title: 'Base' });
  return doc;
}

describe('moving a subtree between scopes', () => {
  it('lists a page and everything under it', () => {
    expect(subtreeIds(tree(), 'arm')).toEqual(['arm', 'wrist', 'grip']);
    expect(subtreeIds(tree(), 'nope')).toEqual([]);
  });

  it('shares a page: it moves to the new tree, leaving a stub in place', () => {
    const team = tree();
    const shared = new Y.Doc();
    const sortKey = getPage(team, 'wrist')!.sortKey;
    expect(moveSubtree(team, shared, 'wrist', { stubScope: 's-wrist' })).toEqual(['wrist', 'grip']);
    expect(
      listPages(team)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['arm', 'base']);
    expect(listStubs(team)).toEqual([{ id: 'wrist', parentId: 'arm', sortKey, scope: 's-wrist' }]);
    expect(getPage(team, 'wrist')).toBeNull();
    // In the new tree the page keeps its parent (readers of both place it there).
    expect(listPages(shared).map((p) => [p.id, p.parentId, p.title])).toEqual([
      ['wrist', 'arm', 'Wrist'],
      ['grip', 'wrist', 'Grip'],
    ]);
    // The title is a real text there (editable).
    getPageTitleText(shared, 'wrist').insert(5, ' joint');
    expect(getPage(shared, 'wrist')!.title).toBe('Wrist joint');
  });

  it('moves a page to the top or under a page of another tree', () => {
    const team = tree();
    const other = new Y.Doc();
    createPage(other, { id: 'robots', title: 'Robots' });
    createPage(other, { id: 'r2', title: 'R2', parentId: 'robots' });
    expect(moveSubtree(team, other, 'arm', { parentId: 'robots' })).toEqual([
      'arm',
      'wrist',
      'grip',
    ]);
    expect(listStubs(team)).toEqual([]);
    expect(listPages(team).map((p) => p.id)).toEqual(['base']);
    const arm = getPage(other, 'arm')!;
    expect(arm.parentId).toBe('robots');
    expect(arm.sortKey > getPage(other, 'r2')!.sortKey).toBe(true);
    expect(moveSubtree(team, other, 'arm')).toEqual([]);
  });
});
