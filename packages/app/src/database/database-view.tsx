import { getPage, getPageTitleText, isInTrash, setPageTitle } from '@workspace/core';
import {
  addRow,
  updateView,
  updateViewColumn,
  viewColumns,
  viewsOf,
  type OpenPagesIn,
  type View,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  cn,
} from '@workspace/ui';
import {
  ArrowDown,
  ArrowUp,
  Eye,
  EyeOff,
  Maximize2,
  PanelRight,
  SquareStack,
  Table2,
  WrapText,
  X,
} from 'lucide-react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useApp } from '../context';
import { useDocVersion } from '../hooks';
import { useNavigation } from '../navigation';
import { PropertyIcon } from './cells';
import { useDatabase, useDisplayContext } from './hooks';
import { TableView } from './table';

export interface DatabaseViewProps {
  databaseId: string;
  /** Whose views to show: the database's own (its id) or a linked block's. */
  viewSet?: string;
  editable: boolean;
}

const OPEN_MODES: { mode: OpenPagesIn; label: string; icon: typeof PanelRight }[] = [
  { mode: 'sidePeek', label: 'Side peek', icon: PanelRight },
  { mode: 'center', label: 'Center peek', icon: SquareStack },
  { mode: 'fullPage', label: 'Full page', icon: Maximize2 },
];

