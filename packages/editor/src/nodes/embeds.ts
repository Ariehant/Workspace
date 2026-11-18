/** A provider we can embed: page URLs are turned into the provider's embed URL. */
export interface EmbedProvider {
  name: string;
  /** Origin the iframe loads from (any https origin may be framed: see `WEBSITE`). */
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
      if (!/(^|\.)google\.[a-z.]+$/.test(url.hostname)) return null;
      if (url.pathname.startsWith('/maps/embed')) return url.href;
      // A place or a search: Google's embeddable map of the same query.
      const place = /^\/maps\/(?:place|search)\/([^/]+)/.exec(url.pathname)?.[1];
      return place
        ? `https://www.google.com/maps?q=${encodeURIComponent(decodeURIComponent(place).replace(/\+/g, ' '))}&output=embed`
        : null;
    },
  },
  {
    name: 'Google Docs',
    origin: 'https://docs.google.com',
    toEmbed(url) {
      if (url.hostname !== 'docs.google.com') return null;
      const m = /^\/(document|spreadsheets|presentation|forms)\/d\/(e\/)?([\w-]+)/.exec(
        url.pathname,
      );
      if (!m) return null;
      const [, kind, published, id] = m;
      const base = `https://docs.google.com/${kind}/d/${published ?? ''}${id}`;
      if (kind === 'presentation') return `${base}/embed`;
      if (kind === 'forms') return `${base}/viewform?embedded=true`;
      return published ? `${base}/pubhtml?widget=true` : `${base}/preview`;
    },
  },
  {
    name: 'Google Drive',
    origin: 'https://drive.google.com',
    toEmbed(url) {
      const id = /^\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1];
      return url.hostname === 'drive.google.com' && id
        ? `https://drive.google.com/file/d/${id}/preview`
        : null;
    },
  },
  {
    name: 'GitHub Gist',
    origin: 'https://gist.github.com',
    toEmbed(url) {
      const m = /^\/([\w-]+)\/([0-9a-f]+)\/?$/.exec(url.pathname);
      // The gist as a page of its own (`.pibb`), as GitHub offers for frames.
      return url.hostname === 'gist.github.com' && m
        ? `https://gist.github.com/${m[1]}/${m[2]}.pibb`
        : null;
    },
  },
  {
    name: 'Miro',
    origin: 'https://miro.com',
    toEmbed(url) {
      const id = /^\/app\/board\/([\w=-]+)/.exec(url.pathname)?.[1];
      return url.hostname.replace(/^www\./, '') === 'miro.com' && id
        ? `https://miro.com/app/live-embed/${id}/`
        : null;
    },
  },
  {
    name: 'X',
    origin: 'https://platform.twitter.com',
    toEmbed(url) {
      const host = url.hostname.replace(/^(www|mobile)\./, '');
      const id = /^\/[\w]+\/status\/(\d+)/.exec(url.pathname)?.[1];
      return (host === 'x.com' || host === 'twitter.com') && id
        ? `https://platform.twitter.com/embed/Tweet.html?id=${id}`
        : null;
    },
  },
  {
    name: 'Spotify',
    origin: 'https://open.spotify.com',
    toEmbed(url) {
      const m = /^\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/.exec(
        url.pathname,
      );
      return url.hostname === 'open.spotify.com' && m
        ? `https://open.spotify.com/embed/${m[1]}/${m[2]}`
        : null;
    },
  },
  {
    name: 'SoundCloud',
    origin: 'https://w.soundcloud.com',
    toEmbed(url) {
      return url.hostname.replace(/^(www|m)\./, '') === 'soundcloud.com' &&
        /^\/[\w-]+\/[\w-]+/.test(url.pathname)
        ? `https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com${url.pathname}`)}`
        : null;
    },
  },
  {
    name: 'Typeform',
    origin: 'https://form.typeform.com',
    toEmbed(url) {
      const id = /^\/to\/(\w+)/.exec(url.pathname)?.[1];
      return /(^|\.)typeform\.com$/.test(url.hostname) && id
        ? `https://form.typeform.com/to/${id}`
        : null;
    },
  },
  {
    name: 'Airtable',
    origin: 'https://airtable.com',
    toEmbed(url) {
      const m = /^\/(?:embed\/)?((?:app\w+\/)?shr\w+)/.exec(url.pathname);
      return url.hostname === 'airtable.com' && m ? `https://airtable.com/embed/${m[1]}` : null;
    },
  },
  {
    name: 'Excalidraw',
    origin: 'https://excalidraw.com',
    toEmbed(url) {
      return url.hostname === 'excalidraw.com' && /^#(json|room)=/.test(url.hash) ? url.href : null;
    },
  },
];

/**
 * Any other https page, as Notion embeds it: shown as it is, in a sandboxed frame (some sites
 * don't allow being shown in another page, and show nothing).
 */
export const WEBSITE = 'Website';

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
    let src: string | null = null;
    try {
      src = provider.toEmbed(url);
    } catch {
      // A malformed part (a bad %-escape): not this provider's link.
    }
    if (src) return { provider: provider.name, src };
  }
  // Pages only over https (an http one would be blocked inside the app's https or file page),
  // with a real host name.
  if (url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password) {
    return { provider: WEBSITE, src: url.href };
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
