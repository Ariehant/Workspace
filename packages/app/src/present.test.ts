import { describe, expect, it } from 'vitest';
import { slideCss, slideRanges, type SlideBlock } from './present';

const text: SlideBlock = { divider: false, empty: false };
const empty: SlideBlock = { divider: false, empty: true };
const hr: SlideBlock = { divider: true, empty: false };

describe('slides', () => {
  it('splits at dividers, which aren’t shown', () => {
    expect(slideRanges([text, text, hr, text, hr, text, text])).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 4 },
      { start: 5, end: 7 },
    ]);
  });

  it('keeps the title slide, and drops slides with nothing in them', () => {
    expect(slideRanges([hr, text, hr, hr, empty, hr, text, hr, empty])).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 2 },
      { start: 6, end: 7 },
    ]);
    expect(slideRanges([])).toEqual([{ start: 0, end: 0 }]);
  });

  it('hides the blocks before and after a slide', () => {
    expect(slideCss('.p', { start: 3, end: 5 })).toBe(
      '.p .ProseMirror:not(.ProseMirror .ProseMirror) > :nth-child(-n + 3),\n' +
        '.p .ProseMirror:not(.ProseMirror .ProseMirror) > :nth-child(n + 6) ' +
        '{ display: none !important; }',
    );
    expect(slideCss('.p', { start: 0, end: 2 })).toBe(
      '.p .ProseMirror:not(.ProseMirror .ProseMirror) > :nth-child(n + 3) ' +
        '{ display: none !important; }',
    );
  });
});
