import type { PageId, TabsState } from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import { cn } from '@workspace/ui';
import { FileText, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useApp } from './context';

interface TabBarProps {
  state: TabsState;
  /** The page each tab shows (a tab with no history shows the first page). */
  pageOf(index: number): PageId | null;
  onSelect(index: number): void;
  onClose(index: number): void;
  onMove(from: number, to: number): void;
  onNew(): void;
  /** A tab dragged out of the window: open it in a window of its own. */
  onDetach(index: number): void;
}

/** True when a drag ended outside the window (its screen coordinates are past the edges). */
function outsideWindow(event: React.DragEvent): boolean {
  const x = event.screenX - window.screenX;
  const y = event.screenY - window.screenY;
  if (event.screenX === 0 && event.screenY === 0) return false; // cancelled
  return x < 0 || y < 0 || x > window.outerWidth || y > window.outerHeight;
}

/** The window's tabs: each its own page and history. Drag to reorder or out to detach. */
export function TabBar({ state, pageOf, onSelect, onClose, onMove, onNew, onDetach }: TabBarProps) {
  const { pages, platform } = useApp();
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);

  return (
    <div
      role="tablist"
      aria-label="Tabs"
      data-testid="tab-bar"
      className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto border-b border-line bg-sidebar px-1"
      onDragOver={(event) => dragging !== null && event.preventDefault()}
    >
      {state.tabs.map((tab, index) => {
        const page = pageOf(index);
        const ref = page ? pages.get(page) : null;
        const title = ref?.title || 'Untitled';
        const active = index === state.active;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={title}
            data-testid="tab"
            draggable
            onClick={() => onSelect(index)}
            // Middle-click closes, as in a browser.
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onClose(index);
            }}
            onMouseDown={(event) => event.button === 1 && event.preventDefault()}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('application/x-workspace-tab', tab.id);
              setDragging(index);
            }}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null) onMove(dragging, index);
              setDragging(null);
              setOver(null);
            }}
            onDragEnd={(event) => {
              if (dragging !== null && event.dataTransfer.dropEffect === 'none') {
                if (outsideWindow(event)) onDetach(dragging);
              }
              setDragging(null);
              setOver(null);
            }}
            className={cn(
              'group flex h-8 min-w-0 max-w-52 flex-1 basis-40 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-2 text-sm',
              active
                ? 'border-line bg-surface text-fg'
                : 'border-transparent text-muted hover:bg-hover',
              over === index && dragging !== index && 'ring-2 ring-accent/50',
            )}
          >
            {ref?.icon ? (
              <PageIcon icon={ref.icon} size={14} fileUrl={platform.fileUrl} />
            ) : (
              <FileText size={14} className="shrink-0 text-faint" />
            )}
            <span className="min-w-0 flex-1 truncate" data-testid="tab-title">
              {title}
            </span>
            {state.tabs.length > 1 && (
              <button
                type="button"
                aria-label={`Close ${title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(index);
                }}
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-hover',
                  !active && 'opacity-0 group-hover:opacity-100',
                )}
              >
                <X size={13} />
              </button>
            )}
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        onClick={onNew}
        className="mb-1 grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-hover"
      >
        <Plus size={15} />
      </button>
    </div>
  );
}
