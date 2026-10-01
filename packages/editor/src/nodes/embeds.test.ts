import { describe, expect, it } from 'vitest';
import { EMBED_PROVIDERS, isUrl, toEmbedUrl } from './embeds';

describe('toEmbedUrl', () => {
  it.each([
    [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ],
    ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
    [
      'https://m.youtube.com/shorts/abcDEF12345',
      'https://www.youtube-nocookie.com/embed/abcDEF12345',
    ],
    ['https://vimeo.com/76979871', 'https://player.vimeo.com/video/76979871'],
    [
      'https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184',
      'https://www.loom.com/embed/0281766fa2d04bb788eaf19e65135184',
    ],
    [
      'https://codepen.io/team/pen/abcXYZ',
      'https://codepen.io/team/embed/abcXYZ?default-tab=result',
    ],
    ['https://www.google.com/maps/embed?pb=!1m18', 'https://www.google.com/maps/embed?pb=!1m18'],
  ])('%s', (input, src) => {
    expect(toEmbedUrl(input)?.src).toBe(src);
  });

  it('wraps Figma links in the Figma embed page', () => {
    const src = toEmbedUrl('https://www.figma.com/design/AbC123/Robot-UI')?.src;
    expect(src).toBe(
      'https://www.figma.com/embed?embed_host=workspace&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbC123%2FRobot-UI',
    );
  });

  it('rejects unsupported or unsafe URLs', () => {
    expect(toEmbedUrl('https://example.com/video')).toBeNull();
    expect(toEmbedUrl('https://www.youtube.com/watch?v=<script>')).toBeNull();
    expect(toEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(toEmbedUrl('not a url')).toBeNull();
    expect(toEmbedUrl('https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ')).toBeNull();
  });

  it('only produces URLs on each provider origin (kept in sync with the CSP)', () => {
    for (const p of EMBED_PROVIDERS) expect(p.origin).toMatch(/^https:\/\/[a-z.-]+$/);
  });
});

describe('isUrl', () => {
  it('accepts bare http(s) URLs only', () => {
    expect(isUrl('https://example.com/a?b=c')).toBe(true);
    expect(isUrl('example.com')).toBe(false);
    expect(isUrl('see https://example.com')).toBe(false);
    expect(isUrl('ftp://example.com')).toBe(false);
  });
});
