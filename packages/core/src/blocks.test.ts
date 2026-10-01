import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { getPageContent, pageText, readBlocks } from './index';

function paragraph(text: string): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
}

describe('blocks', () => {
  it('reads the editor XML tree as blocks', () => {
    const doc = new Y.Doc();
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 1 as unknown as string);
    heading.insert(0, [new Y.XmlText('Title')]);
    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [paragraph('first')]);
    list.insert(0, [item]);
    getPageContent(doc).insert(0, [heading, paragraph('Body'), list]);

    expect(readBlocks(doc)).toEqual([
      { type: 'heading', props: { level: 1 }, text: 'Title', children: [] },
      { type: 'paragraph', props: {}, text: 'Body', children: [] },
      {
        type: 'bulletList',
        props: {},
        text: '',
        children: [
          {
            type: 'listItem',
            props: {},
            text: '',
            children: [{ type: 'paragraph', props: {}, text: 'first', children: [] }],
          },
        ],
      },
    ]);
    expect(pageText(doc)).toBe('Title\nBody\nfirst');
  });

  it('ignores formatting when extracting text', () => {
    const doc = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'plain ');
    text.insert(6, 'bold', { bold: {} });
    p.insert(0, [text]);
    getPageContent(doc).insert(0, [p]);
    expect(pageText(doc)).toBe('plain bold');
  });
});
