import { resolveDrop, type DropZone, type PageId, type PageTreeNode } from '@workspace/core';
import { PageIcon } from '@workspace/editor';
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  cn,
  type ThemePreference,
} from '@workspace/ui';
import {
  ChevronRight,
  ChevronsLeft,
  Copy,
  CornerUpRight,
  MoreHorizontal,
  Palette,
  Plus,
  Search,
  SquarePen,
  Star,
  Table2,
  StarOff,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import type * as Y from 'yjs';
import { Trash } from './trash';

export const SIDEBAR_WIDTH = { min: 200, max: 480, default: 240 } as const;

/** A page being dragged in the sidebar and where it would land. */
interface DragState {
  id: PageId;
  over: { id: PageId; zone: DropZone } | null;
}

export interface SidebarProps {
  workspace: Y.Doc;
  tree: PageTreeNode[];
  favorites: readonly PageId[];
  width: number;
  currentPageId: PageId | null;
  expanded: ReadonlySet<PageId>;
  theme: ThemePreference;
  onSelect(id: PageId): void;
  onToggle(id: PageId): void;
  onCreate(parentId: PageId | null): void;
  onTrash(id: PageId): void;
  onDuplicate(id: PageId): void;
  onMove(id: PageId): void;
  /** Drop `id` relative to `targetId`, or at the end of the top level when `null`. */
  onDrop(id: PageId, targetId: PageId | null, zone: DropZone): void;
  onToggleFavorite(id: PageId): void;
  onSearch(): void;
  onResize(width: number): void;
  fileUrl(id: string): string;
  onThemeChange(theme: ThemePreference): void;
  onCollapse(): void;
}

export function Sidebar(props: SidebarProps) {
  const { workspace, tree, favorites, width, onCreate, onCollapse, onSelect, onSearch, onDrop } =
    props;
  const { theme, onThemeChange, fileUrl } = props;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overEnd, setOverEnd] = useState(false);

  const nodes = new Map<PageId, PageTreeNode>();
  const index = (list: PageTreeNode[]) =>
    list.forEach((node) => {
      nodes.set(node.page.id, node);
      index(node.children);
    });
  index(tree);
  const favoriteNodes = favorites
    .map((id) => nodes.get(id))
    .filter((node): node is PageTreeNode => node !== undefined);

  const itemProps = { ...props, drag, setDrag };
  const navButton =
    'mx-1 flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover';
  return (
    <nav
      aria-label="Sidebar"
      style={{ width }}
      className="relative flex h-full shrink-0 flex-col border-r border-line bg-sidebar select-none"
    >
      <div className="group flex h-11 items-center gap-2 px-3">
        <div className="flex size-5 items-center justify-center rounded bg-active text-xs font-semibold">
          W
        </div>
        <span className="flex-1 truncate text-sm font-medium">Workspace</span>
        <IconButton
          label="Close sidebar (Ctrl+\)"
          size="sm"
          className="opacity-0 group-hover:opacity-100"
          onClick={onCollapse}
        >
          <ChevronsLeft size={16} />
        </IconButton>
      </div>

      <button type="button" onClick={onSearch} className={navButton}>
        <Search size={16} />
        <span className="flex-1 text-left">Search</span>
        <kbd className="font-sans text-xs text-faint">Ctrl+K</kbd>
      </button>
      <button type="button" onClick={() => onCreate(null)} className={navButton}>
        <SquarePen size={16} />
        New page
      </button>

      <div className="mt-4 flex flex-1 flex-col overflow-y-auto px-1 pb-4">
        {favoriteNodes.length > 0 && (
          <section className="mb-4">
            <div className="flex h-7 items-center px-2 text-xs font-medium text-muted">
              Favorites
            </div>
            <ul role="tree" aria-label="Favorites">
              {favoriteNodes.map((node) => (
                <TreeItem
                  key={node.page.id}
                  node={node}
                  depth={0}
                  draggableRows={false}
                  {...itemProps}
                />
              ))}
            </ul>
          </section>
        )}
        <div className="group flex h-7 items-center px-2 text-xs font-medium text-muted">
          <span className="flex-1">Pages</span>
          <IconButton
            label="Add a page"
            size="sm"
            className="opacity-0 group-hover:opacity-100"
            onClick={() => onCreate(null)}
          >
            <Plus size={14} />
          </IconButton>
        </div>
        <ul role="tree" aria-label="Pages">
          {tree.map((node) => (
            <TreeItem key={node.page.id} node={node} depth={0} draggableRows {...itemProps} />
          ))}
        </ul>
        {tree.length === 0 && <p className="px-2 py-1 text-sm text-faint">No pages yet</p>}
        {/* Dropping below the tree moves a page to the end of the top level. */}
        <div
          data-testid="sidebar-drop-end"
          className={cn('min-h-8 flex-1 border-t-2 border-transparent', overEnd && 'border-accent')}
          onDragOver={(event) => {
            if (!drag) return;
            event.preventDefault();
            setOverEnd(true);
            if (drag.over) setDrag({ ...drag, over: null });
          }}
          onDragLeave={() => setOverEnd(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOverEnd(false);
            if (drag) onDrop(drag.id, null, 'after');
            setDrag(null);
          }}
        />
      </div>

      <div className="border-t border-line p-1">
        <Trash workspace={workspace} fileUrl={fileUrl} onOpen={onSelect}>
          <button
            type="button"
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover"
          >
            <Trash2 size={16} />
            Trash
          </button>
        </Trash>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover"
            >
              <Palette size={16} />
              Appearance
            </button>
          </MenuTrigger>
          <MenuContent side="top">
            <MenuRadioGroup
              value={theme}
              onValueChange={(value) => onThemeChange(value as ThemePreference)}
            >
              <MenuRadioItem value="system">Use system setting</MenuRadioItem>
              <MenuRadioItem value="light">Light</MenuRadioItem>
              <MenuRadioItem value="dark">Dark</MenuRadioItem>
            </MenuRadioGroup>
          </MenuContent>
        </Menu>
      </div>
      <ResizeHandle width={width} onResize={props.onResize} />
    </nav>
  );
}

