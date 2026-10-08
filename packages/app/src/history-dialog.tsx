import { blockTexts, replacePageContent } from '@workspace/core';
import { PageEditor } from '@workspace/editor';
import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { useApp } from './context';
import { useEditorServices } from './editor-services';
import { useDocVersion } from './hooks';
import type { DocVersionInfo } from './platform';
import { useDisplayContext } from './database/hooks';

const REASONS: Record<string, string> = {
  edit: 'Before editing',
  restore: 'Before a restore',
  manual: 'Saved',
  template: 'Before a template was applied',
  'not-saved': 'Not saved: your access changed',
};

const when = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A doc built from a saved version's state. */
async function loadVersion(
  getVersion: (id: number) => Promise<Uint8Array | null>,
  id: number,
): Promise<Y.Doc | null> {
  const state = await getVersion(id);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

/**
 * Page history: saved versions of a page, a read-only view of the selected one with
 * what differs from now highlighted, and restore (which can be undone).
 */
export function HistoryDialog({
  docId,
  pageDoc,
  onClose,
}: {
  docId: string;
  /** The live page doc a restore writes into. */
  pageDoc: Y.Doc;
  onClose(): void;
}) {
  const { platform } = useApp();
  const services = useEditorServices(docId);
  const [versions, setVersions] = useState<DocVersionInfo[] | null>(null);
  const { users } = useDisplayContext();
  const [selected, setSelected] = useState<{ id: number; doc: Y.Doc } | null>(null);
  const [undo, setUndo] = useState<number | null>(null);
  const live = useDocVersion(pageDoc);

  const refresh = () => void platform.listVersions(docId).then(setVersions);
  useEffect(refresh, [platform, docId]);

  const select = (id: number) =>
    void loadVersion(platform.getVersion, id).then((doc) => {
      if (!doc) return;
      setSelected((old) => {
        old?.doc.destroy();
        return { id, doc };
      });
    });
  // Show the newest version once the list arrives.
  const firstId = versions?.[0]?.id;
  useEffect(() => {
    if (firstId !== undefined && !selected) select(firstId);
  });

  // Blocks of the version that are gone now, or read differently now.
  const diff = useMemo(() => {
    void live;
    if (!selected) return { changed: [], removed: [], added: 0 };
    const then = blockTexts(selected.doc);
    const now = blockTexts(pageDoc);
    const changed: string[] = [];
    const removed: string[] = [];
    for (const [id, text] of then) {
      if (!now.has(id)) removed.push(id);
      else if (now.get(id) !== text) changed.push(id);
    }
    const added = [...now.keys()].filter((id) => !then.has(id)).length;
    return { changed, removed, added };
  }, [selected, pageDoc, live]);

  const restore = async () => {
    if (!selected) return;
    const before = await platform.snapshot(docId, 'restore');
    replacePageContent(pageDoc, selected.doc);
    setUndo(before);
    refresh();
  };
  const undoRestore = async () => {
    if (undo === null) return;
    const doc = await loadVersion(platform.getVersion, undo);
    if (doc) replacePageContent(pageDoc, doc);
    doc?.destroy();
    setUndo(null);
  };

  const css = [...diff.changed.map((id) => `.ws-history-preview [data-id="${id}"]`)].join(',');
  const cssRemoved = diff.removed.map((id) => `.ws-history-preview [data-id="${id}"]`).join(',');

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Page history"
        className="top-[6vh] flex h-[84vh] w-[min(980px,calc(100vw-32px))] flex-col"
        data-testid="history-dialog"
      >
        <div className="flex min-h-0 flex-1 border-t border-line">
          <div
            className="w-60 shrink-0 overflow-y-auto border-r border-line p-1"
            role="listbox"
            aria-label="Versions"
          >
            {versions?.length === 0 && (
              <p className="p-2 text-sm text-muted">
                No versions yet. A version is saved before each editing session.
              </p>
            )}
            {versions?.map((v) => (
              <button
                key={v.id}
                type="button"
                role="option"
                aria-selected={selected?.id === v.id}
                onClick={() => select(v.id)}
                data-testid="history-version"
                className={cn(
                  'flex w-full flex-col rounded px-2 py-1.5 text-left text-sm hover:bg-hover',
                  selected?.id === v.id && 'bg-active',
                )}
              >
                <span className="font-medium">{when.format(v.createdAt)}</span>
                <span className="text-xs text-muted">
                  {v.authors
                    ? v.authors.length > 0
                      ? `Edited by ${v.authors.map((id) => users.get(id) ?? 'Someone').join(', ')}`
                      : (REASONS[v.reason] ?? 'Saved')
                    : (REASONS[v.reason] ?? v.reason)}
                </span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4 text-sm">
              {selected && (
                <span className="text-muted" data-testid="history-diff">
                  {diff.changed.length} changed · {diff.removed.length} removed since · {diff.added}{' '}
                  added since
                </span>
              )}
              <span className="flex-1" />
              {undo !== null && <Button onClick={() => void undoRestore()}>Undo restore</Button>}
              <Button
                variant="primary"
                disabled={!selected}
                onClick={() => void restore()}
                className="disabled:opacity-50"
              >
                Restore this version
              </Button>
            </div>
            <div
              className="ws-history-preview min-h-0 flex-1 overflow-y-auto px-8 py-4"
              data-testid="history-preview"
            >
              <style>
                {css &&
                  `${css} { background: color-mix(in srgb, var(--ws-yellow) 22%, transparent); border-radius: 3px; }`}
                {cssRemoved &&
                  `${cssRemoved} { background: color-mix(in srgb, var(--ws-red) 18%, transparent); border-radius: 3px; }`}
              </style>
              {selected && (
                <PageEditor
                  key={selected.id}
                  doc={selected.doc}
                  services={services}
                  editable={false}
                  nested
                />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
