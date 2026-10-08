import type { PageId, PageMeta } from './schema';
import { newId } from './ids';
import { Forest, roleAllows } from './forest';
import {
  compareSiblings,
  deletePagePermanently,
  getAncestorIds,
  listPages,
  type PageTree,
} from './workspace';

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
  doc: PageTree,
  dragId: PageId,
  targetId: PageId,
  zone: DropZone,
): { parentId: PageId | null; index: number; tree?: string } | null {
  if (dragId === targetId) return null;
  if (getAncestorIds(doc, targetId).includes(dragId)) return null;
  const pages = listPages(doc);
  const target = pages.find((p) => p.id === targetId);
  if (!target) return null;

  // Same sibling list as `movePage` (trashed pages keep their slot), so indexes agree. At
  // the top level of a forest, the siblings are those of the target's section.
  const childrenOf = (parentId: PageId | null) =>
    pages
      .filter(
        (p) =>
          p.parentId === parentId &&
          p.id !== dragId &&
          (parentId !== null || p.home === target.home),
      )
      .sort(compareSiblings);

  if (zone === 'inside') return { parentId: target.id, index: childrenOf(target.id).length };
  const siblings = childrenOf(target.parentId);
  const at = siblings.findIndex((p) => p.id === targetId);
  return {
    parentId: target.parentId,
    index: zone === 'before' ? at : at + 1,
    ...(target.parentId === null && target.home ? { tree: target.home } : {}),
  };
}

// --- Trash ---------------------------------------------------------------------------

export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Pages put in the trash directly (their sub-pages go with them), newest first. */
export function trashedPages(doc: PageTree): PageMeta[] {
  return listPages(doc)
    .filter((p) => p.trashedAt !== null)
    .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
}

/**
 * Permanently delete pages trashed before `cutoff` (in a forest, those in trees the
 * person can edit). Returns every deleted id.
 */
export function emptyTrashBefore(doc: PageTree, cutoff: number): PageId[] {
  const deleted: PageId[] = [];
  const editable = (page: PageMeta) =>
    !(doc instanceof Forest) || roleAllows(doc.get(page.tree ?? '')?.info.role, 'edit');
  for (const page of trashedPages(doc)) {
    if (!editable(page)) continue;
    if (page.trashedAt! < cutoff && !deleted.includes(page.id)) {
      deleted.push(...deletePagePermanently(doc, page.id));
    }
  }
  return deleted;
}

// --- Tabs -----------------------------------------------------------------------------

/** One tab of a window: its own back/forward history. */
export interface Tab {
  id: string;
  history: NavHistory;
}

export interface TabsState {
  tabs: readonly Tab[];
  /** Index of the active tab. */
  active: number;
}

const MAX_TABS = 30;

export function newTab(pageId: PageId | null): Tab {
  return { id: newId(), history: pageId ? pushHistory(EMPTY_HISTORY, pageId) : EMPTY_HISTORY };
}

export function tabsWith(pageId: PageId | null): TabsState {
  return { tabs: [newTab(pageId)], active: 0 };
}

/** The active tab's history, changed by `update`. */
export function updateActiveTab(
  state: TabsState,
  update: (history: NavHistory) => NavHistory,
): TabsState {
  const tab = state.tabs[state.active]!;
  const history = update(tab.history);
  if (history === tab.history) return state;
  const tabs = state.tabs.slice();
  tabs[state.active] = { ...tab, history };
  return { ...state, tabs };
}

/** Open a tab right after the active one; it becomes active unless `background`. */
export function openTab(
  state: TabsState,
  pageId: PageId | null,
  options: { background?: boolean } = {},
): TabsState {
  if (state.tabs.length >= MAX_TABS) return state;
  const at = state.active + 1;
  const tabs = [...state.tabs.slice(0, at), newTab(pageId), ...state.tabs.slice(at)];
  return { tabs, active: options.background ? state.active : at };
}

/** Close a tab; the one to its right (else left) becomes active. The last tab stays. */
export function closeTab(state: TabsState, index: number): TabsState {
  if (state.tabs.length <= 1 || index < 0 || index >= state.tabs.length) return state;
  const tabs = state.tabs.filter((_, i) => i !== index);
  let active = state.active;
  if (index < active) active--;
  else if (index === active) active = Math.min(index, tabs.length - 1);
  return { tabs, active };
}

/** Move a tab to another position, keeping the same tab active. */
export function moveTab(state: TabsState, from: number, to: number): TabsState {
  if (from === to || from < 0 || from >= state.tabs.length) return state;
  const activeId = state.tabs[state.active]!.id;
  const tabs = state.tabs.slice();
  const [tab] = tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, tab!);
  return { tabs, active: tabs.findIndex((t) => t.id === activeId) };
}

/** Switch to the next (1) or previous (-1) tab, wrapping around. */
export function cycleTab(state: TabsState, direction: 1 | -1): TabsState {
  const n = state.tabs.length;
  return { ...state, active: (state.active + direction + n) % n };
}

/** Tabs read back from settings (dropping anything malformed). */
export function parseTabs(value: unknown): TabsState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { tabs?: unknown; active?: unknown };
  if (!Array.isArray(raw.tabs)) return null;
  const tabs = raw.tabs.flatMap((t): Tab[] => {
    const h = (t as { history?: NavHistory } | null)?.history;
    if (!h || !Array.isArray(h.entries) || typeof h.index !== 'number') return [];
    const entries = h.entries.filter((e): e is string => typeof e === 'string');
    const index = Math.max(entries.length ? 0 : -1, Math.min(h.index, entries.length - 1));
    return [{ id: newId(), history: { entries, index } }];
  });
  if (tabs.length === 0) return null;
  const active =
    typeof raw.active === 'number' ? Math.min(Math.max(0, raw.active), tabs.length - 1) : 0;
  return { tabs: tabs.slice(0, MAX_TABS), active: Math.min(active, MAX_TABS - 1) };
}
