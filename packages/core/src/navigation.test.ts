import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  EMPTY_HISTORY,
  type TabsState,
  closeTab,
  cycleTab,
  moveTab,
  openTab,
  parseTabs,
  tabsWith,
  updateActiveTab,
  buildPageTree,
  createPage,
  emptyTrashBefore,
  listPages,
  movePage,
  pushHistory,
  resolveDrop,
  stepHistory,
  trashPage,
  trashedPages,
  type PageTreeNode,
} from './index';

const titles = (nodes: PageTreeNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.page.title, titles(n.children)] : n.page.title));

describe('navigation history', () => {
  it('goes back and forward and truncates forward entries on a new visit', () => {
    let h = pushHistory(pushHistory(pushHistory(EMPTY_HISTORY, 'a'), 'b'), 'c');
    expect(pushHistory(h, 'c')).toBe(h); // re-visiting the current page is a no-op
    h = stepHistory(h, -1, () => true)!;
    expect(h.entries[h.index]).toBe('b');
    h = pushHistory(h, 'd');
    expect(h.entries).toEqual(['a', 'b', 'd']);
    expect(stepHistory(h, 1, () => true)).toBeNull();
  });

  it('skips pages that were deleted', () => {
    const h = pushHistory(pushHistory(pushHistory(EMPTY_HISTORY, 'a'), 'gone'), 'c');
    const back = stepHistory(h, -1, (id) => id !== 'gone')!;
    expect(back.entries[back.index]).toBe('a');
    expect(stepHistory(back, -1, () => true)).toBeNull();
  });
});

describe('resolveDrop', () => {
  function setup() {
    const doc = new Y.Doc();
    const a = createPage(doc, { title: 'A' });
    const a1 = createPage(doc, { title: 'A1', parentId: a });
    const b = createPage(doc, { title: 'B' });
    const c = createPage(doc, { title: 'C' });
    return { doc, a, a1, b, c };
  }
  const apply = (doc: Y.Doc, id: string, target: ReturnType<typeof resolveDrop>) => {
    movePage(doc, id, target!);
    return titles(buildPageTree(listPages(doc)));
  };

  it('reorders before and after siblings', () => {
    const { doc, a, c } = setup();
    expect(apply(doc, c, resolveDrop(doc, c, a, 'before'))).toEqual(['C', ['A', ['A1']], 'B']);
    expect(apply(doc, c, resolveDrop(doc, c, a, 'after'))).toEqual([['A', ['A1']], 'C', 'B']);
  });

  it('nests inside a page, at the end of its children', () => {
    const { doc, a, b } = setup();
    expect(apply(doc, b, resolveDrop(doc, b, a, 'inside'))).toEqual([['A', ['A1', 'B']], 'C']);
  });

  it('un-nests by dropping beside a top-level page', () => {
    const { doc, a1, c } = setup();
    expect(apply(doc, a1, resolveDrop(doc, a1, c, 'after'))).toEqual(['A', 'B', 'C', 'A1']);
  });

  it('refuses drops onto itself or into its own sub-pages', () => {
    const { doc, a, a1 } = setup();
    expect(resolveDrop(doc, a, a, 'inside')).toBeNull();
    expect(resolveDrop(doc, a, a1, 'inside')).toBeNull();
    expect(resolveDrop(doc, a, a1, 'before')).toBeNull();
  });
});

describe('trash', () => {
  it('lists trashed pages newest first and empties old ones with their sub-pages', () => {
    const doc = new Y.Doc();
    const old = createPage(doc, { title: 'Old' });
    createPage(doc, { title: 'Old child', parentId: old });
    const recent = createPage(doc, { title: 'Recent' });
    createPage(doc, { title: 'Kept' });
    trashPage(doc, old, 1_000);
    trashPage(doc, recent, 5_000);

    expect(trashedPages(doc).map((p) => p.title)).toEqual(['Recent', 'Old']);
    expect(emptyTrashBefore(doc, 2_000)).toHaveLength(2);
    expect(
      listPages(doc)
        .map((p) => p.title)
        .sort(),
    ).toEqual(['Kept', 'Recent']);
  });
});

describe('tabs', () => {
  const pages = (s: TabsState) => s.tabs.map((t) => t.history.entries[t.history.index] ?? null);

  it('opens a tab after the active one, in front or in the background', () => {
    let s = tabsWith('a');
    s = openTab(s, 'b');
    expect(pages(s)).toEqual(['a', 'b']);
    expect(s.active).toBe(1);
    s = { ...s, active: 0 };
    s = openTab(s, 'c', { background: true });
    expect(pages(s)).toEqual(['a', 'c', 'b']);
    expect(s.active).toBe(0);
  });

  it('navigates inside the active tab only', () => {
    let s = openTab(tabsWith('a'), 'b');
    s = updateActiveTab(s, (h) => pushHistory(h, 'c'));
    expect(pages(s)).toEqual(['a', 'c']);
    expect(s.tabs[1]!.history.entries).toEqual(['b', 'c']);
    expect(updateActiveTab(s, (h) => h)).toBe(s);
  });

  it('closes tabs: the right neighbour becomes active, the last tab stays', () => {
    let s = openTab(openTab(tabsWith('a'), 'b'), 'c');
    s = { ...s, active: 1 };
    s = closeTab(s, 1);
    expect(pages(s)).toEqual(['a', 'c']);
    expect(s.active).toBe(1);
    s = closeTab(s, 1);
    expect(pages(s)).toEqual(['a']);
    expect(s.active).toBe(0);
    expect(closeTab(s, 0)).toBe(s);
  });

  it('closing a tab left of the active one keeps the same tab active', () => {
    const s = openTab(openTab(tabsWith('a'), 'b'), 'c');
    const closed = closeTab(s, 0);
    expect(pages(closed)).toEqual(['b', 'c']);
    expect(closed.active).toBe(1);
  });

  it('moves tabs and cycles through them', () => {
    let s = openTab(openTab(tabsWith('a'), 'b'), 'c');
    s = { ...s, active: 0 };
    s = moveTab(s, 0, 2);
    expect(pages(s)).toEqual(['b', 'c', 'a']);
    expect(s.active).toBe(2);
    expect(cycleTab(s, 1).active).toBe(0);
    expect(cycleTab({ ...s, active: 0 }, -1).active).toBe(2);
  });

  it('reads tabs back from settings, dropping malformed ones', () => {
    const s = parseTabs({
      tabs: [{ history: { entries: ['a', 'b'], index: 9 } }, null, { history: 'x' }],
      active: 4,
    });
    expect(s?.tabs).toHaveLength(1);
    expect(s?.tabs[0]!.history).toEqual({ entries: ['a', 'b'], index: 1 });
    expect(s?.active).toBe(0);
    expect(parseTabs({ tabs: [] })).toBeNull();
    expect(parseTabs('nope')).toBeNull();
  });
});
