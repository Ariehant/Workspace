import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  formatMathMacros,
  getMathMacros,
  observeMathMacros,
  parseMathMacros,
  setMathMacros,
} from './math';

describe('math macros', () => {
  it('parses one macro per line in several spellings', () => {
    const { macros, invalid } = parseMathMacros(
      '\\R \\mathbb{R}\n\n% vectors\n\\vec = \\mathbf{#1}\n\\N: \\mathbb{N}\nnot a macro',
    );
    expect(macros).toEqual({ '\\R': '\\mathbb{R}', '\\vec': '\\mathbf{#1}', '\\N': '\\mathbb{N}' });
    expect(invalid).toEqual([6]);
    expect(parseMathMacros(formatMathMacros(macros)).macros).toEqual(macros);
  });

  it('are stored in the workspace doc and observed', () => {
    const doc = new Y.Doc();
    expect(getMathMacros(doc)).toEqual({});
    let calls = 0;
    const stop = observeMathMacros(doc, () => calls++);
    setMathMacros(doc, { '\\R': '\\mathbb{R}' });
    expect(getMathMacros(doc)).toEqual({ '\\R': '\\mathbb{R}' });
    expect(calls).toBe(1);
    stop();
  });
});
