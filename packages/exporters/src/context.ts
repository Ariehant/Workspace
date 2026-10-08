import type { ContentNode } from './content';

/** What rendering a page needs from the export around it. */
export interface RenderContext {
  /**
   * A link to a page or row: its exported file (relative), else a `workspace://` URL; empty
   * for a page the reader can't open (shown as text).
   */
  pageHref(pageId: string): string;
  pageTitle(pageId: string): string;
  /** A mentioned person's name. */
  userName?(userId: string): string;
  /** A stored file, copied next to the page: its relative path, or null if it's missing. */
  fileHref(fileId: string, name: string | null): string | null;
  /** The content of a synced block. */
  synced(syncedId: string): ContentNode[];
  /** A Mermaid diagram rendered to SVG (HTML exports), if available. */
  mermaidSvg?(code: string): string | null;
}

/** `2026-10-06` → `October 6, 2026` (how Notion exports date mentions). */
export function formatDateMention(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return date;
  const d = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
