import * as Y from 'yjs';
import { getPageContent } from './blocks';
import type { PageId } from './schema';

/** Scheme of in-app links: `workspace://page/<pageId>#<blockId>`. */
export const LINK_SCHEME = 'workspace';

export interface PageLinkTarget {
  pageId: PageId;
  /** Block to scroll to, from the URL fragment. */
  blockId: string | null;
}

const ID = /^[0-9a-f-]{8,64}$/i;

export function pageUrl(pageId: PageId, blockId?: string | null): string {
  return `${LINK_SCHEME}://page/${pageId}${blockId ? `#${blockId}` : ''}`;
}

/** Parse a `workspace://page/…` link; `null` for anything else. */
export function parsePageUrl(url: string): PageLinkTarget | null {
  const m = /^workspace:\/\/page\/([^/?#]+)\/?(?:#(.+))?$/i.exec(url.trim());
  if (!m || !ID.test(m[1]!)) return null;
  const blockId = m[2] && ID.test(m[2]) ? m[2] : null;
  return { pageId: m[1]!, blockId };
}

/** How a page refers to another page (or a synced block's content). */
export type LinkKind = 'mention' | 'link' | 'pageLink' | 'synced' | 'linkedDatabase' | 'relation';

/** One reference found in a page's content. */
export interface ContentLink {
  target: string;
  kind: LinkKind;
  /** The block it sits in, to scroll to. */
  blockId: string | null;
  /** Text of that block, for the backlink snippet. */
  snippet: string;
}

const ownText = (el: Y.XmlElement) =>
  el
    .toArray()
    .map((child) =>
      child instanceof Y.XmlText
        ? (child.toDelta() as { insert: unknown }[])
            .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
            .join('')
        : child instanceof Y.XmlElement && child.nodeName === 'mention'
          ? '@'
          : '',
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

/**
 * References in a page's content: page mentions, link-to-page blocks, `workspace://`
 * links, synced blocks and linked database views. Duplicates (same target, kind and
 * block) are kept once.
 */
export function readLinks(doc: Y.Doc): ContentLink[] {
  const links: ContentLink[] = [];
  const seen = new Set<string>();
  const add = (link: ContentLink) => {
    const key = `${link.target}\u0000${link.kind}\u0000${link.blockId}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push(link);
  };
  const walk = (el: Y.XmlElement | Y.XmlFragment, blockId: string | null, snippet: string) => {
    for (const child of el.toArray()) {
      if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as { attributes?: { link?: { href?: string } } }[]) {
          const target = op.attributes?.link?.href && parsePageUrl(op.attributes.link.href);
          if (target) add({ target: target.pageId, kind: 'link', blockId, snippet });
        }
        continue;
      }
      if (!(child instanceof Y.XmlElement)) continue;
      const attrs = child.getAttributes() as Record<string, unknown>;
      const id = typeof attrs.id === 'string' ? attrs.id : null;
      const text = id ? ownText(child) : snippet;
      const at = id ?? blockId;
      const str = (key: string) => (typeof attrs[key] === 'string' ? (attrs[key] as string) : null);
      switch (child.nodeName) {
        case 'mention': {
          const pageId = str('pageId');
          if (attrs.kind === 'page' && pageId)
            add({ target: pageId, kind: 'mention', blockId: at, snippet: text });
          break;
        }
        case 'pageLink': {
          const pageId = str('pageId');
          if (pageId) add({ target: pageId, kind: 'pageLink', blockId: at, snippet: text });
          break;
        }
        case 'syncedBlock': {
          const syncedId = str('syncedId');
          if (syncedId) add({ target: syncedId, kind: 'synced', blockId: at, snippet: text });
          break;
        }
        case 'linkedDatabase': {
          const databaseId = str('databaseId');
          if (databaseId)
            add({ target: databaseId, kind: 'linkedDatabase', blockId: at, snippet: text });
          break;
        }
      }
      walk(child, at, text);
    }
  };
  walk(getPageContent(doc), null, '');
  return links;
}
