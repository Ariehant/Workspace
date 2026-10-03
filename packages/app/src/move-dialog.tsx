import { getDescendantIds, isInTrash, listPages, type PageId } from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import { Dialog, DialogContent, cn } from '@workspace/ui';
import { Home } from 'lucide-react';
import { useMemo, useState } from 'react';
import type * as Y from 'yjs';

export interface MoveDialogProps {
  workspace: Y.Doc;
  pageId: PageId;
  fileUrl(id: string): string;
  onMove(parentId: PageId | null): void;
  onClose(): void;
}

/** Pick a new parent for a page (or the top level). A page can't move into itself. */
export function MoveDialog({ workspace, pageId, fileUrl, onMove, onClose }: MoveDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);

  const targets = useMemo(() => {
    const excluded = new Set([pageId, ...getDescendantIds(workspace, pageId)]);
    const q = query.trim().toLowerCase();
    const pages = listPages(workspace)
      .filter((p) => !excluded.has(p.id) && !isInTrash(workspace, p.id))
      .filter((p) => !q || (p.title || 'untitled').toLowerCase().includes(q))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map((p) => ({ id: p.id as PageId | null, title: p.title || 'Untitled', icon: p.icon }));
    return q ? pages : [{ id: null, title: 'Top level', icon: null }, ...pages];
  }, [workspace, pageId, query]);

  const choose = (index: number) => {
    const target = targets[index];
    if (!target) return;
    onMove(target.id);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Move page to" hideTitle data-testid="move-dialog">
        <input
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') setSelected((i) => Math.min(i + 1, targets.length - 1));
            else if (event.key === 'ArrowUp') setSelected((i) => Math.max(i - 1, 0));
            else if (event.key === 'Enter') choose(selected);
            else return;
            event.preventDefault();
          }}
          placeholder="Move page to…"
          aria-label="Search for a page to move to"
          className="h-12 w-full rounded-t-xl border-b border-line bg-transparent px-4 text-base outline-none"
        />
        <div role="listbox" aria-label="Destinations" className="max-h-80 overflow-y-auto p-1">
          {targets.length === 0 && <p className="px-3 py-2 text-muted">No pages found</p>}
          {targets.map((t, i) => (
            <button
              key={t.id ?? 'top'}
              type="button"
              role="option"
              aria-selected={i === selected}
              onMouseEnter={() => setSelected(i)}
              onClick={() => choose(i)}
              className={cn(
                'flex h-9 w-full items-center gap-2 rounded-md px-3 text-left',
                i === selected && 'bg-hover',
              )}
            >
              <span className="flex size-5 items-center justify-center text-muted">
                {t.id === null ? (
                  <Home size={16} />
                ) : (
                  <PageIcon icon={t.icon} size={16} fileUrl={fileUrl} />
                )}
              </span>
              <span className="truncate">{t.title}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
