import {
  Forest,
  buildPageTree,
  createPage,
  listPages,
  localTree,
  moveSubtree,
  type Tree,
  type TreeInfo,
} from '@workspace/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { buildSections } from './sections';

const tree = (id: string, kind: TreeInfo['kind'], role: TreeInfo['role'], name = id): Tree => ({
  info: { id: `tree:${id}`, scope: id, kind, name, role, parent: null },
  doc: new Y.Doc(),
});
const sectionsOf = (forest: Forest) =>
  buildSections(forest, buildPageTree(listPages(forest))).map((s) => ({
    title: s.title,
    pages: s.nodes.map((n) => n.page.title),
    addTo: s.addTo,
  }));

describe('sidebar sections', () => {
  it('a workspace that isn’t on a server: one section, as before', () => {
    const forest = new Forest([localTree(new Y.Doc())]);
    createPage(forest, { title: 'Notes' });
    expect(sectionsOf(forest)).toEqual([{ title: 'Pages', pages: ['Notes'], addTo: 'workspace' }]);
  });

  it('teamspaces by name, then pages shared with you, then your private pages', () => {
    const ops = tree('ops', 'teamspace', 'view', 'Operations');
    const eng = tree('eng', 'teamspace', 'edit', 'Engineering');
    const mine = tree('mine', 'private', 'full');
    const shared = tree('spec', 'shared', 'comment');
    const elsewhere = new Y.Doc();
    const forest = new Forest([ops, eng, mine, shared]);
    createPage(forest, { title: 'Runbook', tree: ops.info.id });
    createPage(forest, { title: 'Gear plan', tree: eng.info.id });
    createPage(forest, { title: 'Diary' });
    // A page shared from somewhere this person can't see: under "Shared".
    const spec = createPage(elsewhere, { title: 'Spec' });
    moveSubtree(elsewhere, shared.doc, spec, { stubScope: 'spec' });

    expect(sectionsOf(forest)).toEqual([
      { title: 'Engineering', pages: ['Gear plan'], addTo: 'tree:eng' },
      { title: 'Operations', pages: ['Runbook'], addTo: null },
      { title: 'Shared', pages: ['Spec'], addTo: null },
      { title: 'Private', pages: ['Diary'], addTo: 'tree:mine' },
    ]);
  });
});
