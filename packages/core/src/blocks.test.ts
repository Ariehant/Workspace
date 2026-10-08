import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { firstImage, getPageContent, pageText, readBlocks, readReminders } from './index';

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

  it('exposes the editor-assigned block id in props', () => {
    const doc = new Y.Doc();
    const p = paragraph('With id');
    p.setAttribute('id', 'block-1');
    getPageContent(doc).insert(0, [p]);
    expect(readBlocks(doc)[0]?.props.id).toBe('block-1');
  });

  it('indexes the TeX source of equations', () => {
    const doc = new Y.Doc();
    const math = new Y.XmlElement('blockMath');
    math.setAttribute('latex', 'E = mc^2');
    getPageContent(doc).insert(0, [math, paragraph('after')]);
    expect(pageText(doc)).toBe('E = mc^2\nafter');
  });

  it('indexes captions, file names and bookmark titles', () => {
    const doc = new Y.Doc();
    const image = new Y.XmlElement('image');
    image.setAttribute('caption', 'Gripper close-up');
    const file = new Y.XmlElement('file');
    file.setAttribute('name', 'servo-datasheet.pdf');
    const bookmark = new Y.XmlElement('bookmark');
    bookmark.setAttribute('title', 'ROS 2 docs');
    getPageContent(doc).insert(0, [image, file, bookmark]);
    expect(pageText(doc)).toBe('Gripper close-up\nservo-datasheet.pdf\nROS 2 docs');
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

  it('finds reminder mentions with the text around them', () => {
    const doc = new Y.Doc();
    const p = new Y.XmlElement('paragraph');
    p.setAttribute('id', 'block-7');
    const reminder = new Y.XmlElement('mention');
    reminder.setAttribute('kind', 'date');
    reminder.setAttribute('date', '2026-10-05');
    reminder.setAttribute('reminder', true as unknown as string);
    const mine = new Y.XmlElement('mention');
    mine.setAttribute('kind', 'date');
    mine.setAttribute('date', '2026-10-07');
    mine.setAttribute('reminder', 'true');
    mine.setAttribute('userId', 'ada');
    const plainDate = new Y.XmlElement('mention');
    plainDate.setAttribute('kind', 'date');
    plainDate.setAttribute('date', '2026-10-06');
    p.insert(0, [new Y.XmlText('Order  servos '), reminder, plainDate, mine]);
    getPageContent(doc).insert(0, [p, paragraph('no reminders here')]);
    expect(readReminders(doc)).toEqual([
      { blockId: 'block-7', date: '2026-10-05', text: 'Order servos', userId: null },
      { blockId: 'block-7', date: '2026-10-07', text: 'Order servos', userId: 'ada' },
    ]);
  });
});

describe('firstImage', () => {
  it('finds the first image block, nested ones included', () => {
    const doc = new Y.Doc();
    expect(firstImage(doc)).toBeNull();
    const column = new Y.XmlElement('column');
    const image = new Y.XmlElement('image');
    image.setAttribute('src', 'https://example.com/a.png');
    column.insert(0, [image]);
    const later = new Y.XmlElement('image');
    later.setAttribute('fileId', 'f1');
    getPageContent(doc).insert(0, [paragraph('intro'), column, later]);
    expect(firstImage(doc)).toEqual({ src: 'https://example.com/a.png' });
  });
});
