import { pageUrl } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  PROPERTY_TYPES,
  addOption,
  addProperty,
  addRow,
  cellText,
  changePropertyType,
  duplicateProperty,
  relationIds,
  setRelation,
  moveRow,
  moveViewColumn,
  newPropertyName,
  propertyKind,
  renameProperty,
  NO_VALUE,
  calculate,
  calculationInfo,
  calculationsFor,
  effectiveType,
  DATE_FORMATS,
  NUMBER_FORMATS,
  TIME_FORMATS,
  setCell,
  setPropertyConfig,
  trashRow,
  type DatabaseMeta,
  updateView,
  updateViewColumn,
  viewColumns,
  type CalculationId,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type PropertyType,
  type Row,
  type View,
  type ViewGroup,
  type ViewResult,
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
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  EyeOff,
  GripVertical,
  Hash,
  Link2,
  ListFilter,
  Maximize2,
  Plus,
  Repeat2,
  Search,
  Sigma,
  CornerDownRight,
  ArrowUpRight,
  Trash2,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useApp } from '../context';
import {
  detachRelation,
  duplicateRowWithContent,
  newRow,
  removeProperty,
  writeCell,
} from './actions';
import { FormulaEditor } from './formula-editor';
import { RelationSetup, RollupSetup, type SetupRequest } from './relation-setup';
import {
  CellDisplay,
  OptionPill,
  PopoverCellEditor,
  PropertyIcon,
  TEXT_TYPES,
  TextCellEditor,
  isEditable,
  type EditExit,
} from './cells';

const ROW_HEIGHT = 33;
const MIN_WIDTH = 80;
const defaultWidth = (p: Property) => (p.type === 'title' ? 280 : 200);
/** Above this many rows, only the rows in view are rendered. */
const VIRTUALIZE_FROM = 100;

export interface TableViewProps {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  /** The view's rows (filtered, searched, sorted) and groups. */
  result: ViewResult;
  ctx: DisplayContext;
  editable: boolean;
  onOpenRow(rowId: string): void;
  /** Start a filter on a property (from its column menu). */
  onFilter(propertyId: string): void;
}

/** A property value shared by every row of a group (new rows in the group get it). */
interface GroupValue {
  propertyId: string;
  value: unknown;
}

/** One line of the table body. */
type Item =
  | { kind: 'group'; key: string; depth: number; group: ViewGroup; values: GroupValue[] }
  | {
      kind: 'row';
      key: string;
      depth: number;
      row: Row;
      values: GroupValue[];
      /** Sub-items: nesting level and number of sub-items shown under it. */
      nest?: { level: number; children: number };
    }
  | { kind: 'new'; key: string; depth: number; values: GroupValue[] }
  | { kind: 'calc'; key: string; depth: number; rows: Row[] };

const GROUP_HEIGHT = 41;

/**
 * Rows nested under their parent item (sub-items): a row whose parent isn't in the
 * view shows at the top level. Expanded rows list their sub-items under them.
 */
function nestedRows(
  rows: readonly Row[],
  parentId: string,
  expanded: ReadonlySet<string>,
): Extract<Item, { kind: 'row' }>[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string, Row[]>();
  const roots: Row[] = [];
  for (const row of rows) {
    const parent = relationIds(row.values[parentId])[0];
    if (parent && ids.has(parent) && parent !== row.id) {
      const list = children.get(parent) ?? [];
      list.push(row);
      children.set(parent, list);
    } else roots.push(row);
  }
  const out: Extract<Item, { kind: 'row' }>[] = [];
  const seen = new Set<string>();
  const add = (row: Row, level: number, prefix: string) => {
    if (seen.has(row.id)) return;
    seen.add(row.id);
    const key = `${prefix}/${row.id}`;
    const kids = children.get(row.id) ?? [];
    out.push({
      kind: 'row',
      key,
      depth: 0,
      row,
      values: [],
      nest: { level, children: kids.length },
    });
    if (expanded.has(row.id)) for (const kid of kids) add(kid, level + 1, key);
  };
  roots.forEach((row) => add(row, 0, ''));
  return out;
}

/** Flatten groups into lines: header, rows, "+ New", calculations; hidden groups left out. */
function buildItems(
  result: ViewResult,
  view: View,
  subItems: DatabaseMeta['subItems'],
  expanded: ReadonlySet<string>,
): Item[] {
  if (!result.groups && subItems) {
    return [
      ...nestedRows(result.rows, subItems.parentId, expanded),
      { kind: 'new', key: 'new:/', depth: 0, values: [] },
      { kind: 'calc', key: 'calc:/', depth: 0, rows: result.rows },
    ];
  }
  if (!result.groups) {
    return [
      ...result.rows.map((row) => ({
        kind: 'row' as const,
        key: `/${row.id}`,
        depth: 0,
        row,
        values: [],
      })),
      { kind: 'new', key: 'new:/', depth: 0, values: [] },
      { kind: 'calc', key: 'calc:/', depth: 0, rows: result.rows },
    ];
  }
  const items: Item[] = [];
  const levels = [view.groupBy, view.subGroupBy];
  const add = (groups: ViewGroup[], depth: number, parent: GroupValue[], path: string) => {
    for (const group of groups) {
      if (group.hidden) continue;
      const key = `${path}${group.info.key}/`;
      const values = [
        ...parent,
        { propertyId: levels[depth]!.propertyId, value: group.info.value },
      ];
      items.push({ kind: 'group', key: `group:${key}`, depth, group, values });
      if (group.collapsed) continue;
      if (group.subgroups) {
        add(group.subgroups, depth + 1, values, key);
        continue;
      }
      for (const row of group.rows) {
        items.push({ kind: 'row', key: `${key}${row.id}`, depth, row, values });
      }
      items.push({ kind: 'new', key: `new:${key}`, depth, values });
      items.push({ kind: 'calc', key: `calc:${key}`, depth, rows: group.rows });
    }
  };
  add(result.groups, 0, [], '/');
  return items;
}

