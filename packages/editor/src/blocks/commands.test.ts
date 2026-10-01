import { describe, expect, it } from 'vitest';
import { withoutBlockIds } from './commands';

describe('withoutBlockIds', () => {
  it('clears ids at every depth and keeps other attributes', () => {
    const json = {
      type: 'bulletList',
      attrs: { id: 'a' },
      content: [
        {
          type: 'listItem',
          attrs: { id: 'b' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'c', textAlign: 'left' },
              content: [{ type: 'text', text: 'x' }],
            },
          ],
        },
      ],
    };
    expect(withoutBlockIds(json)).toEqual({
      type: 'bulletList',
      attrs: { id: null },
      content: [
        {
          type: 'listItem',
          attrs: { id: null },
          content: [
            {
              type: 'paragraph',
              attrs: { id: null, textAlign: 'left' },
              content: [{ type: 'text', text: 'x' }],
            },
          ],
        },
      ],
    });
  });
});
