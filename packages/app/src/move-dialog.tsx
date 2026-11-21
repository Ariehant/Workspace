import {
  getDescendantIds,
  isInTrash,
  listPages,
  type PageId,
  type PageTree,
} from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import { Building2, Home } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/** Other workspaces the page can go to (a workspace on a server). */
export interface OtherWorkspaces {
  list(): Promise<{ id: string; name: string }[]>;
  /** Copies it there (into your private pages) and puts it in the trash here. */
  move(workspaceId: string): Promise<void>;
}

export interface MoveDialogProps {
  workspace: PageTree;
  pageId: PageId;
  fileUrl(id: string): string;
  onMove(parentId: PageId | null): void;
  onClose(): void;
  otherWorkspaces?: OtherWorkspaces;
}

/** Pick a new parent for a page (or the top level). A page can't move into itself. */
export function MoveDialog({
  workspace,
  pageId,
  fileUrl,
  onMove,
  onClose,
  otherWorkspaces,
}: MoveDialogProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const [elsewhere, setElsewhere] = useState<{ id: string; name: string } | null>(null);

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

  if (elsewhere && otherWorkspaces) {
    const title = listPages(workspace).find((p) => p.id === pageId)?.title || 'Untitled';
    return (
      <MoveElsewhere
        title={title}
        target={elsewhere}
        move={() => otherWorkspaces.move(elsewhere.id)}
        onBack={() => setElsewhere(null)}
        onClose={onClose}
      />
    );
  }

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
        <div
          role={targets.length ? 'listbox' : undefined}
          aria-label="Destinations"
          className="max-h-80 overflow-y-auto p-1"
        >
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
        {otherWorkspaces && !query.trim() && (
          <WorkspaceTargets list={otherWorkspaces.list} onPick={setElsewhere} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The other workspaces, below the pages (loaded when the dialog opens). */
function WorkspaceTargets({
  list,
  onPick,
}: {
  list: OtherWorkspaces['list'];
  onPick(target: { id: string; name: string }): void;
}) {
  const [targets, setTargets] = useState<{ id: string; name: string }[] | null>(null);
  useEffect(() => {
    let active = true;
    list().then(
      (found) => active && setTargets(found),
      () => active && setTargets([]),
    );
    return () => {
      active = false;
    };
  }, [list]);
  if (!targets?.length) return null;
  return (
    <div
      role="group"
      aria-label="Other workspaces"
      className="border-t border-line p-1"
      data-testid="move-workspaces"
    >
      <p className="px-3 pt-1 pb-0.5 text-xs text-muted">Another workspace</p>
      {targets.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onPick(t)}
          className="flex h-9 w-full items-center gap-2 rounded-md px-3 text-left hover:bg-hover"
        >
          <Building2 size={16} className="text-muted" aria-hidden />
          <span className="truncate">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Moving to another workspace: what it does, then done (or why not). */
function MoveElsewhere({
  title,
  target,
  move,
  onBack,
  onClose,
}: {
  title: string;
  target: { id: string; name: string };
  move(): Promise<void>;
  onBack(): void;
  onClose(): void;
}) {
  const [state, setState] = useState<'ask' | 'moving' | 'done' | { error: string }>('ask');
  return (
    <Dialog open onOpenChange={(open) => !open && state !== 'moving' && onClose()}>
      <DialogContent
        title={`Move to ${target.name}`}
        data-testid="move-workspace-dialog"
        className="flex flex-col gap-3 p-4"
      >
        {state === 'done' ? (
          <p role="status">
            “{title}” is in your private pages in {target.name}. Here, it’s in the trash.
          </p>
        ) : (
          <p>
            “{title}”, its sub-pages, databases and files are copied to your private pages in{' '}
            {target.name}, then put in the trash here. Links to it from other pages here won’t
            follow it.
          </p>
        )}
        {typeof state === 'object' && (
          <p role="alert" className="text-sm text-danger">
            {state.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {state === 'done' ? (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={onBack} disabled={state === 'moving'}>
                Back
              </Button>
              <Button
                variant="primary"
                disabled={state === 'moving'}
                onClick={() => {
                  setState('moving');
                  move().then(
                    () => setState('done'),
                    (e: unknown) =>
                      setState({ error: e instanceof Error ? e.message : 'It couldn’t be moved.' }),
                  );
                }}
              >
                {state === 'moving' ? 'Moving…' : 'Move'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
