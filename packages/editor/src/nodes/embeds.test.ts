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
    [
      'https://www.google.com/maps/place/Eiffel+Tower/@48.85,2.29,17z',
      'https://www.google.com/maps?q=Eiffel%20Tower&output=embed',
    ],
    [
      'https://docs.google.com/document/d/1AbC-dEf/edit?usp=sharing',
      'https://docs.google.com/document/d/1AbC-dEf/preview',
    ],
    [
      'https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0',
      'https://docs.google.com/spreadsheets/d/1AbC/preview',
    ],
    [
      'https://docs.google.com/presentation/d/1AbC/edit',
      'https://docs.google.com/presentation/d/1AbC/embed',
    ],
    [
      'https://docs.google.com/spreadsheets/d/e/2PACX-1v/pubhtml',
      'https://docs.google.com/spreadsheets/d/e/2PACX-1v/pubhtml?widget=true',
    ],
    [
      'https://docs.google.com/forms/d/e/1FAIp/viewform',
      'https://docs.google.com/forms/d/e/1FAIp/viewform?embedded=true',
    ],
    [
      'https://drive.google.com/file/d/1XyZ/view?usp=sharing',
      'https://drive.google.com/file/d/1XyZ/preview',
    ],
    ['https://gist.github.com/ada/0123abcd4567', 'https://gist.github.com/ada/0123abcd4567.pibb'],
    [
      'https://miro.com/app/board/uXjVO1=/?share_link_id=1',
      'https://miro.com/app/live-embed/uXjVO1=/',
    ],
    [
      'https://x.com/ada/status/1234567890',
      'https://platform.twitter.com/embed/Tweet.html?id=1234567890',
    ],
    [
      'https://twitter.com/ada/status/42?s=20',
      'https://platform.twitter.com/embed/Tweet.html?id=42',
    ],
    [
      'https://open.spotify.com/intl-de/track/4uLU6hMCjMI75M1A2tKUQC?si=x',
      'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC',
    ],
    [
      'https://soundcloud.com/artist/a-track?in=list',
      'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fartist%2Fa-track',
    ],
    ['https://ada.typeform.com/to/AbCd12', 'https://form.typeform.com/to/AbCd12'],
    ['https://airtable.com/appX1/shrY2', 'https://airtable.com/embed/appX1/shrY2'],
    ['https://excalidraw.com/#json=abc,def', 'https://excalidraw.com/#json=abc,def'],
  ])('%s', (input, src) => {
    expect(toEmbedUrl(input)?.src).toBe(src);
  });

  it('wraps Figma links in the Figma embed page', () => {
    const src = toEmbedUrl('https://www.figma.com/design/AbC123/Robot-UI')?.src;
    expect(src).toBe(
      'https://www.figma.com/embed?embed_host=workspace&url=https%3A%2F%2Fwww.figma.com%2Fdesign%2FAbC123%2FRobot-UI',
    );
  });

  it('shows any other https page as it is', () => {
    expect(toEmbedUrl('https://example.com/video')).toEqual({
      provider: 'Website',
      src: 'https://example.com/video',
    });
    // Not taken for a provider's page by its path.
    expect(toEmbedUrl('https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ')?.provider).toBe(
      'Website',
    );
    expect(toEmbedUrl('https://www.youtube.com/watch?v=<script>')?.provider).not.toBe('YouTube');
  });

  it('rejects unsafe URLs', () => {
    expect(toEmbedUrl('javascript:alert(1)')).toBeNull();
    expect(toEmbedUrl('not a url')).toBeNull();
    expect(toEmbedUrl('http://example.com/plain-http')).toBeNull();
    expect(toEmbedUrl('https://localhost:8080/')).toBeNull();
    expect(toEmbedUrl('https://user:secret@example.com/')).toBeNull();
    expect(toEmbedUrl('data:text/html,<p>hi</p>')).toBeNull();
  });

  it('only produces https URLs, on each provider’s origin', () => {
    for (const p of EMBED_PROVIDERS) expect(p.origin).toMatch(/^https:\/\/[a-z.-]+$/);
    expect(toEmbedUrl('https://www.google.com/maps/place/%E0%A4%A')?.provider).toBe('Website');
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
