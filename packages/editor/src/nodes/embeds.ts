/** A provider we can embed: page URLs are turned into the provider's embed URL. */
export interface EmbedProvider {
  name: string;
  /** Origin the iframe loads from; the app's CSP frame-src must allow it. */
  origin: string;
  toEmbed(url: URL): string | null;
}

const YOUTUBE_ID = /^[\w-]{6,20}$/;

export const EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    name: 'YouTube',
    origin: 'https://www.youtube-nocookie.com',
    toEmbed(url) {
      const host = url.hostname.replace(/^(www|m)\./, '');
      let id: string | null = null;
      if (host === 'youtu.be') id = url.pathname.slice(1);
      else if (host === 'youtube.com') {
        if (url.pathname === '/watch') id = url.searchParams.get('v');
        else id = /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? null;
      }
      return id && YOUTUBE_ID.test(id) ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    },
  },
  {
    name: 'Vimeo',
    origin: 'https://player.vimeo.com',
    toEmbed(url) {
      const id = /^\/(\d+)/.exec(url.pathname)?.[1];
      return url.hostname.replace(/^www\./, '') === 'vimeo.com' && id
        ? `https://player.vimeo.com/video/${id}`
        : null;
    },
  },
  {
    name: 'Loom',
    origin: 'https://www.loom.com',
    toEmbed(url) {
      const id = /^\/share\/([\w-]+)/.exec(url.pathname)?.[1];
      return url.hostname.replace(/^www\./, '') === 'loom.com' && id
        ? `https://www.loom.com/embed/${id}`
        : null;
    },
  },
  {
    name: 'Figma',
    origin: 'https://www.figma.com',
    toEmbed(url) {
      return url.hostname.replace(/^www\./, '') === 'figma.com' &&
        /^\/(file|design|proto|board)\//.test(url.pathname)
        ? `https://www.figma.com/embed?embed_host=workspace&url=${encodeURIComponent(url.href)}`
        : null;
    },
  },
  {
    name: 'CodePen',
    origin: 'https://codepen.io',
    toEmbed(url) {
      const m = /^\/([\w-]+)\/pen\/(\w+)/.exec(url.pathname);
      return url.hostname === 'codepen.io' && m
        ? `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`
        : null;
    },
  },
  {
    name: 'Google Maps',
    origin: 'https://www.google.com',
    toEmbed(url) {
      return /(^|\.)google\.[a-z.]+$/.test(url.hostname) && url.pathname.startsWith('/maps/embed')
        ? url.href
        : null;
    },
  },
];

/** The embeddable URL for a page, or `null` if no provider supports it. */
export function toEmbedUrl(raw: string): { provider: string; src: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  for (const provider of EMBED_PROVIDERS) {
    const src = provider.toEmbed(url);
    if (src) return { provider: provider.name, src };
  }
  return null;
}

/** A bare http(s) URL, as pasted on its own. */
export function isUrl(text: string): boolean {
  if (!/^https?:\/\/\S+$/i.test(text)) return false;
  try {
    new URL(text);
    return true;
  } catch {
    return false;
  }
}
