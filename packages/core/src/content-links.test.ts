import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { blockTexts, getPageContent, pageUrl, readLinks, replacePageContent } from './index';

const block = (type: string, id: string, ...children: (Y.XmlText | Y.XmlElement)[]) => {
  const el = new Y.XmlElement(type);
  el.setAttribute('id', id);
  el.insert(0, children);
  return el;
};
const text = (s: string, link?: string) => {
  const t = new Y.XmlText();
  t.insert(0, s, link ? { link: { href: link } } : {});
  return t;
};
const node = (type: string, attrs: Record<string, string>) => {
  const el = new Y.XmlElement(type);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';

describe('readLinks', () => {
  it('finds mentions, links, link-to-page blocks, synced blocks and linked views', () => {
    const doc = new Y.Doc();
    getPageContent(doc).insert(0, [
      block(
        'paragraph',
        'b1',
        text('See '),
        node('mention', { kind: 'page', pageId: P1 }),
        text(' for torque'),
      ),
      block(
        'paragraph',
        'b2',
        text('Spec', pageUrl(P2, 'x1')),
        text(' and '),
        node('mention', { kind: 'date', date: '2026-10-06' }),
      ),
      node('pageLink', { id: 'b3', pageId: P1 }),
      node('syncedBlock', { id: 'b4', syncedId: 's1' }),
      node('linkedDatabase', { id: 'b5', databaseId: 'db1', viewSet: 'v' }),
      block('paragraph', 'b6', text('ordinary', 'https://example.com')),
      block(
        'bulletList',
        'b7',
        block(
          'listItem',
          'b8',
          block('paragraph', 'b9', node('mention', { kind: 'page', pageId: P2 })),
        ),
      ),
    ]);
    expect(readLinks(doc)).toEqual([
      { target: P1, kind: 'mention', blockId: 'b1', snippet: 'See @ for torque' },
      { target: P2, kind: 'link', blockId: 'b2', snippet: 'Spec and @' },
      { target: P1, kind: 'pageLink', blockId: 'b3', snippet: '' },
      { target: 's1', kind: 'synced', blockId: 'b4', snippet: '' },
      { target: 'db1', kind: 'linkedDatabase', blockId: 'b5', snippet: '' },
      { target: P2, kind: 'mention', blockId: 'b9', snippet: '@' },
    ]);
  });

  it('replacePageContent swaps content and keeps block ids', () => {
    const from = new Y.Doc();
    getPageContent(from).insert(0, [block('paragraph', 'a', text('old'))]);
    const to = new Y.Doc();
    getPageContent(to).insert(0, [
      block('paragraph', 'b', text('new')),
      block('paragraph', 'c', text('more')),
    ]);
    replacePageContent(to, from);
    expect([...blockTexts(to)]).toEqual([['a', 'paragraph\u0000old']]);
    // The source is untouched.
    expect(getPageContent(from).length).toBe(1);
  });
});
