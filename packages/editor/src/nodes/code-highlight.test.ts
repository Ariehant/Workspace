import { getSchema } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { codeHighlightKey, codeHighlightPlugin, touchedNodes } from './code-highlight';

const schema = getSchema([StarterKit]);
const p = (text: string) => schema.node('paragraph', null, [schema.text(text)]);
const code = (text: string, language = 'javascript') =>
  schema.node('codeBlock', { language }, [schema.text(text)]);
const doc = (...blocks: PMNode[]) => schema.node('doc', null, blocks);

const decorations = (state: EditorState) => codeHighlightKey.getState(state) as DecorationSet;
const classes = (state: EditorState) =>
  decorations(state)
    .find()
    .map((d) => d.spec);

describe('code highlighting', () => {
  const start = () =>
    EditorState.create({
      schema,
      doc: doc(p('intro'), code('const a = 1;'), p('outro')),
      plugins: [codeHighlightPlugin('codeBlock', 'plaintext')],
    });

  it('highlights code blocks', () => {
    expect(decorations(start()).find().length).toBeGreaterThan(0);
  });

  it('maps the decorations when text outside code changes, without re-highlighting', () => {
    const state = start();
    const before = decorations(state).find();
    const tr = state.tr.insertText('!', 2);
    expect(touchedNodes(tr, 'codeBlock')).toEqual([]);
    const after = decorations(state.apply(tr)).find();
    expect(after.map((d) => d.from)).toEqual(before.map((d) => d.from + 1));
    expect(classes(state.apply(tr))).toEqual(classes(state));
  });

  it('highlights a code block again when it changes', () => {
    const state = start();
    const inCode = state.doc.child(0).nodeSize + 1;
    const tr = state.tr.insertText('let b = "x"; ', inCode);
    expect(touchedNodes(tr, 'codeBlock').map((n) => n.node.textContent)).toEqual([
      'let b = "x"; const a = 1;',
    ]);
    const next = state.apply(tr);
    const strings = decorations(next)
      .find()
      .filter((d) => next.doc.textBetween(d.from, d.to) === '"x"');
    expect(strings).toHaveLength(1);
  });

  it('keeps the same decorations for selection-only transactions', () => {
    const state = start();
    const next = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(decorations(next)).toBe(decorations(state));
  });
});
