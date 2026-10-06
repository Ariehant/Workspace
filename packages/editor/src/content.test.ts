import { readBlocks } from '@workspace/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { appendContent } from './content';

describe('appendContent', () => {
  it('writes Markdown and JSON blocks with ids', () => {
    const doc = new Y.Doc();
    appendContent(doc, [
      '# Agenda\n\n- Status\n- Risks\n\n- [ ] Send notes\n\n> Decisions go here',
      { type: 'horizontalRule' },
    ]);
    appendContent(doc, ['Last line with **bold**']);
    const blocks = readBlocks(doc);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'bulletList',
      expect.any(String),
      expect.any(String),
      'horizontalRule',
      'paragraph',
    ]);
    expect(blocks[0]!.text).toBe('Agenda');
    expect(blocks[0]!.props.id).toEqual(expect.any(String));
    expect(blocks[5]!.text).toBe('Last line with bold');
  });
});
