import { getPage, getPageTitleText, isInTrash, setPageTitle } from '@workspace/core';
import {
  addRow,
  addView,
  countRules,
  deleteView,
  duplicateView,
  moveView,
  newFilterGroup,
  newFilterRule,
  runView,
  updateFilterTree,
  updateView,
  updateViewColumn,
  viewColumns,
  viewsOf,
  type FilterGroup,
  type FilterRule,
  type OpenPagesIn,
  type View,
  enableSubItems,
  disableSubItems,
  enableDependencies,
  disableDependencies,
  type DatabaseMeta,
  VIEW_TYPES,
  setViewType,
  type CardPreview,
  type CardSize,
  type ViewType,
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
  Popover,
  PopoverAnchor,
  PopoverContent,
  cn,
} from '@workspace/ui';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Layers,
  ListFilter,
  Maximize2,
  PanelRight,
  Plus,
  Search,
  Table2,
  SquareKanban,
  List as ListIcon,
  LayoutGrid,
  Image as ImageIcon,
  Maximize,
  Palette,
  Ruler,
  CalendarDays,
  GanttChart,
  BarChart3,
  type LucideIcon,
  Trash2,
  WrapText,
  X,
  ListTree,
  GitBranch,
} from 'lucide-react';
import { Suspense, lazy, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useApp } from '../context';
import { useDocVersion } from '../hooks';
import { useNavigation } from '../navigation';
import { PropertyIcon } from './cells';
import { useDatabase, useDisplayContext } from './hooks';
import { BoardView } from './board';
import { GalleryView } from './gallery';
import { ListView } from './list';
import { CalendarView, dateProperties } from './calendar';
import { TimelineView } from './timeline';

// recharts is large: load it when a chart is shown.
const ChartView = lazy(() => import('./chart'));

const VIEW_ICONS: Record<ViewType, LucideIcon> = {
  table: Table2,
  board: SquareKanban,
  list: ListIcon,
  gallery: LayoutGrid,
  calendar: CalendarDays,
  timeline: GanttChart,
  chart: BarChart3,
};

export function ViewIcon({ type, size = 14 }: { type: ViewType; size?: number }) {
  const Icon = VIEW_ICONS[type];
  return <Icon size={size} />;
}
import { TableView } from './table';
import {
  FilterGroupEditor,
  GroupEditor,
  PropertyPicker,
  RuleChip,
  SortEditor,
  isAdvanced,
} from './view-controls';

export interface DatabaseViewProps {
  databaseId: string;
  /** Whose views to show: the database's own (its id) or a linked block's. */
  viewSet?: string;
  editable: boolean;
}

const OPEN_MODES: { mode: OpenPagesIn; label: string }[] = [
  { mode: 'sidePeek', label: 'Side peek' },
  { mode: 'center', label: 'Center peek' },
  { mode: 'fullPage', label: 'Full page' },
];

/** Which panel of the toolbar is open. */
type Panel = 'filter' | 'advanced' | 'sort' | 'group' | null;

/** The last view picked in a view set, remembered per window user. */
function useActiveView(viewSet: string): [string | null, (id: string) => void] {
  const { platform } = useApp();
  const key = `view.${viewSet}`;
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    platform.getSetting<string>(key).then(
      (id) => alive && id && setActive(id),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [platform, key]);
  const choose = useCallback(
    (id: string) => {
      setActive(id);
      platform.setSetting(key, id);
    },
    [platform, key],
  );
  return [active, choose];
}

