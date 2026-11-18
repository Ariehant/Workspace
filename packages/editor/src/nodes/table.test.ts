import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { BlockColor } from './colors';
import { cellColor, colorTablePart } from './table';
import { Table } from './table';

const schema = getSchema([StarterKit, Table, BlockColor]);

const cell = (type: string, text: string) => ({
  type,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
// 3 × 3, with a header row; the middle cell of the first column spans two rows.
const table = {
  type: 'table',
  content: [
    { type: 'tableRow', content: ['A', 'B', 'C'].map((t) => cell('tableHeader', t)) },
    {
      type: 'tableRow',
      content: [
        { ...cell('tableCell', 'D'), attrs: { rowspan: 2 } },
        cell('tableCell', 'E'),
        cell('tableCell', 'F'),
      ],
    },
    { type: 'tableRow', content: [cell('tableCell', 'H'), cell('tableCell', 'I')] },
  ],
};

/** A state with the caret in the cell whose text is `text`. */
function caretIn(text: string, doc = schema.nodeFromJSON({ type: 'doc', content: [table] })) {
  let at = -1;
  doc.descendants((node, pos) => {
    if (node.isText && node.text === text) at = pos;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, at) });
}

/** Each cell's text and colour, row by row. */
function colours(state: EditorState) {
  const rows: string[][] = [];
  state.doc.descendants((node) => {
    if (node.type.name === 'tableRow') rows.push([]);
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      rows[rows.length - 1]!.push(`${node.textContent}:${String(node.attrs.color ?? '')}`);
      return false;
    }
    return true;
  });
  return rows;
}

function apply(state: EditorState, ...args: Parameters<typeof colorTablePart>) {
  let next = state;
  expect(colorTablePart(...args)(state, (tr) => (next = state.apply(tr)))).toBe(true);
  return next;
}

describe('simple table colours', () => {
  it('colours the row of the selection’s cell', () => {
    const state = apply(caretIn('B'), 'row', 'gray_background');
    expect(colours(state)).toEqual([
      ['A:gray_background', 'B:gray_background', 'C:gray_background'],
      ['D:', 'E:', 'F:'],
      ['H:', 'I:'],
    ]);
    expect(cellColor(state)).toBe('gray_background');
  });

  it('colours a column, merged cells included, and takes a colour off', () => {
    let state = apply(caretIn('H'), 'column', 'red');
    expect(colours(state)).toEqual([
      ['A:', 'B:red', 'C:'],
      ['D:', 'E:red', 'F:'],
      ['H:red', 'I:'],
    ]);
    // The first column holds a cell two rows tall: it's coloured once.
    state = apply(caretIn('D', state.doc), 'column', 'blue_background');
    expect(colours(state).map((row) => row[0])).toEqual([
      'A:blue_background',
      'D:blue_background',
      'H:red',
    ]);
    state = apply(caretIn('E', state.doc), 'column', null);
    expect(colours(state).map((row) => row[1])).toEqual(['B:', 'E:', 'I:']);
  });

  it('does nothing outside a table', () => {
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
    });
    const state = EditorState.create({ doc });
    expect(colorTablePart('row', 'red')(state)).toBe(false);
    expect(cellColor(state)).toBeNull();
  });
});