interface CellRef {
  /** The row's line (a row can show in several groups). */
  key: string;
  rowId: string;
  propertyId: string;
}

interface Editing extends CellRef {
  initialText?: string;
}

export function TableView({
  handle,
  snapshot,
  view,
  result,
  ctx,
  editable,
  onOpenRow,
  onFilter,
}: TableViewProps) {
  const { user } = useApp();
  const doc = handle.doc;
  const gridRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [headerMenu, setHeaderMenu] = useState<string | null>(null);
  const [formulaFor, setFormulaFor] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupRequest | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggleExpanded = (id: string, open?: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const { databases, client } = useApp();
  const subItems = snapshot.meta.subItems;
  const [resizing, setResizing] = useState<{ id: string; width: number } | null>(null);

  const byId = useMemo(() => new Map(snapshot.properties.map((p) => [p.id, p])), [snapshot]);
  const columns = useMemo(
    () =>
      viewColumns(view, snapshot.properties)
        .filter((c) => c.visible)
        .map((c) => ({
          property: byId.get(c.id)!,
          width: c.width ?? defaultWidth(byId.get(c.id)!),
        })),
    [view, snapshot.properties, byId],
  );
  const widthOf = (id: string, width: number) => (resizing?.id === id ? resizing.width : width);
  const items = useMemo(
    () => buildItems(result, view, subItems, expanded),
    [result, view, subItems, expanded],
  );
  const rowItems = useMemo(
    () => items.filter((i): i is Extract<Item, { kind: 'row' }> => i.kind === 'row'),
    [items],
  );
  const totalWidth = columns.reduce((sum, c) => sum + widthOf(c.property.id, c.width), 0);

  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  // --- Selection and editing -------------------------------------------------------------

  const move = (from: CellRef, dRow: number, dCol: number) => {
    const r = rowItems.findIndex((item) => item.key === from.key);
    const c = columns.findIndex((col) => col.property.id === from.propertyId);
    const item = rowItems[Math.max(0, Math.min(rowItems.length - 1, r + dRow))];
    const col = columns[Math.max(0, Math.min(columns.length - 1, c + dCol))];
    if (item && col)
      setSelected({ key: item.key, rowId: item.row.id, propertyId: col.property.id });
  };

  const finishEdit = (cell: CellRef, exit: EditExit) => {
    setEditing(null);
    setSelected(cell);
    if (exit === 'down') move(cell, 1, 0);
    else if (exit === 'right') move(cell, 0, 1);
    else if (exit === 'left') move(cell, 0, -1);
    focusGrid();
  };

  const startEdit = (cell: CellRef, initialText?: string) => {
    const property = byId.get(cell.propertyId);
    const row = handle.row(cell.rowId);
    if (!editable || !property || !row) return;
    if (property.type === 'checkbox') {
      setCell(doc, row.id, property.id, row.values[property.id] !== true, user.id);
      return;
    }
    if (isEditable(property.type)) setEditing({ ...cell, initialText });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      if (event.shiftKey) handle.undo.redo();
      else handle.undo.undo();
      event.preventDefault();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      handle.undo.redo();
      event.preventDefault();
      return;
    }
    if (!selected || editing) return;
    const property = byId.get(selected.propertyId);
    const row = handle.row(selected.rowId);
    if (!property || !row) return;
    const keys: Record<string, () => void> = {
      ArrowUp: () => move(selected, -1, 0),
      ArrowDown: () => move(selected, 1, 0),
      ArrowLeft: () => move(selected, 0, -1),
      ArrowRight: () => move(selected, 0, 1),
      Tab: () => move(selected, 0, event.shiftKey ? -1 : 1),
      Enter: () => startEdit(selected),
      Escape: () => setSelected(null),
    };
    if (editable && !propertyKind(property.type).computed) {
      const clear = () =>
        writeCell(
          databases,
          handle,
          row.id,
          property,
          property.type === 'checkbox' ? false : null,
          user.id,
        );
      keys.Backspace = clear;
      keys.Delete = clear;
    }
    if (keys[event.key] && !mod) {
      keys[event.key]!();
      event.preventDefault();
      return;
    }
    if (
      !mod &&
      !event.altKey &&
      event.key.length === 1 &&
      editable &&
      (TEXT_TYPES.includes(property.type) ||
        ['select', 'multiSelect', 'status'].includes(property.type))
    ) {
      // Typing on a selected cell starts editing it, like a spreadsheet.
      event.preventDefault();
      startEdit(selected, event.key);
    }
  };

  const pasteInto = (row: Row, property: Property, text: string) => {
    const kind = propertyKind(property.type);
    if (kind.computed) return;
    const parsed = kind.parse(text, property, ctx);
    doc.transact(() => {
      for (const option of parsed.newOptions ?? []) addOption(doc, property.id, option);
      writeCell(
        databases,
        handle,
        row.id,
        property,
        property.type === 'title' ? text : parsed.value,
        user.id,
      );
    });
  };

  // Copy and paste arrive as events (the Edit menu owns Ctrl+C / Ctrl+V in Electron).
  useEffect(() => {
    const active = () => document.activeElement === gridRef.current && selected && !editing;
    const current = () => {
      const property = selected ? byId.get(selected.propertyId) : undefined;
      const row = selected ? handle.row(selected.rowId) : undefined;
      return property && row ? { property, row } : null;
    };
    const onCopy = (event: ClipboardEvent) => {
      const target = active() ? current() : null;
      if (!target) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', cellText(target.row, target.property, ctx));
    };
    const onPaste = (event: ClipboardEvent) => {
      const target = active() && editable ? current() : null;
      if (!target) return;
      event.preventDefault();
      pasteInto(target.row, target.property, event.clipboardData?.getData('text/plain') ?? '');
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  });

  /** Add a row (with its group's values) and start typing its title. */
  const addNewRow = (item: Extract<Item, { kind: 'new' }>) => {
    const values = Object.fromEntries(
      item.values.filter((v) => v.value !== undefined).map((v) => [v.propertyId, v.value]),
    );
    const id = newRow(client, handle, snapshot, view, { actor: user.id, values });
    const prefix = item.key.slice('new:'.length);
    setEditing({ key: `${prefix}${id}`, rowId: id, propertyId: TITLE_PROPERTY_ID });
  };

  /** Hide or collapse a group (saved in the view). */
  const updateGroupBy = (depth: number, key: string, field: 'hidden' | 'collapsed') => {
    const levelKey = depth === 0 ? 'groupBy' : 'subGroupBy';
    const groupBy = view[levelKey];
    if (!groupBy) return;
    const list = groupBy[field] ?? [];
    updateView(doc, view.id, {
      [levelKey]: {
        ...groupBy,
        [field]: list.includes(key) ? list.filter((k) => k !== key) : [...list, key],
      },
    });
  };

  // --- Virtual lines ---------------------------------------------------------------------

  const bodyRef = useRef<HTMLDivElement>(null);
  const virtual = rowItems.length >= VIRTUALIZE_FROM;
  const [scrollRoot, setScrollRoot] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useEffect(() => {
    if (!virtual) return;
    const body = bodyRef.current;
    const root = body?.closest<HTMLElement>('[data-scroll-root]');
    if (!body || !root) return;
    // Where the table body starts inside the scrolling page; changes when content
    // above it changes size.
    const measure = () => {
      setScrollRoot(root);
      setScrollMargin(
        body.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root.firstElementChild ?? root);
    return () => observer.disconnect();
  }, [virtual]);
  // The table isn't memoized by the compiler anyway; the virtualizer re-renders it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scrollRoot,
    estimateSize: (i) => (items[i]?.kind === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    overscan: 12,
    scrollMargin,
    getItemKey: (i) => items[i]?.key ?? i,
  });
  const visibleItems = virtual
    ? virtualizer.getVirtualItems().map((v) => ({ item: items[v.index]!, virtual: v }))
    : items.map((item) => ({ item, virtual: null }));

  // Keep the selected (or edited, e.g. a new row's title) cell in view.
  const focusCell = editing ?? selected;
  useEffect(() => {
    if (!focusCell) return;
    const index = items.findIndex((i) => i.key === focusCell.key);
    if (virtual && index >= 0) virtualizer.scrollToIndex(index);
    gridRef.current
      ?.querySelector(`[data-cell="${CSS.escape(`${focusCell.key}:${focusCell.propertyId}`)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusCell, items, virtual, virtualizer, scrollRoot, scrollMargin]);

  // --- Row drag and drop -----------------------------------------------------------------

  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<{ key: string; before: boolean } | null>(null);
  const grouped = result.groups !== null;
  // Without sorts rows can be reordered; in groups, dropping also moves a row to a group.
  const canDrag = editable && (view.sorts.length === 0 || grouped);
  const dropRowAt = (event: DragEvent<HTMLElement>, key: string) => {
    if (!dragRow) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (dropRow?.key !== key || dropRow.before !== before) setDropRow({ key, before });
  };
  const finishRowDrop = () => {
    const target = dropRow && rowItems.find((i) => i.key === dropRow.key);
    if (dragRow && dropRow && target) {
      doc.transact(() => {
        for (const { propertyId, value } of target.values) {
          if (value !== undefined) setCell(doc, dragRow, propertyId, value, user.id);
        }
        if (view.sorts.length === 0) {
          const at = rowItems.indexOf(target);
          const beforeId = dropRow.before ? target.row.id : (rowItems[at + 1]?.row.id ?? null);
          if (beforeId !== dragRow) moveRow(doc, dragRow, beforeId);
        }
      });
    }
    setDragRow(null);
    setDropRow(null);
  };

  // --- Column drag and drop --------------------------------------------------------------

  const [dragCol, setDragCol] = useState<string | null>(null);
  const [dropCol, setDropCol] = useState<{ id: string; before: boolean } | null>(null);
  const finishColDrop = () => {
    if (dragCol && dropCol) {
      const at = columns.findIndex((c) => c.property.id === dropCol.id);
      const beforeId = dropCol.before ? dropCol.id : (columns[at + 1]?.property.id ?? null);
      moveViewColumn(doc, view.id, dragCol, beforeId);
    }
    setDragCol(null);
    setDropCol(null);
  };

  const lastColumn = columns[columns.length - 1]?.property.id;
  const groupProperty = (depth: number) =>
    byId.get((depth === 0 ? view.groupBy : view.subGroupBy)?.propertyId ?? '');

  const renderItem = (item: Item) => {
    switch (item.kind) {
      case 'group':
        return (
          <GroupHeader
            group={item.group}
            property={groupProperty(item.depth)}
            depth={item.depth}
            editable={editable}
            onToggle={() => updateGroupBy(item.depth, item.group.info.key, 'collapsed')}
            onHide={() => updateGroupBy(item.depth, item.group.info.key, 'hidden')}
            onAdd={() =>
              addNewRow({
                kind: 'new',
                key: `new:${item.key.slice('group:'.length)}`,
                depth: item.depth,
                values: item.values,
              })
            }
          />
        );
      case 'new':
        return editable ? (
          <button
            type="button"
            onClick={() => addNewRow(item)}
            data-testid="table-new-row"
            className="flex h-[33px] w-full items-center gap-1.5 border-b border-line px-2 text-muted hover:bg-hover"
            style={{ width: totalWidth }}
          >
            <Plus size={14} /> New
          </button>
        ) : null;
      case 'calc':
        return (
          <div role="row" className="group/calc flex h-[33px]" data-testid="calc-row">
            {columns.map(({ property, width }) => (
              <CalcCell
                key={property.id}
                rows={item.rows}
                property={property}
                width={widthOf(property.id, width)}
                calc={view.calculations[property.id] ?? null}
                ctx={ctx}
                editable={editable && !snapshot.meta.lockViews}
                onChange={(calc) => {
                  const calculations = { ...view.calculations };
                  if (calc) calculations[property.id] = calc;
                  else delete calculations[property.id];
                  updateView(doc, view.id, { calculations });
                }}
              />
            ))}
          </div>
        );
      case 'row': {
        const { row } = item;
        return (
          <div
            role="row"
            data-testid="table-row"
            data-row-id={row.id}
            onDragOver={(e) => dropRowAt(e, item.key)}
            onDrop={finishRowDrop}
            className={cn(
              'group/row relative flex border-b border-line',
              dragRow === row.id && 'opacity-50',
            )}
          >
            {dropRow?.key === item.key && (
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none absolute inset-x-0 z-10 h-0.5 bg-accent',
                  dropRow.before ? '-top-px' : '-bottom-px',
                )}
              />
            )}
            <RowHandle
              handle={handle}
              row={row}
              editable={editable}
              onAddSubItem={
                subItems && editable && !grouped
                  ? () => {
                      const id = addRow(doc, { actor: user.id, afterId: row.id });
                      setRelation(
                        databases.resolveDoc,
                        handle.id,
                        id,
                        subItems.parentId,
                        [row.id],
                        user.id,
                      );
                      toggleExpanded(row.id, true);
                      setEditing({
                        key: `${item.key}/${id}`,
                        rowId: id,
                        propertyId: TITLE_PROPERTY_ID,
                      });
                    }
                  : undefined
              }
              draggable={canDrag}
              onOpen={() => onOpenRow(row.id)}
              onDragStart={() => setDragRow(row.id)}
              onDragEnd={() => {
                setDragRow(null);
                setDropRow(null);
              }}
            />
            {columns.map(({ property, width }) => {
              const cell = { key: item.key, rowId: row.id, propertyId: property.id };
              const isSelected = selected?.key === item.key && selected.propertyId === property.id;
              const isEditing = editing?.key === item.key && editing.propertyId === property.id;
              return (
                <Cell
                  key={property.id}
                  cellKey={`${item.key}:${property.id}`}
                  handle={handle}
                  row={row}
                  property={property}
                  ctx={ctx}
                  width={widthOf(property.id, width)}
                  wrap={view.wrap}
                  selected={isSelected}
                  editing={isEditing ? editing : null}
                  editable={editable}
                  onClick={() => {
                    setSelected(cell);
                    if (editable && !isEditing) startEdit(cell);
                    else focusGrid();
                  }}
                  onToggle={() => {
                    setSelected(cell);
                    startEdit(cell);
                    focusGrid();
                  }}
                  onDone={(exit) => finishEdit(cell, exit)}
                  onOpen={() => onOpenRow(row.id)}
                  nest={
                    property.type === 'title' && item.nest
                      ? {
                          ...item.nest,
                          expanded: expanded.has(row.id),
                          onToggle: () => toggleExpanded(row.id),
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        );
      }
    }
  };

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Table"
      aria-rowcount={rowItems.length + 1}
      tabIndex={0}
      data-testid="table-view"
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !editing)
          setSelected(null);
      }}
      className="relative -ml-8 overflow-x-auto pb-2 pl-8 text-sm outline-none"
    >
      <div style={{ width: totalWidth + 140 }}>
        {/* Header */}
        <div role="row" className="flex h-[33px] border-y border-line text-muted">
          {columns.map(({ property, width }) => (
            <HeaderCell
              key={property.id}
              handle={handle}
              property={property}
              view={view}
              ctx={ctx}
              width={widthOf(property.id, width)}
              editable={editable}
              locks={{ views: snapshot.meta.lockViews, properties: snapshot.meta.lockProperties }}
              menuOpen={headerMenu === property.id}
              onMenuOpenChange={(open) => setHeaderMenu(open ? property.id : null)}
              onResize={(w) => setResizing(w === null ? null : { id: property.id, width: w })}
              onResizeEnd={(w) => {
                setResizing(null);
                updateViewColumn(doc, view.id, property.id, { width: w });
              }}
              dragging={dragCol === property.id}
              drop={dropCol?.id === property.id ? (dropCol.before ? 'before' : 'after') : null}
              onDragStart={() => setDragCol(property.id)}
              onDragOver={(event) => {
                if (!dragCol || dragCol === property.id) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const before = event.clientX < rect.left + rect.width / 2;
                if (property.id === TITLE_PROPERTY_ID && before) return;
                if (dropCol?.id !== property.id || dropCol.before !== before) {
                  setDropCol({ id: property.id, before });
                }
              }}
              onDrop={finishColDrop}
              onDragEnd={() => {
                setDragCol(null);
                setDropCol(null);
              }}
              onInsert={(side) => {
                const index = columns.findIndex((c) => c.property.id === property.id);
                const afterId = side === 'right' ? property.id : columns[index - 1]?.property.id;
                const id = addProperty(doc, {
                  name: newPropertyName(doc),
                  type: 'text',
                  afterId: afterId ?? TITLE_PROPERTY_ID,
                });
                setHeaderMenu(id);
              }}
              onFilter={() => onFilter(property.id)}
              onEditFormula={() => setFormulaFor(property.id)}
              onSetup={setSetup}
            />
          ))}
          {editable && !snapshot.meta.lockProperties && (
            <AddPropertyButton
              onAdd={(type) => {
                // Relations are set up before they are added.
                if (type === 'relation') {
                  setSetup({ kind: 'relation', mode: 'add', afterId: lastColumn });
                  return;
                }
                const id = addProperty(doc, {
                  name: newPropertyName(doc, propertyKind(type).label),
                  type,
                  afterId: lastColumn,
                });
                // A new formula opens straight in the formula editor, as in Notion.
                if (type === 'formula') setFormulaFor(id);
                else if (type === 'rollup') setSetup({ kind: 'rollup', propertyId: id });
                else setHeaderMenu(id);
              }}
            />
          )}
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          role="rowgroup"
          className="relative"
          style={virtual ? { height: virtualizer.getTotalSize() } : undefined}
        >
          {visibleItems.map(({ item, virtual: v }) => (
            <div
              key={item.key}
              data-index={v?.index}
              ref={
                v && (view.wrap || item.kind === 'group') ? virtualizer.measureElement : undefined
              }
              className={v ? 'absolute top-0 left-0 w-full' : undefined}
              style={
                v
                  ? { transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }
                  : undefined
              }
            >
              {renderItem(item)}
            </div>
          ))}
        </div>
      </div>
      {setup?.kind === 'relation' && (
        <RelationSetup
          handle={handle}
          request={setup}
          ctx={ctx}
          onClose={() => {
            setSetup(null);
            focusGrid();
          }}
        />
      )}
      {setup?.kind === 'rollup' && (
        <RollupSetup
          handle={handle}
          properties={snapshot.properties}
          propertyId={setup.propertyId}
          onClose={() => {
            setSetup(null);
            focusGrid();
          }}
        />
      )}
      {formulaFor && byId.get(formulaFor) && (
        <FormulaEditor
          handle={handle}
          snapshot={snapshot}
          property={byId.get(formulaFor)!}
          row={result.rows[0]}
          ctx={ctx}
          onClose={() => {
            setFormulaFor(null);
            focusGrid();
          }}
        />
      )}
    </div>
  );
}

// --- Groups and calculations -------------------------------------------------------------

function GroupHeader({
  group,
  property,
  depth,
  editable,
  onToggle,
  onHide,
  onAdd,
}: {
  group: ViewGroup;
  property: Property | undefined;
  depth: number;
  editable: boolean;
  onToggle(): void;
  onHide(): void;
  onAdd(): void;
}) {
  const { info } = group;
  const isOption =
    info.color !== undefined ||
    property?.type === 'select' ||
    property?.type === 'multiSelect' ||
    property?.type === 'status';
  return (
    <div
      role="row"
      data-testid="group-header"
      data-group-key={info.key}
      className={cn('group/g flex h-[41px] items-center gap-1.5 text-sm', depth > 0 && 'pl-5')}
    >
      <IconButton
        label={group.collapsed ? 'Expand group' : 'Collapse group'}
        size="sm"
        onClick={onToggle}
      >
        <ChevronRight
          size={14}
          className={cn('transition-transform', !group.collapsed && 'rotate-90')}
        />
      </IconButton>
      <span className="flex min-w-0 items-center gap-2" data-testid="group-label">
        {isOption && info.key !== NO_VALUE ? (
          <OptionPill
            option={{ id: info.key, name: info.label, color: info.color ?? 'default' }}
            status={info.status}
          />
        ) : (
          <span className="truncate font-medium">{info.label}</span>
        )}
        <span className="text-faint" data-testid="group-count">
          {group.rows.length}
        </span>
      </span>
      {editable && (
        <span className="flex items-center opacity-0 group-hover/g:opacity-100">
          <IconButton label="Hide group" size="sm" onClick={onHide}>
            <EyeOff size={13} />
          </IconButton>
          {info.value !== undefined && (
            <IconButton label="New in group" size="sm" onClick={onAdd}>
              <Plus size={14} />
            </IconButton>
          )}
        </span>
      )}
    </div>
  );
}

function CalcCell({
  rows,
  property,
  width,
  calc,
  ctx,
  editable,
  onChange,
}: {
  rows: Row[];
  property: Property;
  width: number;
  calc: CalculationId | null;
  ctx: DisplayContext;
  editable: boolean;
  onChange(calc: CalculationId | null): void;
}) {
  const info = calc ? calculationInfo(effectiveType(property), calc) : undefined;
  const options = calculationsFor(effectiveType(property));
  const value = info ? calculate(rows, property, info.id, ctx) : '';
  return (
    <Menu>
      <MenuTrigger asChild disabled={!editable}>
        <button
          type="button"
          style={{ width }}
          data-testid="calc-cell"
          className={cn(
            'flex h-full shrink-0 items-center justify-end gap-1.5 px-2 text-xs text-faint hover:bg-hover',
            !info && 'opacity-0 group-hover/calc:opacity-100 data-[state=open]:opacity-100',
          )}
        >
          {info ? (
            <>
              <span className="uppercase">{info.short}</span>
              <span className="text-sm text-fg" data-testid="calc-value">
                {value || '—'}
              </span>
            </>
          ) : (
            <>
              Calculate <ChevronDown size={12} />
            </>
          )}
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="max-h-96 overflow-y-auto" data-testid="calc-menu">
        <MenuItem onSelect={() => onChange(null)}>None</MenuItem>
        {(['count', 'percent', 'more'] as const).map((group) => {
          const list = options.filter((o) => o.group === group);
          return list.length ? (
            <div key={group}>
              <MenuSeparator />
              {list.map((o) => (
                <MenuItem key={o.id} onSelect={() => onChange(o.id)}>
                  <span className="flex-1">{o.label}</span>
                  {o.id === calc && '✓'}
                </MenuItem>
              ))}
            </div>
          ) : null;
        })}
      </MenuContent>
    </Menu>
  );
}

// --- Cells -------------------------------------------------------------------------------

interface CellProps {
  /** Identifies the cell's line and column (for scrolling it into view). */
  cellKey: string;
  handle: DatabaseHandle;
  row: Row;
  property: Property;
  ctx: DisplayContext;
  width: number;
  wrap: boolean;
  selected: boolean;
  editing: Editing | null;
  editable: boolean;
  onClick(): void;
  onToggle(): void;
  onDone(exit: EditExit): void;
  onOpen(): void;
  /** Sub-items: indent the title and show a toggle. */
  nest?: { level: number; children: number; expanded: boolean; onToggle(): void };
}

function Cell(props: CellProps) {
  const { handle, row, property, ctx, width, wrap, selected, editing, onClick, onToggle } = props;
  const { platform } = useApp();
  const isTitle = property.type === 'title';
  const editorProps = {
    handle,
    row,
    property,
    ctx,
    initialText: editing?.initialText,
    onDone: props.onDone,
  };
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      data-cell={props.cellKey}
      data-testid="table-cell"
      onClick={onClick}
      style={{ width }}
      className={cn(
        'group/cell relative flex min-h-[33px] shrink-0 border-r border-line px-2 py-1.5 leading-5',
        !wrap && 'h-[33px] overflow-hidden',
        property.type === 'checkbox' ? 'items-center' : 'items-start',
        selected && !editing && 'shadow-[inset_0_0_0_2px_var(--ws-accent)]',
      )}
    >
      {isTitle ? (
        <span
          className="flex min-w-0 flex-1 items-start gap-1.5"
          style={props.nest ? { paddingLeft: props.nest.level * 20 } : undefined}
        >
          {props.nest && (
            <button
              type="button"
              aria-label={props.nest.expanded ? 'Collapse sub-items' : 'Expand sub-items'}
              aria-expanded={props.nest.expanded}
              onClick={(e) => {
                e.stopPropagation();
                props.nest!.onToggle();
              }}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover',
                props.nest.children === 0 && 'invisible',
              )}
            >
              {props.nest.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {row.icon && (
            <span className="flex h-5 shrink-0 items-center">
              <PageIcon icon={row.icon} size={16} fileUrl={platform.fileUrl} />
            </span>
          )}
          <span
            className={cn(
              'min-w-0 font-medium',
              wrap ? 'break-words whitespace-pre-wrap' : 'truncate',
            )}
            data-testid="row-title"
          >
            {row.title}
          </span>
          {props.nest && props.nest.children > 0 && (
            <span className="shrink-0 text-xs leading-5 text-faint" data-testid="sub-item-count">
              {props.nest.children}
            </span>
          )}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center">
          <CellDisplay row={row} property={property} ctx={ctx} wrap={wrap} onToggle={onToggle} />
        </span>
      )}
      {isTitle && !editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen();
          }}
          className="invisible absolute top-1 right-1 flex h-6 items-center gap-1 rounded border border-line bg-menu px-1.5 text-xs font-medium text-muted shadow-sm group-hover/row:visible hover:bg-hover"
        >
          <Maximize2 size={12} /> Open
        </button>
      )}
      {editing && TEXT_TYPES.includes(property.type) && (
        <div className="absolute top-0 left-0 z-20 min-w-full rounded-sm shadow-menu">
          <TextCellEditor {...editorProps} />
        </div>
      )}
      {editing && !TEXT_TYPES.includes(property.type) && (
        <PopoverCellEditor {...editorProps} anchor={<div className="absolute inset-0" />} />
      )}
    </div>
  );
}

// --- Row handle --------------------------------------------------------------------------

function RowHandle({
  handle,
  row,
  editable,
  draggable,
  onOpen,
  onDragStart,
  onDragEnd,
  onAddSubItem,
}: {
  handle: DatabaseHandle;
  row: Row;
  editable: boolean;
  draggable: boolean;
  onAddSubItem?: () => void;
  onOpen(): void;
  onDragStart(): void;
  onDragEnd(): void;
}) {
  const { client, user, databases } = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        'absolute top-1.5 -left-7 flex group-hover/row:visible',
        open ? 'visible' : 'invisible',
      )}
    >
      <Menu open={open} onOpenChange={setOpen} modal={false}>
        {/* Radix opens menus on pointerdown, which would fight with dragging, so the
            trigger is a passive anchor and the grip opens the menu on click. */}
        <MenuTrigger asChild>
          <span className="pointer-events-none absolute inset-0" aria-hidden />
        </MenuTrigger>
        {/* A div, not a button: Chromium won't start a native drag from a button. */}
        <div
          role="button"
          tabIndex={-1}
          aria-label="Drag to move, click to open menu"
          draggable={draggable}
          onClick={() => setOpen(true)}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', row.title);
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-faint hover:bg-hover"
        >
          <GripVertical size={14} />
        </div>
        <MenuContent side="left" align="start" data-testid="row-menu">
          <MenuItem icon={<Maximize2 size={14} />} onSelect={onOpen}>
            Open
          </MenuItem>
          {editable && (
            <MenuItem
              icon={<Copy size={14} />}
              onSelect={() =>
                void duplicateRowWithContent(client, databases, handle, row.id, user.id)
              }
            >
              Duplicate
            </MenuItem>
          )}
          {onAddSubItem && (
            <MenuItem icon={<CornerDownRight size={14} />} onSelect={onAddSubItem}>
              Add sub-item
            </MenuItem>
          )}
          <MenuItem
            icon={<Link2 size={14} />}
            onSelect={() => void navigator.clipboard.writeText(pageUrl(row.id))}
          >
            Copy link
          </MenuItem>
          {editable && (
            <>
              <MenuSeparator />
              <MenuItem
                icon={<Trash2 size={14} />}
                danger
                onSelect={() => trashRow(handle.doc, row.id)}
              >
                Delete
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
    </div>
  );
}

// --- Header ------------------------------------------------------------------------------

interface HeaderCellProps {
  handle: DatabaseHandle;
  property: Property;
  view: View;
  ctx: DisplayContext;
  width: number;
  editable: boolean;
  /** Locked views (no reorder, resize, hide, sort or filter) and properties (no edits). */
  locks: { views: boolean; properties: boolean };
  menuOpen: boolean;
  onMenuOpenChange(open: boolean): void;
  onResize(width: number | null): void;
  onResizeEnd(width: number): void;
  dragging: boolean;
  drop: 'before' | 'after' | null;
  onDragStart(): void;
  onDragOver(event: DragEvent<HTMLDivElement>): void;
  onDrop(): void;
  onDragEnd(): void;
  onInsert(side: 'left' | 'right'): void;
  onFilter(): void;
  onEditFormula(): void;
  onSetup(request: SetupRequest): void;
}

function HeaderCell(props: HeaderCellProps) {
  const { handle, property, view, ctx, width, editable, menuOpen, onMenuOpenChange } = props;
  const doc = handle.doc;
  const { databases } = useApp();
  const isTitle = property.type === 'title';
  const schema = !props.locks.properties;
  const viewOps = !props.locks.views;
  const missingTarget =
    property.type === 'relation' && !databases.exists(property.config.databaseId ?? '');
  const resize = useRef<{ x: number; width: number } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(property.name);
  // Focus the name field once the menu has opened (after Radix focuses the menu), so
  // typing renames right away.
  useEffect(() => {
    if (!menuOpen) return;
    const frame = requestAnimationFrame(() => {
      nameRef.current?.focus();
      nameRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [menuOpen]);
  const sort = (direction: 'asc' | 'desc') =>
    updateView(doc, view.id, { sorts: [{ propertyId: property.id, direction }] });

  return (
    <div
      role="columnheader"
      data-testid="column-header"
      data-property-id={property.id}
      style={{ width }}
      draggable={editable && viewOps && !isTitle}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', property.name);
        props.onDragStart();
      }}
      onDragOver={props.onDragOver}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
      className={cn('relative flex shrink-0 border-r border-line', props.dragging && 'opacity-50')}
    >
      {props.drop && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-accent',
            props.drop === 'before' ? '-left-px' : '-right-px',
          )}
        />
      )}
      <Menu
        open={menuOpen}
        onOpenChange={(open) => {
          if (open) setName(property.name);
          else if (schema && name.trim() && name !== property.name)
            renameProperty(doc, property.id, name.trim());
          onMenuOpenChange(open);
        }}
      >
        {/* Opened on click (not pointerdown) so headers can be dragged to reorder. */}
        <MenuTrigger asChild>
          <span className="pointer-events-none absolute inset-0" aria-hidden />
        </MenuTrigger>
        <button
          type="button"
          disabled={!editable || (!schema && !viewOps)}
          onClick={() => {
            setName(property.name);
            onMenuOpenChange(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left enabled:hover:bg-hover"
        >
          <PropertyIcon type={property.type} />
          <span className="truncate">{property.name}</span>
          {property.config.formulaError && (
            <span
              title={property.config.formulaError}
              className="shrink-0 text-danger"
              aria-label="Formula error"
            >
              <AlertCircle size={13} />
            </span>
          )}
          {missingTarget && (
            <span
              title="The related database no longer exists"
              className="shrink-0 text-danger"
              aria-label="Related database missing"
            >
              <AlertCircle size={13} />
            </span>
          )}
        </button>
        <MenuContent className="w-60" data-testid="property-menu">
          <div className="p-1" onKeyDown={(e) => e.stopPropagation()}>
            <input
              ref={nameRef}
              value={name}
              readOnly={!schema}
              aria-label="Property name"
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onMenuOpenChange(false);
                  if (name.trim() && name !== property.name) {
                    renameProperty(doc, property.id, name.trim());
                  }
                }
              }}
              className="h-7 w-full rounded border border-line bg-surface px-2 outline-none focus:border-accent"
            />
          </div>
          {!isTitle && schema && (
            <MenuSub>
              <MenuSubTrigger icon={<Repeat2 size={14} />}>
                <span className="flex-1">Type</span>
                <span className="text-xs text-faint">{propertyKind(property.type).label}</span>
              </MenuSubTrigger>
              <MenuSubContent className="max-h-96 overflow-y-auto">
                {PROPERTY_TYPES.map((type) => (
                  <MenuItem
                    key={type}
                    icon={<PropertyIcon type={type} />}
                    onSelect={() => {
                      if (type === property.type) return;
                      // A relation needs its database first: the setup dialog changes it.
                      if (type === 'relation') {
                        props.onSetup({
                          kind: 'relation',
                          mode: 'change',
                          propertyId: property.id,
                        });
                        return;
                      }
                      detachRelation(databases, handle, property);
                      changePropertyType(doc, property.id, type, ctx);
                      if (type === 'formula') props.onEditFormula();
                      if (type === 'rollup')
                        props.onSetup({ kind: 'rollup', propertyId: property.id });
                    }}
                  >
                    <span className="flex-1">{propertyKind(type).label}</span>
                    {type === property.type && '✓'}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          )}
          {property.type === 'formula' && schema && (
            <MenuItem icon={<Sigma size={14} />} onSelect={props.onEditFormula}>
              Edit formula
            </MenuItem>
          )}
          {property.type === 'relation' && schema && (
            <MenuItem
              icon={<ArrowUpRight size={14} />}
              onSelect={() =>
                props.onSetup({ kind: 'relation', mode: 'edit', propertyId: property.id })
              }
            >
              Edit relation
            </MenuItem>
          )}
          {property.type === 'rollup' && schema && (
            <MenuItem
              icon={<Search size={14} />}
              onSelect={() => props.onSetup({ kind: 'rollup', propertyId: property.id })}
            >
              Edit rollup
            </MenuItem>
          )}
          {schema && <PropertyFormatMenu handle={handle} property={property} />}
          {viewOps && (
            <>
              <MenuSeparator />
              <MenuItem icon={<ListFilter size={14} />} onSelect={props.onFilter}>
                Filter
              </MenuItem>
              <MenuItem icon={<ArrowUp size={14} />} onSelect={() => sort('asc')}>
                Sort ascending
              </MenuItem>
              <MenuItem icon={<ArrowDown size={14} />} onSelect={() => sort('desc')}>
                Sort descending
              </MenuItem>
              {!isTitle && (
                <MenuItem
                  icon={<EyeOff size={14} />}
                  onSelect={() => updateViewColumn(doc, view.id, property.id, { visible: false })}
                >
                  Hide in view
                </MenuItem>
              )}
            </>
          )}
          {schema && <MenuSeparator />}
          {!isTitle && schema && (
            <MenuItem icon={<ArrowLeftToLine size={14} />} onSelect={() => props.onInsert('left')}>
              Insert left
            </MenuItem>
          )}
          {schema && (
            <MenuItem
              icon={<ArrowRightToLine size={14} />}
              onSelect={() => props.onInsert('right')}
            >
              Insert right
            </MenuItem>
          )}
          {!isTitle && schema && (
            <>
              <MenuItem
                icon={<Copy size={14} />}
                onSelect={() => duplicateProperty(doc, property.id)}
              >
                Duplicate property
              </MenuItem>
              <MenuItem
                icon={<Trash2 size={14} />}
                danger
                onSelect={() => removeProperty(databases, handle, property)}
              >
                Delete property
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      {editable && viewOps && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={`Resize ${property.name}`}
          className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize hover:bg-accent/40"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            resize.current = { x: e.clientX, width };
          }}
          onPointerMove={(e) => {
            if (!resize.current) return;
            props.onResize(
              Math.max(MIN_WIDTH, resize.current.width + e.clientX - resize.current.x),
            );
          }}
          onPointerUp={(e) => {
            if (!resize.current) return;
            const w = Math.max(MIN_WIDTH, resize.current.width + e.clientX - resize.current.x);
            resize.current = null;
            props.onResizeEnd(Math.round(w));
          }}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
    </div>
  );
}

function AddPropertyButton({ onAdd }: { onAdd(type: PropertyType): void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton label="Add a property" className="m-0.5 size-7">
          <Plus size={16} />
        </IconButton>
      </MenuTrigger>
      <MenuContent
        className="max-h-96 w-56 overflow-y-auto"
        data-testid="add-property-menu"
        // The new property's menu opens next; don't pull focus back to this button.
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <p className="px-2 py-1 text-xs text-muted">Type</p>
        {PROPERTY_TYPES.map((type) => (
          <MenuItem key={type} icon={<PropertyIcon type={type} />} onSelect={() => onAdd(type)}>
            {propertyKind(type).label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

/** Format settings in a column menu: number and date formats, ID prefix. */
function PropertyFormatMenu({ handle, property }: { handle: DatabaseHandle; property: Property }) {
  const set = (changes: Partial<Property['config']>) =>
    setPropertyConfig(handle.doc, property.id, { ...property.config, ...changes });
  const radio = <T extends string>(
    label: string,
    icon: ReactNode,
    value: T,
    options: { id: T; label: string }[],
    onChange: (value: T) => void,
  ) => (
    <MenuSub>
      <MenuSubTrigger icon={icon}>
        <span className="flex-1">{label}</span>
        <span className="text-xs text-faint">{options.find((o) => o.id === value)?.label}</span>
      </MenuSubTrigger>
      <MenuSubContent className="max-h-96 overflow-y-auto">
        <MenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
          {options.map((o) => (
            <MenuRadioItem key={o.id} value={o.id}>
              {o.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuSubContent>
    </MenuSub>
  );

  const type = effectiveType(property);
  if (type === 'number') {
    return radio(
      'Number format',
      <Hash size={14} />,
      property.config.numberFormat ?? 'number',
      NUMBER_FORMATS,
      (numberFormat) => set({ numberFormat }),
    );
  }
  if (['date', 'createdTime', 'lastEditedTime'].includes(type)) {
    return (
      <>
        {radio(
          'Date format',
          <Calendar size={14} />,
          property.config.dateFormat ?? 'full',
          DATE_FORMATS,
          (dateFormat) => set({ dateFormat }),
        )}
        {radio(
          'Time format',
          <Clock size={14} />,
          property.config.timeFormat ?? '12h',
          TIME_FORMATS,
          (timeFormat) => set({ timeFormat }),
        )}
      </>
    );
  }
  if (property.type === 'uniqueId') {
    return (
      <PrefixInput value={property.config.prefix ?? ''} onChange={(prefix) => set({ prefix })} />
    );
  }
  return null;
}

function PrefixInput({ value, onChange }: { value: string; onChange(prefix: string): void }) {
  const [text, setText] = useState(value);
  return (
    <div className="p-1" onKeyDown={(e) => e.stopPropagation()}>
      <input
        value={text}
        placeholder="ID prefix, e.g. TASK"
        aria-label="ID prefix"
        onChange={(e) => setText(e.target.value.replace(/[^\w]/g, '').toUpperCase())}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onChange(text);
        }}
        className="h-7 w-full rounded border border-line bg-surface px-2 outline-none focus:border-accent"
      />
    </div>
  );
}