/** A database's view tabs, toolbar and the active view. */
export function DatabaseView({ databaseId, viewSet = databaseId, editable }: DatabaseViewProps) {
  const loaded = useDatabase(databaseId);
  const ctx = useDisplayContext();
  const { user } = useApp();
  const { openRow } = useNavigation();
  const [activeId, setActiveId] = useState<string | null>(null);
  if (!loaded) return <div className="h-24" aria-busy="true" />;

  const { handle, snapshot } = loaded;
  const views = viewsOf(snapshot, viewSet);
  const view = views.find((v) => v.id === activeId) ?? views[0];
  if (!view) return <p className="py-4 text-muted">This database has no views.</p>;

  const open = (rowId: string) => openRow(rowId, databaseId, view.openPagesIn);
  const sortNames = view.sorts
    .map((s) => ({ ...s, property: snapshot.properties.find((p) => p.id === s.propertyId) }))
    .filter((s) => s.property);

  return (
    <div data-testid="database-view" data-database-id={databaseId}>
      <div className="flex h-10 items-center gap-1 border-b border-line text-sm">
        <div className="flex min-w-0 flex-1 items-center gap-0.5" role="tablist" aria-label="Views">
          {views.map((v) =>
            v.id === view.id ? (
              <ViewMenu
                key={v.id}
                view={v}
                editable={editable}
                onChange={(changes) => updateView(handle.doc, v.id, changes)}
                columns={viewColumns(v, snapshot.properties).map((c) => ({
                  ...c,
                  property: snapshot.properties.find((p) => p.id === c.id)!,
                }))}
                onToggleColumn={(id, visible) =>
                  updateViewColumn(handle.doc, v.id, id, { visible })
                }
              />
            ) : (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={false}
                onClick={() => setActiveId(v.id)}
                className="flex h-7 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
              >
                <Table2 size={14} /> {v.name}
              </button>
            ),
          )}
          {sortNames.length > 0 && (
            <span className="ml-2 flex items-center gap-1 rounded-full bg-accent/10 py-0.5 pr-1 pl-2 text-xs text-accent">
              {sortNames[0]!.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              {sortNames.map((s) => s.property!.name).join(', ')}
              {editable && (
                <button
                  type="button"
                  aria-label="Remove sort"
                  onClick={() => updateView(handle.doc, view.id, { sorts: [] })}
                  className="rounded-full p-0.5 hover:bg-accent/20"
                >
                  <X size={12} />
                </button>
              )}
            </span>
          )}
        </div>
        {editable && (
          <button
            type="button"
            onClick={() => open(addRow(handle.doc, { actor: user.id }))}
            className="flex h-7 items-center rounded-md bg-accent px-2.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            New
          </button>
        )}
      </div>
      {view.type === 'table' && (
        <TableView
          handle={handle}
          snapshot={snapshot}
          view={view}
          ctx={ctx}
          editable={editable}
          onOpenRow={open}
        />
      )}
    </div>
  );
}

function ViewMenu({
  view,
  editable,
  columns,
  onChange,
  onToggleColumn,
}: {
  view: View;
  editable: boolean;
  columns: {
    id: string;
    visible: boolean;
    property: { name: string; type: Parameters<typeof PropertyIcon>[0]['type'] };
  }[];
  onChange(changes: Partial<View>): void;
  onToggleColumn(id: string, visible: boolean): void;
}) {
  const [name, setName] = useState(view.name);
  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setName(view.name);
        else if (name.trim() && name !== view.name) onChange({ name: name.trim() });
      }}
    >
      <MenuTrigger asChild disabled={!editable}>
        <button
          type="button"
          role="tab"
          aria-selected
          className="flex h-7 items-center gap-1.5 rounded px-2 font-medium text-fg hover:bg-hover"
        >
          <Table2 size={14} /> {view.name}
        </button>
      </MenuTrigger>
      <MenuContent className="w-64" data-testid="view-menu">
        <div className="p-1" onKeyDown={(e) => e.stopPropagation()}>
          <input
            value={name}
            aria-label="View name"
            onChange={(e) => setName(e.target.value)}
            className="h-7 w-full rounded border border-line bg-surface px-2 outline-none focus:border-accent"
          />
        </div>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger icon={<PanelRight size={14} />}>
            <span className="flex-1">Open pages in</span>
            <span className="text-xs text-faint">
              {OPEN_MODES.find((m) => m.mode === view.openPagesIn)?.label}
            </span>
          </MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup
              value={view.openPagesIn}
              onValueChange={(mode) => onChange({ openPagesIn: mode as OpenPagesIn })}
            >
              {OPEN_MODES.map((m) => (
                <MenuRadioItem key={m.mode} value={m.mode}>
                  {m.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger icon={<Eye size={14} />}>Properties</MenuSubTrigger>
          <MenuSubContent className="max-h-96 w-56 overflow-y-auto">
            {columns.map((c) => (
              <MenuItem
                key={c.id}
                icon={<PropertyIcon type={c.property.type} />}
                disabled={c.property.type === 'title'}
                onSelect={(e) => {
                  e.preventDefault();
                  onToggleColumn(c.id, !c.visible);
                }}
              >
                <span className="flex-1 truncate">{c.property.name}</span>
                {c.visible ? <Eye size={14} /> : <EyeOff size={14} className="text-faint" />}
              </MenuItem>
            ))}
          </MenuSubContent>
        </MenuSub>
        <MenuItem
          icon={<WrapText size={14} />}
          onSelect={(e) => {
            e.preventDefault();
            onChange({ wrap: !view.wrap });
          }}
        >
          <span className="flex-1">Wrap all content</span>
          <span className={cn('text-xs', view.wrap ? 'text-accent' : 'text-faint')}>
            {view.wrap ? 'On' : 'Off'}
          </span>
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** An inline database inside a page: its title (open as full page) above the views. */
export function InlineDatabase({ databaseId }: { databaseId: string }) {
  const { workspace, platform } = useApp();
  const { navigate } = useNavigation();
  useDocVersion(workspace); // title, icon and trash state
  const page = getPage(workspace, databaseId);
  if (!page) {
    return <p className="py-2 text-faint">This database was deleted.</p>;
  }
  const trashed = isInTrash(workspace, databaseId);
  return (
    <div className="my-2" data-testid="inline-database">
      <div className="group flex items-center gap-2 pb-1">
        {page.icon && <PageIcon icon={page.icon} size={20} fileUrl={platform.fileUrl} />}
        <DatabaseTitle databaseId={databaseId} readOnly={trashed} />
        <IconButton
          label="Open as full page"
          className="opacity-0 group-hover:opacity-100"
          onClick={() => navigate(databaseId)}
        >
          <Maximize2 size={14} />
        </IconButton>
      </div>
      {trashed ? (
        <p className="py-2 text-faint">This database is in Trash.</p>
      ) : (
        <DatabaseView databaseId={databaseId} editable />
      )}
    </div>
  );
}

/** Small editable title for an inline database (the database page's title). */
function DatabaseTitle({ databaseId, readOnly }: { databaseId: string; readOnly: boolean }) {
  const { workspace } = useApp();
  const ytext = getPageTitleText(workspace, databaseId);
  const subscribe = useCallback(
    (onChange: () => void) => {
      ytext.observe(onChange);
      return () => ytext.unobserve(onChange);
    },
    [ytext],
  );
  const title = useSyncExternalStore(subscribe, () => ytext.toString());
  return (
    <input
      value={title}
      readOnly={readOnly}
      placeholder="Untitled"
      aria-label="Database title"
      onChange={(e) => setPageTitle(workspace, databaseId, e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 bg-transparent text-xl font-bold text-fg outline-none placeholder:text-faint"
    />
  );
}
