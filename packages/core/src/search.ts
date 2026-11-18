/**
 * Quick find's filters and sorting (Phase 8 N4), shared by the desktop's index, the server's
 * and what carries them between (IPC, query parameters).
 */

export type SearchSort = 'relevance' | 'edited' | 'created';
export const SEARCH_SORTS: readonly SearchSort[] = ['relevance', 'edited', 'created'];

/** "Edited": since when, as quick find offers it. */
export type EditedRange = 'today' | 'week' | 'month' | 'year';
export const EDITED_RANGES: readonly EditedRange[] = ['today', 'week', 'month', 'year'];

export interface SearchOptions {
  /** Match titles only, not the content or properties. */
  titlesOnly?: boolean;
  /**
   * Only pages in these page trees (a sidebar section's: a teamspace's tree, and the trees of
   * pages shared into it). On a server, each tree is a scope's.
   */
  trees?: string[];
  /** Only pages edited at or after this time (ms). */
  editedAfter?: number;
  /** Only pages created by this person (a user id). */
  createdBy?: string;
  sort?: SearchSort;
  limit?: number;
}

export const MAX_SEARCH_LIMIT = 50;
const MAX_TREES = 50;
const ID = /^[A-Za-z0-9_:-]{1,128}$/;

/** The start of an "Edited" range, in local time (today is since midnight). */
export function editedSince(range: EditedRange, now = Date.now()): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const days = { today: 0, week: 6, month: 29, year: 364 }[range];
  day.setDate(day.getDate() - days);
  return day.getTime();
}

/** Whether any filter or sort is set (with an empty query, quick find then lists what matches). */
export function hasSearchFilters(options: SearchOptions): boolean {
  return Boolean(
    options.titlesOnly ||
    options.trees?.length ||
    options.editedAfter !== undefined ||
    options.createdBy ||
    (options.sort && options.sort !== 'relevance'),
  );
}

/**
 * Options read from an untrusted source (IPC, a request), keeping only what's valid: unknown
 * keys and bad values are dropped, not errors.
 */
export function cleanSearchOptions(input: unknown): SearchOptions {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  const out: SearchOptions = {};
  if (o.titlesOnly === true) out.titlesOnly = true;
  if (Array.isArray(o.trees)) {
    const trees = o.trees.filter((s): s is string => typeof s === 'string' && ID.test(s));
    if (trees.length) out.trees = trees.slice(0, MAX_TREES);
  }
  if (typeof o.editedAfter === 'number' && Number.isFinite(o.editedAfter) && o.editedAfter > 0) {
    out.editedAfter = o.editedAfter;
  }
  if (typeof o.createdBy === 'string' && ID.test(o.createdBy)) out.createdBy = o.createdBy;
  if (typeof o.sort === 'string' && (SEARCH_SORTS as string[]).includes(o.sort)) {
    out.sort = o.sort as SearchSort;
  }
  if (typeof o.limit === 'number' && Number.isInteger(o.limit) && o.limit > 0) {
    out.limit = Math.min(o.limit, MAX_SEARCH_LIMIT);
  }
  return out;
}

/** As query parameters (the web app's request to the server). */
export function searchOptionsToParams(options: SearchOptions, params: URLSearchParams): void {
  if (options.titlesOnly) params.set('titles', '1');
  for (const tree of options.trees ?? []) params.append('tree', tree);
  if (options.editedAfter !== undefined) params.set('editedAfter', String(options.editedAfter));
  if (options.createdBy) params.set('createdBy', options.createdBy);
  if (options.sort && options.sort !== 'relevance') params.set('sort', options.sort);
  if (options.limit) params.set('limit', String(options.limit));
}

/** Read back from query parameters (already parsed into strings and arrays). */
export function searchOptionsFromQuery(query: Record<string, unknown>): SearchOptions {
  const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  return cleanSearchOptions({
    titlesOnly: query.titles === '1' || query.titles === 'true',
    trees: list(query.tree),
    editedAfter: query.editedAfter === undefined ? undefined : Number(query.editedAfter),
    createdBy: query.createdBy,
    sort: query.sort,
    limit: query.limit === undefined ? undefined : Number(query.limit),
  });
}
