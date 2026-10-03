import type { PageId, PageTreeNode } from '@workspace/core';
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
  SquarePen,
  Trash2,
} from 'lucide-react';

export interface SidebarProps {
  tree: PageTreeNode[];
  currentPageId: PageId | null;
  expanded: ReadonlySet<PageId>;
  theme: ThemePreference;
  onSelect(id: PageId): void;
  onToggle(id: PageId): void;
  onCreate(parentId: PageId | null): void;
  onTrash(id: PageId): void;
  onDuplicate(id: PageId): void;
  onMove(id: PageId): void;
  fileUrl(id: string): string;
  onThemeChange(theme: ThemePreference): void;
  onCollapse(): void;
}

export function Sidebar(props: SidebarProps) {
  const { tree, onCreate, onCollapse, theme, onThemeChange } = props;
  return (
    <nav
      aria-label="Sidebar"
      className="flex h-full w-60 shrink-0 flex-col border-r border-line bg-sidebar select-none"
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

      <button
        type="button"
        onClick={() => onCreate(null)}
        className="mx-1 flex h-7 items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover"
      >
        <SquarePen size={16} />
        New page
      </button>

      <div className="mt-4 flex-1 overflow-y-auto px-1 pb-4">
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
            <TreeItem key={node.page.id} node={node} depth={0} {...props} />
          ))}
        </ul>
        {tree.length === 0 && <p className="px-2 py-1 text-sm text-faint">No pages yet</p>}
      </div>

      <div className="border-t border-line p-1">
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
    </nav>
  );
}

interface TreeItemProps extends SidebarProps {
  node: PageTreeNode;
  depth: number;
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
    fileUrl,
  } = props;
  const { page, children } = node;
  const isOpen = expanded.has(page.id);
  const isCurrent = page.id === currentPageId;

  return (
    <li role="treeitem" aria-expanded={isOpen} aria-selected={isCurrent}>
      <div
        className={cn(
          'group flex h-7 cursor-pointer items-center gap-1 rounded-md pr-1 text-sm',
          isCurrent ? 'bg-active font-medium text-fg' : 'text-muted hover:bg-hover',
        )}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => onSelect(page.id)}
      >
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <span className="flex items-center justify-center group-hover:invisible">
            <PageIcon icon={page.icon} size={16} fileUrl={fileUrl} />
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
