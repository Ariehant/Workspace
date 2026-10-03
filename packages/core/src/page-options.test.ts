import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  buildPageTree,
  copyPageContent,
  countWords,
  createPage,
  duplicatePageTree,
  getPage,
  getPageContent,
  listPages,
  setPageOptions,
  type PageTreeNode,
} from './index';

const titles = (nodes: PageTreeNode[]): unknown[] =>
  nodes.map((n) => (n.children.length ? [n.page.title, titles(n.children)] : n.page.title));

describe('page options', () => {
  it('default for pages created before they existed', () => {
    const doc = new Y.Doc();
    const id = createPage(doc, { title: 'Old' });
    expect(getPage(doc, id)).toMatchObject({
      cover: null,
      fullWidth: false,
      smallText: false,
      font: 'default',
      locked: false,
    });
  });

  it('are stored and merge like other fields', () => {
    const doc = new Y.Doc();
    const id = createPage(doc, { title: 'P' });
    setPageOptions(doc, id, {
      fullWidth: true,
      font: 'serif',
      cover: { kind: 'gradient', value: 'sunset', positionY: 40 },
    });
    setPageOptions(doc, id, { locked: true });
    expect(getPage(doc, id)).toMatchObject({
      fullWidth: true,
      font: 'serif',
      locked: true,
      cover: { kind: 'gradient', value: 'sunset', positionY: 40 },
    });
  });
});

describe('duplicatePageTree', () => {
  it('copies a page and its sub-pages right after the original', () => {
    const doc = new Y.Doc();
    const a = createPage(doc, { title: 'A', icon: '🤖' });
    createPage(doc, { title: 'A1', parentId: a });
    createPage(doc, { title: 'A2', parentId: a });
    createPage(doc, { title: 'B' });
    setPageOptions(doc, a, { smallText: true });

    const mapping = duplicatePageTree(doc, a);
    expect(mapping.size).toBe(3);
    expect(titles(buildPageTree(listPages(doc)))).toEqual([
      ['A', ['A1', 'A2']],
      ['A (1)', ['A1', 'A2']],
      'B',
    ]);
    expect(getPage(doc, mapping.get(a)!)).toMatchObject({ icon: '🤖', smallText: true });
  });
});

describe('copyPageContent', () => {
  it('copies blocks with fresh ids and remaps links to duplicated pages', () => {
    const from = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    p.setAttribute('id', 'b1');
    const mention = new Y.XmlElement('mention');
    mention.setAttribute('pageId', 'child-old');
    p.insert(0, [new Y.XmlText('See '), mention]);
    const link = new Y.XmlElement('pageLink');
    link.setAttribute('id', 'b2');
    link.setAttribute('pageId', 'elsewhere');
    getPageContent(from).insert(0, [p, link]);

    const to = new Y.Doc();
    copyPageContent(from, to, new Map([['child-old', 'child-new']]));
    const [cp, cl] = getPageContent(to).toArray() as Y.XmlElement[];
    expect(cp!.getAttribute('id')).not.toBe('b1');
    expect((cp!.toArray()[1] as Y.XmlElement).getAttribute('pageId')).toBe('child-new');
    expect(cl!.getAttribute('pageId')).toBe('elsewhere');
    expect(cl!.getAttribute('id')).not.toBe('b2');
    // The original is untouched.
    expect(p.getAttribute('id')).toBe('b1');
  });
});

describe('countWords', () => {
  it('counts words like Notion', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('The robot arm moves.')).toBe(4);
    expect(countWords("don't stop — it's 3.5 V")).toBe(5);
    expect(countWords('ロボット arm')).toBe(5);
  });
});
