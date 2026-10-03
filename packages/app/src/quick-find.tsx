import { getAncestorIds, getPage, isInTrash, listPages, type PageId } from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import { Dialog, DialogContent, cn } from '@workspace/ui';
import { CornerDownLeft, Search } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import type * as Y from 'yjs';
import type { Platform, SearchHit } from './platform';

export interface QuickFindProps {
  workspace: Y.Doc;
  platform: Platform;
  /** Recently visited pages, most recent first: shown before anything is typed. */
  recent: readonly PageId[];
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
}

const MAX_RESULTS = 20;
const SEARCH_DELAY_MS = 80;

/**
 * Quick find (Ctrl+K / Ctrl+P): pages whose title matches, then pages whose content
 * matches (from the full-text index), each with its location and a highlighted excerpt.
 */
export function QuickFind({
  workspace,
  platform,
  recent,
  onOpen,
  onOpenInWindow,
  onClose,
}: QuickFindProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const q = query.trim();

  useEffect(() => {
    if (!q) return;
    let active = true;
    const timer = setTimeout(() => {
      platform.search(q).then(
        (hits) => active && setFound({ query: q, hits }),
        (error: unknown) => console.error('Search failed', error),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [platform, q]);

  const results = useMemo(() => {
    const toResult = (id: PageId, snippet: string | null = null): Result | null => {
      const page = getPage(workspace, id);
      if (!page || isInTrash(workspace, id)) return null;
      const path = getAncestorIds(workspace, id)
        .reverse()
        .map((a) => getPage(workspace, a)?.title || 'Untitled');
      return { id, title: page.title || 'Untitled', icon: page.icon, path, snippet };
    };
    const live = (r: Result | null): r is Result => r !== null;

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
    const hits = found?.query === q ? found.hits : [];
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
  }, [workspace, recent, q, found]);

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
        <div role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1">
          <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted">
            {q ? 'Best matches' : recent.length ? 'Recent' : 'Recently edited'}
          </p>
          {results.length === 0 && (
            <p className="px-3 py-2 text-muted">{q ? 'No results' : 'No pages yet'}</p>
          )}
          {results.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={i === index}
              data-testid="quick-find-result"
              onMouseMove={() => i !== index && setSelected(i)}
              onClick={(event) => choose(i, event.ctrlKey || event.metaKey)}
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