/** Drag the sidebar's right edge to resize it; double-click resets the width. */
function ResizeHandle({ width, onResize }: { width: number; onResize(width: number): void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) =>
    Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, w)));
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      data-testid="sidebar-resize"
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-accent/30 active:bg-accent/50"
      onPointerDown={(event: PointerEvent) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = { x: event.clientX, width };
      }}
      onPointerMove={(event: PointerEvent) => {
        if (start.current) onResize(clamp(start.current.width + event.clientX - start.current.x));
      }}
      onPointerUp={() => (start.current = null)}
      onDoubleClick={() => onResize(SIDEBAR_WIDTH.default)}
    />
  );
}

interface TreeItemProps extends SidebarProps {
  node: PageTreeNode;
  depth: number;
  /** Rows in the page tree can be dragged (favorites can't). */
  draggableRows: boolean;
  drag: DragState | null;
  setDrag(drag: DragState | null): void;
}

const AUTO_EXPAND_MS = 600;

/** Which part of a row the pointer is over: top quarter, bottom quarter or middle. */
function zoneAt(event: DragEvent<HTMLElement>): DropZone {
  const rect = event.currentTarget.getBoundingClientRect();
  const y = (event.clientY - rect.top) / rect.height;
  return y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
}

function TreeItem(props: TreeItemProps) {
  const {
    node,
    depth,
    currentPageId,
    expanded,
    onSelect,
    onToggle,
    onCreate,
    onTrash,
    onDuplicate,
    onMove,
    onDrop,
    onToggleFavorite,
    favorites,
    fileUrl,
    workspace,
    draggableRows,
    drag,
    setDrag,
  } = props;
  const { page, children } = node;
  const isOpen = expanded.has(page.id);
  const isCurrent = page.id === currentPageId;
  const isFavorite = favorites.includes(page.id);
  const over = draggableRows && drag?.over?.id === page.id ? drag.over.zone : null;

  // Hovering a dragged page over a collapsed one opens it, so it can be dropped deeper.
  useEffect(() => {
    if (over !== 'inside' || isOpen) return;
    const timer = setTimeout(() => onToggle(page.id), AUTO_EXPAND_MS);
    return () => clearTimeout(timer);
  }, [over, isOpen, onToggle, page.id]);

  const dragProps = draggableRows
    ? {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLDivElement>) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', page.title || 'Untitled');
          setDrag({ id: page.id, over: null });
        },
        onDragEnd: () => setDrag(null),
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!drag) return;
          const zone = zoneAt(event);
          if (!resolveDrop(workspace, drag.id, page.id, zone)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'move';
          if (drag.over?.id !== page.id || drag.over.zone !== zone) {
            setDrag({ ...drag, over: { id: page.id, zone } });
          }
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          event.stopPropagation();
          if (drag) onDrop(drag.id, page.id, zoneAt(event));
          setDrag(null);
        },
      }
    : {};

  return (
    <li role="treeitem" aria-expanded={isOpen} aria-selected={isCurrent}>
      <div
        data-testid="sidebar-row"
        data-drop={over ?? undefined}
        className={cn(
          'group relative flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1 text-sm',
          isCurrent ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover',
          drag?.id === page.id && draggableRows && 'opacity-50',
          over === 'inside' && 'bg-accent/20 ring-1 ring-accent',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(page.id)}
        {...dragProps}
      >
        {(over === 'before' || over === 'after') && (
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute right-1 h-0.5 rounded bg-accent',
              over === 'before' ? '-top-px' : '-bottom-px',
            )}
            style={{ left: 8 + depth * 12 }}
          />
        )}
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <span className="flex items-center justify-center group-hover:invisible">
            {page.kind === 'database' && !page.icon ? (
              <Table2 size={16} aria-label="Database" />
            ) : (
              <PageIcon icon={page.icon} size={16} fileUrl={fileUrl} />
            )}
          </span>
          <IconButton
            label={isOpen ? 'Collapse' : 'Expand'}
            size="sm"
            className="invisible absolute inset-0 group-hover:visible"
            onClick={(event) => {
              event.stopPropagation();
              onToggle(page.id);
            }}
          >
            <ChevronRight size={14} className={cn('transition-transform', isOpen && 'rotate-90')} />
          </IconButton>
        </span>
        <span className="flex-1 truncate" data-testid="sidebar-page-title">
          {page.title || 'Untitled'}
        </span>
        <span className="flex items-center opacity-0 group-hover:opacity-100">
          <Menu>
            <MenuTrigger asChild>
              <IconButton
                label="Delete, duplicate, and more…"
                size="sm"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal size={14} />
              </IconButton>
            </MenuTrigger>
            <MenuContent onClick={(e) => e.stopPropagation()}>
              <MenuItem
                icon={isFavorite ? <StarOff size={14} /> : <Star size={14} />}
                onSelect={() => onToggleFavorite(page.id)}
              >
                {isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Copy size={14} />} onSelect={() => onDuplicate(page.id)}>
                Duplicate
              </MenuItem>
              <MenuItem icon={<CornerUpRight size={14} />} onSelect={() => onMove(page.id)}>
                Move to
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => onTrash(page.id)}>
                Move to Trash
              </MenuItem>
            </MenuContent>
          </Menu>
          <IconButton
            label="Add a page inside"
            size="sm"
            onClick={(event) => {
              event.stopPropagation();
              onCreate(page.id);
            }}
          >
            <Plus size={14} />
          </IconButton>
        </span>
      </div>
      {isOpen && (
        <ul role="group">
          {children.map((child) => (
            <TreeItem key={child.page.id} {...props} node={child} depth={depth + 1} />
          ))}
          {children.length === 0 && (
            <li
              className="h-7 text-sm leading-7 text-faint"
              style={{ paddingLeft: 8 + (depth + 1) * 12 + 24 }}
            >
              No pages inside
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
