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
