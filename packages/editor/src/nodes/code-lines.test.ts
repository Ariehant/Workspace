import { describe, expect, it } from 'vitest';
import { indentLines, lineStarts, type LineEdit } from './code-lines';

const apply = (text: string, edits: LineEdit[]) =>
  edits.reduce((t, e) => t.slice(0, e.at) + e.insert + t.slice(e.at + e.remove), text);

describe('code block lines', () => {
  it('finds line starts', () => {
    expect(lineStarts('a\nbc\n\nd')).toEqual([0, 2, 5, 6]);
  });

  it('indents every line the selection touches', () => {
    const text = 'if x:\n  y()\nz()';
    // From inside line 1 to inside line 2.
    expect(apply(text, indentLines(text, 3, 9, false))).toBe('  if x:\n    y()\nz()');
    // A cursor indents just its line.
    expect(apply(text, indentLines(text, 13, 13, false, 4))).toBe('if x:\n  y()\n    z()');
  });

  it('leaves a line alone when the selection ends at its start', () => {
    const text = 'a\nb\nc';
    expect(apply(text, indentLines(text, 0, 4, false))).toBe('  a\n  b\nc');
  });

  it('outdents up to the indent size, or a tab', () => {
    const text = '    a\n b\nc\n\td';
    expect(apply(text, indentLines(text, 0, text.length, true))).toBe('  a\nb\nc\nd');
  });
});
