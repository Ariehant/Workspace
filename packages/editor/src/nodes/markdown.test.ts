import { describe, expect, it } from 'vitest';
import { isStructuredHtml, looksLikeMarkdown } from './markdown';

describe('markdown detection', () => {
  it('recognises common markdown', () => {
    for (const text of [
      '# Title\nbody',
      '- one\n- two',
      '1. first',
      '> quote',
      '```\ncode\n```',
      'some **bold** text',
      'see [docs](https://example.com)',
      'run `make`',
      '- [ ] task',
      '| a | b |\n|---|---|',
      '---',
    ]) {
      expect(looksLikeMarkdown(text), text).toBe(true);
    }
  });

  it('leaves ordinary prose alone', () => {
    for (const text of ['Just a sentence.', 'Price is 3 * 4 = 12', 'a-b-c', '#hashtag']) {
      expect(looksLikeMarkdown(text), text).toBe(false);
    }
  });

  it('treats styled-lines HTML (VS Code) as unstructured', () => {
    expect(isStructuredHtml('<div style="color:#fff"><span># Title</span><br></div>')).toBe(false);
    expect(isStructuredHtml('<meta charset="utf-8"><h1>Title</h1>')).toBe(true);
    expect(isStructuredHtml('<ul><li>x</li></ul>')).toBe(true);
  });
});
