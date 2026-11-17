import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addRow,
  addRowFromTemplate,
  addTemplate,
  changePropertyType,
  deleteProperty,
  duplicateProperty,
  duplicateRow,
  initDatabase,
  readDatabase,
  richOf,
  setCell,
  setRichCell,
  spansToHtml,
  spansToMarkdown,
  type RichSpan,
} from './index';

const ctx = { users: new Map<string, string>() };
const spans: RichSpan[] = [
  { text: 'Torque ' },
  { text: '2 Nm', bold: true },
  { text: ', see ' },
  { text: 'spec', link: 'https://example.org/spec', italic: true },
];

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  const notes = addProperty(doc, { name: 'Notes', type: 'text' });
  const id = addRow(doc, { actor: null, title: 'Arm' });
  const row = () => readDatabase(doc).rows.find((r) => r.id === id)!;
  return { doc, notes, id, row };
}

describe('formatted text properties', () => {
  it('keeps the plain text as the value and the formatting beside it', () => {
    const { doc, notes, id, row } = setup();
    setRichCell(doc, id, notes, spans, null);
    expect(row().values[notes]).toBe('Torque 2 Nm, see spec');
    expect(richOf(row(), notes)).toEqual(spans);
    // Plain text needs no formatting.
    setRichCell(doc, id, notes, [{ text: 'plain' }, { text: ' words' }], null);
    expect(row().values[notes]).toBe('plain words');
    expect(row().rich?.[notes]).toBeUndefined();
    setRichCell(doc, id, notes, [], null);
    expect(row().values[notes]).toBeUndefined();
  });

  it('drops the formatting on a plain write, a type change or a deleted property', () => {
    const { doc, notes, id, row } = setup();
    setRichCell(doc, id, notes, spans, null);
    setCell(doc, id, notes, 'rewritten', null);
    expect(richOf(row(), notes)).toEqual([{ text: 'rewritten' }]);
    expect(row().rich?.[notes]).toBeUndefined();

    setRichCell(doc, id, notes, spans, null);
    changePropertyType(doc, notes, 'url', ctx);
    expect(row().rich?.[notes]).toBeUndefined();

    const other = addProperty(doc, { name: 'More', type: 'text' });
    setRichCell(doc, id, other, spans, null);
    deleteProperty(doc, other);
    expect(row().rich?.[other]).toBeUndefined();
  });

  it('ignores formatting that no longer matches its value', () => {
    expect(
      richOf({ values: { p: 'new' }, rich: { p: [{ text: 'old', bold: true }] } }, 'p'),
    ).toEqual([{ text: 'new' }]);
  });

  it('copies the formatting with a row, a property and a template', () => {
    const { doc, notes, id, row } = setup();
    setRichCell(doc, id, notes, spans, null);
    const copy = duplicateRow(doc, id, null);
    const db = () => readDatabase(doc);
    expect(
      richOf(
        db().rows.find((r) => r.id === copy)!,
        notes,
      ),
    ).toEqual(spans);
    const second = duplicateProperty(doc, notes);
    expect(richOf(row(), second)).toEqual(spans);

    const template = addTemplate(doc, { actor: null, title: 'Spec' });
    setRichCell(doc, template, notes, spans, null);
    const made = addRowFromTemplate(doc, template, { actor: null });
    expect(
      richOf(
        db().rows.find((r) => r.id === made)!,
        notes,
      ),
    ).toEqual(spans);
  });

  it('writes Markdown and HTML', () => {
    expect(spansToMarkdown(spans)).toBe('Torque **2 Nm**, see [*spec*](https://example.org/spec)');
    expect(
      spansToMarkdown([
        { text: 'a*b ', bold: true },
        { text: 'x', code: true },
      ]),
    ).toBe('**a\\*b** `x`');
    expect(spansToHtml([...spans, { text: '<red>', color: 'red_background', strike: true }])).toBe(
      'Torque <strong>2 Nm</strong>, see <a href="https://example.org/spec"><em>spec</em></a>' +
        '<span class="bg-red"><s>&lt;red&gt;</s></span>',
    );
    // Only safe links.
    expect(spansToHtml([{ text: 'x', link: 'javascript:alert(1)' }])).toBe('x');
  });
});
