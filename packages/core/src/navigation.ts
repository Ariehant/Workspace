import type { PageId, PageMeta } from './schema';
import { compareSiblings, deletePagePermanently, getAncestorIds, listPages } from './workspace';
import type * as Y from 'yjs';

// --- Back / forward history ----------------------------------------------------------

/** Browser-style navigation history of visited pages (immutable). */
export interface NavHistory {
  entries: readonly PageId[];
  index: number;
}

export const EMPTY_HISTORY: NavHistory = { entries: [], index: -1 };

const MAX_HISTORY = 100;

/** Visit a page: drops the forward entries, ignores re-visiting the current page. */
export function pushHistory(history: NavHistory, id: PageId): NavHistory {
  if (history.entries[history.index] === id) return history;
  const entries = [...history.entries.slice(0, history.index + 1), id].slice(-MAX_HISTORY);
  return { entries, index: entries.length - 1 };
}

/**
 * Step back (`-1`) or forward (`+1`), skipping pages that no longer exist.
 * Returns `null` when there is nowhere to go.
 */
export function stepHistory(
  history: NavHistory,
  direction: -1 | 1,
  exists: (id: PageId) => boolean,
): NavHistory | null {
  for (let i = history.index + direction; i >= 0 && i < history.entries.length; i += direction) {
    if (exists(history.entries[i]!)) return { entries: history.entries, index: i };
  }
  return null;
}

// --- Sidebar drag and drop -----------------------------------------------------------

/** Where a dragged page lands relative to the row it is dropped on. */
export type DropZone = 'before' | 'after' | 'inside';

/**
 * Turn a sidebar drop into a move: the new parent and the index among its children.
 * Returns `null` for drops that can't happen (onto itself or into its own sub-pages).
 */
export function resolveDrop(
  doc: Y.Doc,
  dragId: PageId,
  targetId: PageId,
  zone: DropZone,
): { parentId: PageId | null; index: number } | null {
  if (dragId === targetId) return null;
  if (getAncestorIds(doc, targetId).includes(dragId)) return null;
  const pages = listPages(doc);
  const target = pages.find((p) => p.id === targetId);
  if (!target) return null;

  // Same sibling list as `movePage` (trashed pages keep their slot), so indexes agree.
  const childrenOf = (parentId: PageId | null) =>
    pages.filter((p) => p.parentId === parentId && p.id !== dragId).sort(compareSiblings);

  if (zone === 'inside') return { parentId: target.id, index: childrenOf(target.id).length };
  const siblings = childrenOf(target.parentId);
  const at = siblings.findIndex((p) => p.id === targetId);
  return { parentId: target.parentId, index: zone === 'before' ? at : at + 1 };
}

// --- Trash ---------------------------------------------------------------------------

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Pages put in the trash directly (their sub-pages go with them), newest first. */
export function trashedPages(doc: Y.Doc): PageMeta[] {
  return listPages(doc)
    .filter((p) => p.trashedAt !== null)
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
}

/** Permanently delete pages trashed before `cutoff`. Returns every deleted id. */
export function emptyTrashBefore(doc: Y.Doc, cutoff: number): PageId[] {
  const deleted: PageId[] = [];
  for (const page of trashedPages(doc)) {
    if (page.trashedAt! < cutoff && !deleted.includes(page.id)) {
      deleted.push(...deletePagePermanently(doc, page.id));
    }
  }
  return deleted;
}