/** A database's view tabs, toolbar and the active view. */
export function DatabaseView({ databaseId, viewSet = databaseId, editable }: DatabaseViewProps) {
  const loaded = useDatabase(databaseId);
  const ctx = useDisplayContext();
  const { user } = useApp();
  const { openRow } = useNavigation();
  const [activeId, setActiveId] = useActiveView(viewSet);
  const [panel, setPanel] = useState<Panel>(null);
  const [openChip, setOpenChip] = useState<string | null>(null);
  const [search, setSearch] = useState<string | null>(null);
  const [dragTab, setDragTab] = useState<string | null>(null);

  const snapshot = loaded?.snapshot;
  const views = snapshot ? viewsOf(snapshot, viewSet) : [];
  const view = views.find((v) => v.id === activeId) ?? views[0];
  // (The React compiler memoizes these.)
  const viewCtx = { ...ctx, me: user.id, pages: snapshot?.related };
  const result =
    snapshot && view ? runView(snapshot, view, viewCtx, { search: search ?? '' }) : null;
  if (!loaded || !snapshot) return <div className="h-24" aria-busy="true" />;
  const { handle } = loaded;
  const doc = handle.doc;
  if (!view || !result) return <p className="py-4 text-muted">This database has no views.</p>;

  const open = (rowId: string) => openRow(rowId, databaseId, view.openPagesIn);
  const properties = snapshot.properties;
  const byId = new Map(properties.map((p) => [p.id, p]));
  const setFilter = (filter: FilterGroup | null) =>
    updateView(doc, view.id, { filter: filter && filter.filters.length ? filter : null });
  const addFilter = (propertyId: string) => {
    const property = byId.get(propertyId);
    if (!property) return;
    const rule = newFilterRule(property);
    const root = view.filter ?? newFilterGroup('and');
    setFilter({ ...root, filters: [...root.filters, rule] });
    setPanel(null);
    if (isAdvanced(root)) setPanel('advanced');
    else setOpenChip(rule.id);
  };
  const advanced = isAdvanced(view.filter);
  const ruleCount = countRules(view.filter);
  const sortNames = view.sorts.map((s) => byId.get(s.propertyId)?.name).filter(Boolean);
  const showBar = ruleCount > 0 || view.sorts.length > 0;

  const toolbarButton = (active: boolean) =>
    cn(
      'flex h-7 items-center gap-1 rounded px-1.5 text-sm hover:bg-hover',
      active ? 'text-accent' : 'text-muted',
    );

  return (
    <div data-testid="database-view" data-database-id={databaseId}>
      <div className="flex h-10 items-center gap-1 border-b border-line text-sm">
        <div
          className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          role="tablist"
          aria-label="Views"
        >
          {views.map((v) => (
            <div
              key={v.id}
              draggable={editable}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', v.name);
                setDragTab(v.id);
              }}
              onDragOver={(e) => dragTab && dragTab !== v.id && e.preventDefault()}
              onDrop={() => {
                if (dragTab && dragTab !== v.id) moveView(doc, dragTab, v.id);
                setDragTab(null);
              }}
              onDragEnd={() => setDragTab(null)}
              className={cn('shrink-0', dragTab === v.id && 'opacity-50')}
            >
              {v.id === view.id ? (
                <ViewMenu
                  meta={snapshot.meta}
                  onMeta={(feature, on, deleteProperties) => {
                    if (feature === 'subItems') {
                      if (on) enableSubItems(doc, databaseId);
                      else disableSubItems(doc, { deleteProperties });
                    } else if (on) enableDependencies(doc, databaseId);
                    else disableDependencies(doc, { deleteProperties });
                  }}
                  view={v}
                  filesProperties={properties.filter((p) => p.type === 'files')}
                  dateProperties={dateProperties(properties)}
                  hasDependencies={snapshot.meta.dependencies !== null}
                  onLayout={(type) => setViewType(doc, v.id, type)}
                  editable={editable}
                  canDelete={views.length > 1}
                  onChange={(changes) => updateView(doc, v.id, changes)}
                  columns={viewColumns(v, properties).map((c) => ({
                    ...c,
                    property: byId.get(c.id)!,
                  }))}
                  onToggleColumn={(id, visible) => updateViewColumn(doc, v.id, id, { visible })}
                  onDuplicate={() => setActiveId(duplicateView(doc, v.id))}
                  onDelete={() => {
                    deleteView(doc, v.id);
                    const next = views.find((x) => x.id !== v.id);
                    if (next) setActiveId(next.id);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={false}
                  onClick={() => setActiveId(v.id)}
                  className="flex h-7 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
                >
                  <ViewIcon type={v.type} /> {v.name}
                </button>
              )}
            </div>
          ))}
          {editable && (
            <Menu>
              <MenuTrigger asChild>
                <IconButton label="Add a view">
                  <Plus size={15} />
                </IconButton>
              </MenuTrigger>
              <MenuContent data-testid="add-view-menu">
                {VIEW_TYPES.map(({ type, label }) => (
                  <MenuItem
                    key={type}
                    icon={<ViewIcon type={type} />}
                    onSelect={() =>
                      setActiveId(
                        addView(doc, {
                          viewSet,
                          name: views.some((v) => v.name === label)
                            ? `${label} ${views.length + 1}`
                            : label,
                          type,
                        }),
                      )
                    }
                  >
                    {label}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>

        {/* Toolbar */}
        <Popover
          open={panel === 'filter' || panel === 'advanced'}
          onOpenChange={(o) => !o && setPanel(null)}
        >
          <PopoverAnchor asChild>
            <button
              type="button"
              className={toolbarButton(ruleCount > 0)}
              onClick={() => setPanel(advanced ? 'advanced' : panel === 'filter' ? null : 'filter')}
            >
              <ListFilter size={15} /> <span className="max-md:hidden">Filter</span>
            </button>
          </PopoverAnchor>
          <PopoverContent
            align="end"
            // Focus coming back from a closing chip popover shouldn't close this one.
            onFocusOutside={(e) => e.preventDefault()}
          >
            {panel === 'advanced' && view.filter ? (
              <FilterGroupEditor
                root={view.filter}
                properties={properties}
                ctx={viewCtx}
                onChange={setFilter}
              />
            ) : (
              <PropertyPicker
                properties={properties}
                label="Filter by…"
                onPick={(p) => addFilter(p.id)}
              />
            )}
          </PopoverContent>
        </Popover>
        <Popover open={panel === 'sort'} onOpenChange={(o) => !o && setPanel(null)}>
          <PopoverAnchor asChild>
            <button
              type="button"
              className={toolbarButton(view.sorts.length > 0)}
              onClick={() => setPanel(panel === 'sort' ? null : 'sort')}
            >
              <ArrowUpDown size={15} /> <span className="max-md:hidden">Sort</span>
            </button>
          </PopoverAnchor>
          <PopoverContent align="end">
            {view.sorts.length === 0 ? (
              <PropertyPicker
                properties={properties}
                label="Sort by…"
                onPick={(p) =>
                  updateView(doc, view.id, { sorts: [{ propertyId: p.id, direction: 'asc' }] })
                }
              />
            ) : (
              <SortEditor
                sorts={view.sorts}
                properties={properties}
                onChange={(sorts) => updateView(doc, view.id, { sorts })}
              />
            )}
          </PopoverContent>
        </Popover>
        <Popover open={panel === 'group'} onOpenChange={(o) => !o && setPanel(null)}>
          <PopoverAnchor asChild>
            <button
              type="button"
              className={toolbarButton(view.groupBy !== null)}
              onClick={() => setPanel(panel === 'group' ? null : 'group')}
            >
              <Layers size={15} /> <span className="max-md:hidden">Group</span>
            </button>
          </PopoverAnchor>
          <PopoverContent align="end">
            <GroupEditor
              properties={properties}
              groupBy={view.groupBy}
              subGroupBy={view.subGroupBy}
              groups={result.groups}
              onChange={(changes) => updateView(doc, view.id, changes)}
            />
          </PopoverContent>
        </Popover>
        {search === null ? (
          <IconButton label="Search" onClick={() => setSearch('')}>
            <Search size={15} />
          </IconButton>
        ) : (
          <span className="flex h-7 items-center gap-1 rounded border border-line px-1.5">
            <Search size={14} className="text-faint" />
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setSearch(null);
              }}
              onBlur={() => !search && setSearch(null)}
              placeholder="Type to search…"
              aria-label="Search in view"
              className="w-36 bg-transparent text-sm outline-none"
            />
            <button type="button" aria-label="Clear search" onClick={() => setSearch(null)}>
              <X size={13} className="text-faint" />
            </button>
          </span>
        )}
        {editable && (
          <button
            type="button"
            onClick={() => open(addRow(doc, { actor: user.id }))}
            className="ml-1 flex h-7 items-center rounded-md bg-accent px-2.5 text-sm font-medium text-accent-fg hover:opacity-90"
          >
            New
          </button>
        )}
      </div>

      {/* Sorts and filters in effect */}
      {showBar && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-line py-1.5"
          data-testid="filter-bar"
        >
          {view.sorts.length > 0 && (
            <button
              type="button"
              data-testid="sort-chip"
              onClick={() => setPanel('sort')}
              className="flex h-6 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 text-xs text-accent"
            >
              {view.sorts[0]!.direction === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
              {view.sorts.length === 1 ? sortNames[0] : `${view.sorts.length} sorts`}
              <ChevronDown size={12} />
            </button>
          )}
          {view.sorts.length > 0 && ruleCount > 0 && <span className="mx-1 h-4 w-px bg-line" />}
          {advanced ? (
            <button
              type="button"
              data-testid="advanced-chip"
              onClick={() => setPanel('advanced')}
              className="flex h-6 items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 text-xs text-accent"
            >
              <ListFilter size={12} /> {ruleCount} rule{ruleCount === 1 ? '' : 's'}
              <ChevronDown size={12} />
            </button>
          ) : (
            view.filter?.filters.map((f) => {
              const property = f.type === 'rule' ? byId.get(f.propertyId) : undefined;
              if (f.type !== 'rule' || !property) return null;
              return (
                <RuleChip
                  key={f.id}
                  rule={f}
                  property={property}
                  ctx={viewCtx}
                  open={openChip === f.id}
                  onOpenChange={(o) => setOpenChip(o ? f.id : null)}
                  onChange={(rule: FilterRule) =>
                    setFilter(updateFilterTree(view.filter!, f.id, () => rule))
                  }
                  onDelete={() => {
                    setOpenChip(null);
                    setFilter(updateFilterTree(view.filter!, f.id, () => null));
                  }}
                  onAdvanced={() => {
                    setOpenChip(null);
                    setPanel('advanced');
                  }}
                />
              );
            })
          )}
          {ruleCount > 0 && !advanced && editable && (
            <button
              type="button"
              onClick={() => setPanel('filter')}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-xs text-muted hover:bg-hover"
            >
              <Plus size={12} /> Add filter
            </button>
          )}
        </div>
      )}

      {view.type === 'table' && (
        <TableView
          handle={handle}
          snapshot={snapshot}
          view={view}
          result={result}
          ctx={viewCtx}
          editable={editable}
          onOpenRow={open}
          onFilter={addFilter}
        />
      )}
      {view.type !== 'table' &&
        (() => {
          const props = {
            handle,
            snapshot,
            view,
            result,
            ctx: viewCtx,
            editable,
            onOpenRow: open,
          };
          if (view.type === 'board') return <BoardView {...props} />;
          if (view.type === 'list') return <ListView {...props} />;
          if (view.type === 'calendar') return <CalendarView {...props} />;
          if (view.type === 'timeline') return <TimelineView {...props} />;
          if (view.type === 'chart') {
            return (
              <Suspense fallback={<div className="h-[400px]" aria-busy="true" />}>
                <ChartView {...props} />
              </Suspense>
            );
          }
          return <GalleryView {...props} />;
        })()}
      {result.rows.length === 0 && (ruleCount > 0 || search) && (
        <p className="py-3 text-sm text-faint" data-testid="no-results">
          No results
        </p>
      )}
    </div>
  );
}

const previewKey = (p: CardPreview) =>
  p.kind === 'property' ? `property:${p.propertyId}` : p.kind;
const previewFromKey = (key: string): CardPreview =>
  key.startsWith('property:')
    ? { kind: 'property', propertyId: key.slice('property:'.length) }
    : { kind: key as 'none' | 'cover' | 'content' };
function previewLabel(p: CardPreview, files: { id: string; name: string }[]): string {
  if (p.kind === 'property') return files.find((f) => f.id === p.propertyId)?.name ?? 'None';
  return { none: 'None', cover: 'Page cover', content: 'Page content' }[p.kind];
}

function ViewMenu({
  view,
  editable,
  canDelete,
  columns,
  onChange,
  onToggleColumn,
  onDuplicate,
  onDelete,
  meta,
  onMeta,
  onLayout,
  filesProperties,
  dateProperties: dates,
  hasDependencies,
}: {
  /** Date properties calendars and timelines can be shown by. */
  dateProperties: { id: string; name: string; type: string }[];
  hasDependencies: boolean;
  onLayout(type: ViewType): void;
  /** Files properties a card preview can use. */
  filesProperties: { id: string; name: string }[];
  meta: DatabaseMeta;
  /** Turn sub-items or dependencies on, or off (optionally deleting their properties). */
  onMeta(feature: 'subItems' | 'dependencies', on: boolean, deleteProperties?: boolean): void;
  view: View;
  editable: boolean;
  canDelete: boolean;
  columns: {
    id: string;
    visible: boolean;
    property: { name: string; type: Parameters<typeof PropertyIcon>[0]['type'] };
  }[];
  onChange(changes: Partial<View>): void;
  onToggleColumn(id: string, visible: boolean): void;
  onDuplicate(): void;
  onDelete(): void;
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
          <ViewIcon type={view.type} /> {view.name}
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
          <MenuSubTrigger icon={<ViewIcon type={view.type} />}>
            <span className="flex-1">Layout</span>
            <span className="text-xs text-faint">
              {VIEW_TYPES.find((t) => t.type === view.type)?.label}
            </span>
          </MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup value={view.type} onValueChange={(t) => onLayout(t as ViewType)}>
              {VIEW_TYPES.map((t) => (
                <MenuRadioItem key={t.type} value={t.type}>
                  {t.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        {(view.type === 'board' || view.type === 'gallery') && (
          <>
            <MenuSub>
              <MenuSubTrigger icon={<ImageIcon size={14} />}>
                <span className="flex-1">Card preview</span>
                <span className="truncate text-xs text-faint">
                  {previewLabel(view.cardPreview, filesProperties)}
                </span>
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuRadioGroup
                  value={previewKey(view.cardPreview)}
                  onValueChange={(key) => onChange({ cardPreview: previewFromKey(key) })}
                >
                  <MenuRadioItem value="none">None</MenuRadioItem>
                  <MenuRadioItem value="cover">Page cover</MenuRadioItem>
                  <MenuRadioItem value="content">Page content</MenuRadioItem>
                  {filesProperties.map((p) => (
                    <MenuRadioItem key={p.id} value={`property:${p.id}`}>
                      {p.name}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuSubContent>
            </MenuSub>
            <MenuItem
              icon={<Maximize size={14} />}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ fitImage: !view.fitImage });
              }}
            >
              <span className="flex-1">Fit image</span>
              <span className={cn('text-xs', view.fitImage ? 'text-accent' : 'text-faint')}>
                {view.fitImage ? 'On' : 'Off'}
              </span>
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger icon={<Ruler size={14} />}>
                <span className="flex-1">Card size</span>
                <span className="text-xs text-faint capitalize">{view.cardSize}</span>
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuRadioGroup
                  value={view.cardSize}
                  onValueChange={(size) => onChange({ cardSize: size as CardSize })}
                >
                  <MenuRadioItem value="small">Small</MenuRadioItem>
                  <MenuRadioItem value="medium">Medium</MenuRadioItem>
                  <MenuRadioItem value="large">Large</MenuRadioItem>
                </MenuRadioGroup>
              </MenuSubContent>
            </MenuSub>
          </>
        )}
        {(view.type === 'calendar' || view.type === 'timeline') && (
          <MenuSub>
            <MenuSubTrigger icon={<CalendarDays size={14} />}>
              <span className="flex-1">
                {view.type === 'calendar' ? 'Show calendar by' : 'Show timeline by'}
              </span>
              <span className="truncate text-xs text-faint">
                {(dates.find((d) => d.id === view.dateProperty) ?? dates[0])?.name}
              </span>
            </MenuSubTrigger>
            <MenuSubContent>
              <MenuRadioGroup
                value={view.dateProperty ?? dates[0]?.id ?? ''}
                onValueChange={(id) => onChange({ dateProperty: id })}
              >
                {dates.map((d) => (
                  <MenuRadioItem key={d.id} value={d.id}>
                    {d.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
        )}
        {view.type === 'timeline' && (
          <MenuSub>
            <MenuSubTrigger icon={<CalendarDays size={14} />}>
              <span className="flex-1">End date</span>
              <span className="truncate text-xs text-faint">
                {dates.find((d) => d.id === view.endDateProperty)?.name ?? 'Same property'}
              </span>
            </MenuSubTrigger>
            <MenuSubContent>
              <MenuRadioGroup
                value={view.endDateProperty ?? ''}
                onValueChange={(id) => onChange({ endDateProperty: id || null })}
              >
                <MenuRadioItem value="">Same property</MenuRadioItem>
                {dates
                  .filter((d) => d.type === 'date' && d.id !== view.dateProperty)
                  .map((d) => (
                    <MenuRadioItem key={d.id} value={d.id}>
                      {d.name}
                    </MenuRadioItem>
                  ))}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
        )}
        {view.type === 'calendar' && (
          <MenuItem
            icon={<CalendarDays size={14} />}
            onSelect={(e) => {
              e.preventDefault();
              onChange({ weekStart: view.weekStart === 1 ? 0 : 1 });
            }}
          >
            <span className="flex-1">Start week on Monday</span>
            <span className={cn('text-xs', view.weekStart === 1 ? 'text-accent' : 'text-faint')}>
              {view.weekStart === 1 ? 'On' : 'Off'}
            </span>
          </MenuItem>
        )}
        {view.type === 'timeline' &&
          (
            [
              ['timelineTable', 'Show table'],
              ...(hasDependencies ? [['showDependencies', 'Show dependencies'] as const] : []),
            ] as const
          ).map(([key, label]) => (
            <MenuItem
              key={key}
              icon={<GanttChart size={14} />}
              onSelect={(e) => {
                e.preventDefault();
                onChange({ [key]: !view[key] });
              }}
            >
              <span className="flex-1">{label}</span>
              <span className={cn('text-xs', view[key] ? 'text-accent' : 'text-faint')}>
                {view[key] ? 'On' : 'Off'}
              </span>
            </MenuItem>
          ))}
        {view.type === 'board' && (
          <MenuItem
            icon={<Palette size={14} />}
            onSelect={(e) => {
              e.preventDefault();
              onChange({ colorColumns: !view.colorColumns });
            }}
          >
            <span className="flex-1">Color columns</span>
            <span className={cn('text-xs', view.colorColumns ? 'text-accent' : 'text-faint')}>
              {view.colorColumns ? 'On' : 'Off'}
            </span>
          </MenuItem>
        )}
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
        <MenuSeparator />
        {(
          [
            ['subItems', 'Sub-items', ListTree],
            ['dependencies', 'Dependencies', GitBranch],
          ] as const
        ).map(([feature, label, Icon]) =>
          meta[feature] ? (
            <MenuSub key={feature}>
              <MenuSubTrigger icon={<Icon size={14} />}>
                <span className="flex-1">{label}</span>
                <span className="text-xs text-accent">On</span>
              </MenuSubTrigger>
              <MenuSubContent>
                <MenuItem onSelect={() => onMeta(feature, false)}>
                  Turn off, keep properties
                </MenuItem>
                <MenuItem danger onSelect={() => onMeta(feature, false, true)}>
                  Turn off and delete properties
                </MenuItem>
              </MenuSubContent>
            </MenuSub>
          ) : (
            <MenuItem
              key={feature}
              icon={<Icon size={14} />}
              onSelect={() => onMeta(feature, true)}
            >
              <span className="flex-1">{label}</span>
              <span className="text-xs text-faint">Off</span>
            </MenuItem>
          ),
        )}
        <MenuSeparator />
        <MenuItem icon={<Copy size={14} />} onSelect={onDuplicate}>
          Duplicate view
        </MenuItem>
        {canDelete && (
          <MenuItem icon={<Trash2 size={14} />} danger onSelect={onDelete}>
            Delete view
          </MenuItem>
        )}
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
