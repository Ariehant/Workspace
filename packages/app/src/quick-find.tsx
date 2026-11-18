import {
  EDITED_RANGES,
  getPage,
  editedSince,
  hasSearchFilters,
  listPages,
  type EditedRange,
  type PageId,
  type PageTree,
  type PageTreeNode,
  type SearchOptions,
  type SearchSort,
} from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import {
  Dialog,
  DialogContent,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  cn,
} from '@workspace/ui';
import { ChevronDown, CornerDownLeft, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { timeAgo } from './comments';
import { useApp } from './context';
import { useDisplayContext, useRegistryVersion } from './database/hooks';
import type { Platform, SearchHit } from './platform';
import type { SidebarSection } from './sections';

export interface QuickFindProps {
  workspace: PageTree;
  platform: Platform;
  /** Recently visited pages, most recent first: shown before anything is typed. */
  recent: readonly PageId[];
  /** The sidebar's sections, for "In" (shown when there's more than one). */
  sections?: readonly SidebarSection[];
  /** A server workspace: "Created by" is offered (pages there record who made them). */
  shared?: boolean;
  onOpen(id: PageId): void;
  onOpenInWindow(id: PageId): void;
  onClose(): void;
}

interface Result {
  id: PageId;
  title: string;
  icon: string | null;
  /** Ancestors' titles, outermost first. */
  path: string[];
  snippet: string | null;
  updatedAt: number | null;
}

/** Quick find's filters, as picked (see `toOptions`). */
interface Filters {
  titlesOnly: boolean;
  /** A sidebar section's id. */
  section: string | null;
  edited: EditedRange | null;
  createdBy: string | null;
  sort: SearchSort;
}

const NO_FILTERS: Filters = {
  titlesOnly: false,
  section: null,
  edited: null,
  createdBy: null,
  sort: 'relevance',
};

const EDITED_LABELS: Record<EditedRange, string> = {
  today: 'Today',
  week: 'Past 7 days',
  month: 'Past 30 days',
  year: 'Past year',
};
const SORT_LABELS: Record<SearchSort, string> = {
  relevance: 'Best match',
  edited: 'Last edited',
  created: 'Created',
};

/** Every page tree a section shows: its own, and those of pages shared into it. */
function treesOf(section: SidebarSection): string[] {
  const trees = new Set<string>();
  if (section.kind !== 'shared') trees.add(section.id);
  const walk = (nodes: readonly PageTreeNode[]) => {
    for (const node of nodes) {
      if (node.page.tree) trees.add(node.page.tree);
      walk(node.children);
    }
  };
  walk(section.nodes);
  return [...trees];
}

const MAX_RESULTS = 20;
const SEARCH_DELAY_MS = 80;
/** When the same query is asked again (the index catches up with edits within a second). */
const RESEARCH_AFTER_MS = [1000, 2500, 5000];
const sameHits = (a: SearchHit[], b: SearchHit[]) =>
  a.length === b.length &&
  a.every(
    (h, i) =>
      h.id === b[i]!.id &&
      h.title === b[i]!.title &&
      h.snippet === b[i]!.snippet &&
      h.updatedAt === b[i]!.updatedAt,
  );

/**
 * Quick find (Ctrl+K / Ctrl+P): pages whose title matches, then pages whose content
 * matches (from the full-text index), each with its location and a highlighted excerpt.
 * Filters (titles only, a section, when edited, who made it) and a sort narrow it, as
 * Notion's do; with filters and nothing typed, it lists the pages they let through.
 */
export function QuickFind({
  workspace,
  platform,
  recent,
  sections = [],
  shared = false,
  onOpen,
  onOpenInWindow,
  onClose,
}: QuickFindProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [found, setFound] = useState<{ key: string; hits: SearchHit[] } | null>(null);
  const q = query.trim();
  const { pages, databases } = useApp();
  const registryVersion = useRegistryVersion();

  const options = useMemo((): SearchOptions => {
    const section = sections.find((s) => s.id === filters.section);
    return {
      ...(filters.titlesOnly && { titlesOnly: true }),
      ...(section && { trees: treesOf(section) }),
      ...(filters.edited && { editedAfter: editedSince(filters.edited) }),
      ...(filters.createdBy && { createdBy: filters.createdBy }),
      ...(filters.sort !== 'relevance' && { sort: filters.sort }),
    };
  }, [filters, sections]);
  const filtering = hasSearchFilters(options);
  const key = JSON.stringify([q, options]);
  const pick = (change: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...change }));
    setSelected(0);
  };

  useEffect(() => {
    if (!q && !filtering) return;
    let active = true;
    const run = () =>
      platform.search(q, options).then(
        (hits) =>
          active &&
          setFound((last) =>
            last?.key === key && sameHits(last.hits, hits) ? last : { key, hits },
          ),
        (error: unknown) => console.error('Search failed', error),
      );
    // The index follows edits (and imports) by a moment, so the same query is asked again a
    // few times while it's on screen: what was just written shows up without retyping.
    const timers = [0, ...RESEARCH_AFTER_MS].map((after) =>
      setTimeout(run, SEARCH_DELAY_MS + after),
    );
    return () => {
      active = false;
      timers.forEach(clearTimeout);
    };
    // `key` stands for `q` and `options`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, key]);

  const results = useMemo(() => {
    const hits = found?.key === key ? found.hits : [];
    const hitsById = new Map(hits.map((h) => [h.id, h]));
    // Pages and database rows alike. A row of a database that isn't loaded shows what the
    // search index has: looking it up would load the whole database just to list it.
    const toResult = (id: PageId, snippet: string | null = null): Result | null => {
      const hit = hitsById.get(id);
      if (hit?.databaseId && !databases.get(hit.databaseId)) {
        if (!pages.get(hit.databaseId)) return null;
        const path = pages.breadcrumb(hit.databaseId).map((p) => p.title || 'Untitled');
        const updatedAt = hit.updatedAt ?? null;
        return { id, title: hit.title || 'Untitled', icon: hit.icon, path, snippet, updatedAt };
      }
      const page = pages.get(id);
      if (!page || page.inTrash) return null;
      const path = pages
        .breadcrumb(id)
        .slice(0, -1)
        .map((p) => p.title || 'Untitled');
      return {
        id,
        title: page.title || 'Untitled',
        icon: page.icon,
        path,
        snippet,
        updatedAt: hit?.updatedAt ?? getPage(workspace, id)?.updatedAt ?? null,
      };
    };
    const live = (r: Result | null): r is Result => r !== null;

    // Filtered: what the index lets through, in its order (the filters apply there).
    if (filtering) {
      return hits
        .map((h) => toResult(h.id, h.snippet || null))
        .filter(live)
        .slice(0, MAX_RESULTS);
    }

    if (!q) {
      const ids = recent.length
        ? recent
        : listPages(workspace)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((p) => p.id);
      return ids
        .map((id) => toResult(id))
        .filter(live)
        .slice(0, MAX_RESULTS);
    }

    const lower = q.toLowerCase();
    const snippets = new Map(hits.map((h) => [h.id, h.snippet]));
    const byTitle = listPages(workspace)
      .filter((p) => (p.title || 'untitled').toLowerCase().includes(lower))
      .sort(
        (a, b) =>
          Number(!(a.title || 'untitled').toLowerCase().startsWith(lower)) -
            Number(!(b.title || 'untitled').toLowerCase().startsWith(lower)) ||
          b.updatedAt - a.updatedAt,
      )
      .map((p) => p.id);
    const ids = [...new Set([...byTitle, ...hits.map((h) => h.id)])];
    return ids
      .map((id) => toResult(id, snippets.get(id) ?? null))
      .filter(live)
      .slice(0, MAX_RESULTS);
    // `registryVersion`: rows found by search appear once their database loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, pages, databases, recent, q, key, filtering, found, registryVersion]);

  const index = Math.min(selected, Math.max(results.length - 1, 0));
  const choose = (i: number, inWindow: boolean) => {
    const result = results[i];
    if (!result) return;
    if (inWindow) onOpenInWindow(result.id);
    else onOpen(result.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Search" hideTitle data-testid="quick-find" className="top-[12vh]">
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <Search size={18} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') setSelected(Math.min(index + 1, results.length - 1));
              else if (event.key === 'ArrowUp') setSelected(Math.max(index - 1, 0));
              else if (event.key === 'Enter') choose(index, event.ctrlKey || event.metaKey);
              else return;
              event.preventDefault();
            }}
            placeholder="Search or jump to a page…"
            aria-label="Search pages"
            className="h-full flex-1 bg-transparent text-base outline-none"
          />
        </div>
        <FilterBar
          filters={filters}
          sections={sections.length > 1 ? sections : []}
          shared={shared}
          onChange={pick}
        />
        <div
          role={results.length ? 'listbox' : undefined}
          aria-label="Results"
          className="max-h-[50vh] overflow-y-auto p-1"
        >
          <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted">
            {filtering
              ? 'Results'
              : q
                ? 'Best matches'
                : recent.length
                  ? 'Recent'
                  : 'Recently edited'}
          </p>
          {results.length === 0 && (
            <p className="px-3 py-2 text-muted">{q || filtering ? 'No results' : 'No pages yet'}</p>
          )}
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={i === index}
              data-testid="quick-find-result"
              onMouseMove={() => i !== index && setSelected(i)}
              onClick={(event) => choose(i, event.shiftKey)}
              className={cn(
                'flex w-full items-start gap-2 rounded-md px-3 py-1.5 text-left',
                i === index && 'bg-hover',
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center text-muted">
                <PageIcon icon={r.icon} size={16} fileUrl={platform.fileUrl} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate font-medium">{r.title}</span>
                  {r.path.length > 0 && (
                    <span className="truncate text-xs text-faint">— {r.path.join(' / ')}</span>
                  )}
                </span>
                {r.snippet && stripMarks(r.snippet) !== r.title && (
                  <span className="truncate text-xs text-muted" data-testid="quick-find-snippet">
                    <Snippet text={r.snippet} />
                  </span>
                )}
              </span>
              {r.updatedAt !== null && (q || filtering) && (
                <span
                  className="mt-0.5 shrink-0 text-xs text-muted"
                  data-testid="quick-find-edited"
                >
                  {timeAgo(r.updatedAt)}
                </span>
              )}
              {i === index && (
                <CornerDownLeft size={14} className="mt-1 shrink-0 text-faint" aria-hidden />
              )}
            </button>
          ))}
        </div>
        <div className="flex gap-4 border-t border-line px-4 py-2 text-xs text-faint">
          <span>↑↓ Select</span>
          <span>↵ Open</span>
          <span>Ctrl+↵ Open in new window</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const stripMarks = (snippet: string) => snippet.replace(/[[\]]/g, '');

/** The filters under the search field: a toggle, then a menu for each. */
function FilterBar({
  filters,
  sections,
  shared,
  onChange,
}: {
  filters: Filters;
  sections: readonly SidebarSection[];
  shared: boolean;
  onChange(change: Partial<Filters>): void;
}) {
  const ctx = useDisplayContext();
  const people = ctx.people ?? [];
  const sectionName = sections.find((s) => s.id === filters.section)?.title;
  const changed =
    filters.titlesOnly ||
    filters.section !== null ||
    filters.edited !== null ||
    filters.createdBy !== null ||
    filters.sort !== 'relevance';
  return (
    <div
      role="toolbar"
      aria-label="Filters"
      data-testid="quick-find-filters"
      className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-1.5 text-xs"
    >
      <button
        type="button"
        aria-pressed={filters.titlesOnly}
        onClick={() => onChange({ titlesOnly: !filters.titlesOnly })}
        className={chip(filters.titlesOnly)}
      >
        Titles only
      </button>
      {sections.length > 0 && (
        <FilterMenu
          label="In"
          value={sectionName ?? 'Anywhere'}
          on={filters.section !== null}
          current={filters.section ?? ''}
          choices={[['', 'Anywhere'], ...sections.map((s): [string, string] => [s.id, s.title])]}
          onPick={(v) => onChange({ section: v || null })}
        />
      )}
      <FilterMenu
        label="Edited"
        value={filters.edited ? EDITED_LABELS[filters.edited] : 'Any time'}
        on={filters.edited !== null}
        current={filters.edited ?? ''}
        choices={[
          ['', 'Any time'],
          ...EDITED_RANGES.map((r): [string, string] => [r, EDITED_LABELS[r]]),
        ]}
        onPick={(v) => onChange({ edited: (v || null) as EditedRange | null })}
      />
      {shared && people.length > 0 && (
        <FilterMenu
          label="Created by"
          value={filters.createdBy ? (ctx.users.get(filters.createdBy) ?? 'Someone') : 'Anyone'}
          on={filters.createdBy !== null}
          current={filters.createdBy ?? ''}
          choices={[
            ['', 'Anyone'],
            ...people.map((id): [string, string] => [id, ctx.users.get(id) ?? 'Someone']),
          ]}
          onPick={(v) => onChange({ createdBy: v || null })}
        />
      )}
      <FilterMenu
        label="Sort"
        value={SORT_LABELS[filters.sort]}
        on={filters.sort !== 'relevance'}
        current={filters.sort}
        choices={(Object.keys(SORT_LABELS) as SearchSort[]).map((s): [string, string] => [
          s,
          SORT_LABELS[s],
        ])}
        onPick={(v) => onChange({ sort: v as SearchSort })}
      />
      {changed && (
        <button
          type="button"
          onClick={() => onChange(NO_FILTERS)}
          className="ml-auto rounded px-1.5 py-0.5 text-muted hover:bg-hover"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

const chip = (on: boolean) =>
  cn(
    'flex h-6 items-center gap-1 rounded-full border px-2',
    // (The text stays the usual colour: accent on its tint is too faint to read.)
    on ? 'border-accent bg-accent/10 text-fg' : 'border-line text-muted hover:bg-hover',
  );

function FilterMenu({
  label,
  value,
  on,
  current,
  choices,
  onPick,
}: {
  label: string;
  value: ReactNode;
  on: boolean;
  current: string;
  choices: readonly [string, string][];
  onPick(value: string): void;
}) {
  return (
    <Menu modal={false}>
      <MenuTrigger asChild>
        <button type="button" className={chip(on)} aria-label={`${label}: ${String(value)}`}>
          <span className={on ? 'text-muted' : ''}>{label}:</span> {value}
          <ChevronDown size={12} aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent aria-label={label} className="max-h-72 overflow-y-auto">
        <MenuRadioGroup value={current} onValueChange={onPick}>
          {choices.map(([v, name]) => (
            <MenuRadioItem key={v || 'none'} value={v}>
              {name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Search excerpt with the matched words (between `[` and `]`) highlighted. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]*)\]/);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-transparent font-semibold text-fg">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
