/** Metadata shown on a web bookmark card. */
export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  /** Absolute URL of a preview image, if the page declares one. */
  image: string | null;
  /** Absolute URL of the site icon. */
  icon: string | null;
  siteName: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] === '#') {
        const code =
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1]!.toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function absolute(href: string | undefined, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Pull title, description, image and icon out of a page's `<head>`, preferring
 * Open Graph and Twitter card tags, like Notion's bookmark block.
 */
export function parseLinkPreview(html: string, url: string): LinkPreview {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd >= 0 ? html.slice(0, headEnd) : html;
  const meta = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content !== undefined && !meta.has(key)) meta.set(key, a.content);
  }
  let icon: string | undefined;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('icon') || rel.includes('apple-touch-icon')) {
      icon ??= a.href;
      if (rel.includes('apple-touch-icon')) icon = a.href;
    }
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const host = new URL(url).hostname;

  return {
    url,
    title:
      meta.get('og:title') ||
      meta.get('twitter:title') ||
      (titleTag ? decode(titleTag) : '') ||
      host,
    description:
      meta.get('og:description') ??
      meta.get('twitter:description') ??
      meta.get('description') ??
      '',
    image: absolute(meta.get('og:image') ?? meta.get('twitter:image'), url),
    icon: absolute(icon ?? '/favicon.ico', url),
    siteName: meta.get('og:site_name') ?? null,
  };
}
