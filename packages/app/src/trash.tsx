import {
  deletePagePermanently,
  getAncestorIds,
  getPage,
  restorePage,
  trashedPages,
  type PageId,
} from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import {
  Button,
  Dialog,
  DialogContent,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@workspace/ui';
import { deleteRow, restoreRow } from '@workspace/database';
import { Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';
import { useApp } from './context';
import { useRegistryVersion } from './database/hooks';

/** A trashed page or database row. */
interface TrashItem {
  id: string;
  title: string;
  icon: string | null;
  trashedAt: number;
  /** Where it was: the parent page or the database. */
  parentTitle: string | null;
  restore(): void;
  remove(): void;
}

export interface TrashProps {
  workspace: Y.Doc;
  fileUrl(id: string): string;
  onOpen(id: PageId): void;
  children: ReactNode;
}

/** Trash popover: find, open, restore or permanently delete trashed pages. */
export function Trash({ workspace, fileUrl, onOpen, children }: TrashProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [confirming, setConfirming] = useState<PageId | null>(null);
  const { databases } = useApp();
  useRegistryVersion();

  // Trashed rows live in their databases: load them all while the trash is open.
  useEffect(() => {
    if (open) void databases.loadAll();
  }, [open, databases]);

  const items: TrashItem[] = [
    ...trashedPages(workspace).map((page) => {
      const parent = getAncestorIds(workspace, page.id)[0];
      return {
        id: page.id,
        title: page.title,
        icon: page.icon,
        trashedAt: page.trashedAt!,
        parentTitle: parent ? getPage(workspace, parent)?.title || 'Untitled' : null,
        restore: () => restorePage(workspace, page.id),
        remove: () => deletePagePermanently(workspace, page.id),
      };
    }),
    ...databases.loaded().flatMap((handle) =>
      handle
        .snapshot()
        .rows.filter((row) => row.trashedAt !== null)
        .map((row) => ({
          id: row.id,
          title: row.title,
          icon: row.icon,
          trashedAt: row.trashedAt!,
          parentTitle: getPage(workspace, handle.id)?.title || 'Untitled',
          restore: () => restoreRow(handle.doc, row.id),
          remove: () => deleteRow(handle.doc, row.id),
        })),
    ),
  ].sort((a, b) => b.trashedAt - a.trashedAt);

  const q = query.trim().toLowerCase();
  const pages = open ? items.filter((p) => (p.title || 'untitled').toLowerCase().includes(q)) : [];
  const confirmPage = confirming ? items.find((i) => i.id === confirming) : null;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
        <PopoverContent side="right" align="end" className="w-[400px]" data-testid="trash">
          <div className="border-b border-line p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search pages in Trash"
              aria-label="Search pages in Trash"
              className="h-8 w-full rounded-md border border-line bg-surface px-2 outline-none focus:border-accent"
            />
          </div>
          <ul aria-label="Trashed pages" className="max-h-80 overflow-y-auto p-1">
            {pages.length === 0 && (
              <li className="px-3 py-6 text-center text-muted">
                {q ? 'No matches' : 'Trash is empty'}
              </li>
            )}
            {pages.map((page) => {
              const { parentTitle } = page;
              return (
                <li
                  key={page.id}
                  data-testid="trash-item"
                  className="group flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-hover"
                  onClick={() => {
                    onOpen(page.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex size-5 items-center justify-center text-muted">
                    <PageIcon icon={page.icon} size={16} fileUrl={fileUrl} />
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                    <span className="truncate">{page.title || 'Untitled'}</span>
                    {parentTitle && (
                      <span className="truncate text-xs text-faint">in {parentTitle}</span>
                    )}
                  </span>
                  <IconButton
                    label="Restore"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      page.restore();
                    }}
                  >
                    <Undo2 size={14} />
                  </IconButton>
                  <IconButton
                    label="Delete from Trash"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      setConfirming(page.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
          <p className="border-t border-line px-3 py-2 text-xs text-faint">
            Pages in Trash for over 30 days are deleted automatically.
          </p>
        </PopoverContent>
      </Popover>

      {confirmPage && (
        <Dialog open onOpenChange={(next) => !next && setConfirming(null)}>
          <DialogContent
            title="Delete page permanently?"
            className="w-[min(360px,calc(100vw-32px))] text-center"
            data-testid="confirm-delete"
          >
            <p className="px-4 pt-2 text-muted">
              “{confirmPage.title || 'Untitled'}” and its sub-pages will be deleted. This can’t be
              undone.
            </p>
            <div className="flex flex-col gap-2 p-4">
              <Button
                className="justify-center bg-danger text-white hover:bg-danger/90 hover:text-white"
                onClick={() => {
                  confirmPage.remove();
                  setConfirming(null);
                }}
              >
                Delete permanently
              </Button>
              <Button className="justify-center" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
