import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { Column, ColumnList, normalizeColumnsIn } from './columns';

const schema = getSchema([StarterKit, ColumnList, Column]);
const p = (text?: string) => schema.node('paragraph', null, text ? [schema.text(text)] : []);
const col = (...blocks: ReturnType<typeof p>[]) => schema.node('column', null, blocks);
const list = (...cols: ReturnType<typeof col>[]) => schema.node('columnList', null, cols);
const doc = (...blocks: ReturnType<typeof p>[]) => schema.node('doc', null, blocks);

function normalize(input: ReturnType<typeof doc>, afterDrop: boolean) {
  const state = EditorState.create({ schema, doc: input });
  const tr = state.tr;
  normalizeColumnsIn(state.doc, tr, schema, afterDrop);
  return tr.doc.toJSON();
}

describe('normalizeColumnsIn', () => {
  it('leaves well-formed column lists alone', () => {
    const input = doc(list(col(p('a')), col(p())));
    expect(normalize(input, false)).toEqual(input.toJSON());
  });

  it('unwraps a list left with one column', () => {
    expect(normalize(doc(p('x'), list(col(p('a'), p('b')))), false)).toEqual(
      doc(p('x'), p('a'), p('b')).toJSON(),
    );
  });

  it('drops emptied columns after a drag, then unwraps', () => {
    expect(normalize(doc(list(col(p('a')), col(p()), col(p('c')))), true)).toEqual(
      doc(list(col(p('a')), col(p('c')))).toJSON(),
    );
    expect(normalize(doc(list(col(p()), col(p('b')))), true)).toEqual(doc(p('b')).toJSON());
  });

  it('keeps freshly inserted empty columns when nothing was dropped', () => {
    const input = doc(list(col(p()), col(p()), col(p())));
    expect(normalize(input, false)).toEqual(input.toJSON());
    expect(normalize(input, true)).toEqual(input.toJSON());
  });
});
