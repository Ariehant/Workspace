import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Forest, ScopeMoveError, localTree, roleAllows, type Tree, type TreeInfo } from './forest';
import { moveSubtree } from './scope-moves';
import {
  createPage,
  deletePagePermanently,
  duplicatePageTree,
  getAncestorIds,
  getDescendantIds,
  getPage,
  isInTrash,
  listPages,
  movePage,
  setPageTitle,
  trashPage,
} from './workspace';

const tree = (id: string, kind: TreeInfo['kind'], role: TreeInfo['role'] = 'full'): Tree => ({
  info: { id: `tree:${id}`, scope: id, kind, name: id, role, parent: null },
  doc: new Y.Doc(),
});

const titles = (forest: Forest) =>
  listPages(forest)
    .map((p) => `${p.title}@${p.home}${p.parentId ? `<${getPage(forest, p.parentId)?.title}` : ''}`)
    .sort();

describe('Forest', () => {
  it('lists the pages of every tree, and writes go to the page’s own tree', () => {
    const team = tree('team', 'teamspace', 'edit');
    const mine = tree('mine', 'private');
    const forest = new Forest([team, mine]);
    expect(forest.primary).toBe(mine);

    const plan = createPage(forest, { title: 'Plan', tree: team.info.id });
    const diary = createPage(forest, { title: 'Diary' });
    const day = createPage(forest, { title: 'Day 1', parentId: diary });
    expect(forest.treeOf(plan)).toBe(team);
    expect(forest.treeOf(diary)).toBe(mine);
    expect(forest.treeOf(day)).toBe(mine);
    expect(listPages(team.doc).map((p) => p.title)).toEqual(['Plan']);

    setPageTitle(forest, plan, 'Gear plan');
    expect(getPage(team.doc, plan)?.title).toBe('Gear plan');
    expect(getPage(forest, plan)).toMatchObject({ tree: 'tree:team', home: 'tree:team' });
    expect(getAncestorIds(forest, day)).toEqual([diary]);
    expect(getDescendantIds(forest, diary)).toEqual([day]);

    trashPage(forest, diary);
    expect(isInTrash(forest, day)).toBe(true);
    expect(deletePagePermanently(forest, diary).sort()).toEqual([diary, day].sort());
    expect(listPages(mine.doc)).toEqual([]);
  });

  it('shows a shared page in its stub’s place, or on its own without the stub’s tree', () => {
    const team = tree('team', 'teamspace');
    const shared = tree('spec', 'shared');
    const forest = new Forest([team, shared]);
    const parent = createPage(forest, { title: 'Projects', tree: team.info.id });
    const spec = createPage(forest, { title: 'Spec', parentId: parent });
    createPage(forest, { title: 'Appendix', parentId: spec });
    moveSubtree(team.doc, shared.doc, spec, { stubScope: 'spec' });

    expect(titles(forest)).toEqual([
      'Appendix@tree:spec<Spec',
      'Projects@tree:team',
      'Spec@tree:team<Projects',
    ]);
    expect(getPage(forest, spec)).toMatchObject({ tree: 'tree:spec', home: 'tree:team' });

    // Someone with only the shared scope: the page at the top, its sub-page under it.
    const guest = new Forest([shared]);
    expect(titles(guest)).toEqual(['Appendix@tree:spec<Spec', 'Spec@tree:spec']);
    expect(getAncestorIds(guest, spec)).toEqual([]);
    guest.destroy();
  });

  it('moves within a tree (a stub moves in its own tree), and refuses moves across', () => {
    const team = tree('team', 'teamspace');
    const mine = tree('mine', 'private');
    const shared = tree('spec', 'shared');
    const forest = new Forest([team, mine, shared]);
    const a = createPage(forest, { title: 'A', tree: team.info.id });
    const b = createPage(forest, { title: 'B', tree: team.info.id });
    const spec = createPage(forest, { title: 'Spec', tree: team.info.id });
    moveSubtree(team.doc, shared.doc, spec, { stubScope: 'spec' });
    const diary = createPage(forest, { title: 'Diary' });

    movePage(forest, b, { parentId: a });
    expect(getPage(forest, b)?.parentId).toBe(a);
    // The shared page shows in the team tree: moving it there moves its stub.
    movePage(forest, spec, { parentId: a, index: 0 });
    expect(getPage(forest, spec)).toMatchObject({ parentId: a, home: 'tree:team' });
    expect(getPage(shared.doc, spec)?.parentId).toBe(null);

    expect(() => movePage(forest, diary, { parentId: a })).toThrow(ScopeMoveError);
    try {
      movePage(forest, b, { parentId: null, tree: mine.info.id });
    } catch (error) {
      expect(error).toMatchObject({ pageId: b, from: 'tree:team', to: 'tree:mine' });
    }
    // A sub-page of the shared page belongs to the shared scope.
    expect(() => movePage(forest, b, { parentId: spec })).toThrow(ScopeMoveError);
  });

  it('duplicates in place, and tells listeners about changes in any tree', () => {
    const team = tree('team', 'teamspace');
    const forest = new Forest([localTree(new Y.Doc()), team]);
    let heard = 0;
    forest.on('update', () => heard++);
    const plan = createPage(forest, { title: 'Plan', tree: team.info.id });
    createPage(forest, { title: 'Step', parentId: plan });
    expect(heard).toBeGreaterThan(0);
    const copies = duplicatePageTree(forest, plan);
    expect(
      listPages(team.doc)
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Plan', 'Plan (1)', 'Step', 'Step']);
    expect(copies.size).toBe(2);

    heard = 0;
    forest.set([team]);
    expect(heard).toBe(1);
    expect(forest.primary).toBe(team);
    forest.set([]);
    expect(forest.primary).toBeUndefined();
    expect(roleAllows('comment', 'view')).toBe(true);
    expect(roleAllows('comment', 'edit')).toBe(false);
  });
});
