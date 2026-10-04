import { pageUrl } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  PROPERTY_TYPES,
  addOption,
  addProperty,
  addRow,
  cellText,
  changePropertyType,
  deleteProperty,
  duplicateProperty,
  moveRow,
  moveViewColumn,
  newPropertyName,
  propertyKind,
  renameProperty,
  runView,
  setCell,
  trashRow,
  updateView,
  updateViewColumn,
  viewColumns,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type PropertyType,
  type Row,
  type View,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import {
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  cn,
} from '@workspace/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Copy,
  EyeOff,
  GripVertical,
  Link2,
  Maximize2,
  Plus,
  Repeat2,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useApp } from '../context';
import { duplicateRowWithContent } from './actions';
import {
  CellDisplay,
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
  ctx: DisplayContext;
  editable: boolean;
  onOpenRow(rowId: string): void;
}

interface CellRef {
  rowId: string;
  propertyId: string;
}

interface Editing extends CellRef {
  initialText?: string;
}

export function TableView({ handle, snapshot, view, ctx, editable, onOpenRow }: TableViewProps) {
  const { user } = useApp();
  const doc = handle.doc;
  const gridRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [headerMenu, setHeaderMenu] = useState<string | null>(null);
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
  const rows = useMemo(() => runView(snapshot, view, ctx).rows, [snapshot, view, ctx]);
  const totalWidth = columns.reduce((sum, c) => sum + widthOf(c.property.id, c.width), 0);

  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  // --- Selection and editing -------------------------------------------------------------

  const move = (from: CellRef, dRow: number, dCol: number) => {
    const r = rows.findIndex((row) => row.id === from.rowId);
    const c = columns.findIndex((col) => col.property.id === from.propertyId);
    const row = rows[Math.max(0, Math.min(rows.length - 1, r + dRow))];
    const col = columns[Math.max(0, Math.min(columns.length - 1, c + dCol))];
    if (row && col) setSelected({ rowId: row.id, propertyId: col.property.id });
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
        setCell(doc, row.id, property.id, property.type === 'checkbox' ? false : null, user.id);
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
      setCell(doc, row.id, property.id, property.type === 'title' ? text : parsed.value, user.id);
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

  const addNewRow = () => {
    const id = addRow(doc, { actor: user.id });
    setEditing({ rowId: id, propertyId: TITLE_PROPERTY_ID });
  };

  // --- Virtual rows ----------------------------------------------------------------------

  const bodyRef = useRef<HTMLDivElement>(null);
  const virtual = rows.length >= VIRTUALIZE_FROM;
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
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRoot,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    scrollMargin,
    getItemKey: (i) => rows[i]?.id ?? i,
  });
  const visibleRows = virtual
    ? virtualizer.getVirtualItems().map((item) => ({ row: rows[item.index]!, item }))
    : rows.map((row) => ({ row, item: null }));

  // Keep the selected (or edited, e.g. a new row's title) cell in view.
  const focusCell = editing ?? selected;
  useEffect(() => {
    if (!focusCell) return;
    const index = rows.findIndex((r) => r.id === focusCell.rowId);
    if (virtual && index >= 0) virtualizer.scrollToIndex(index);
    gridRef.current
      ?.querySelector(`[data-cell="${focusCell.rowId}:${focusCell.propertyId}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusCell, rows, virtual, virtualizer, scrollRoot, scrollMargin]);

  // --- Row drag and drop -----------------------------------------------------------------

  const [dragRow, setDragRow] = useState<string | null>(null);
  const [dropRow, setDropRow] = useState<{ id: string; before: boolean } | null>(null);
  const canReorder = editable && view.sorts.length === 0;
  const dropRowAt = (event: DragEvent<HTMLElement>, id: string) => {
    if (!dragRow || dragRow === id) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    if (dropRow?.id !== id || dropRow.before !== before) setDropRow({ id, before });
  };
  const finishRowDrop = () => {
    if (dragRow && dropRow) {
      const at = rows.findIndex((r) => r.id === dropRow.id);
      const beforeId = dropRow.before ? dropRow.id : (rows[at + 1]?.id ?? null);
      if (beforeId !== dragRow) moveRow(doc, dragRow, beforeId);
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

  return (
    <div
      ref={gridRef}
      role="grid"
      aria-label="Table"
      aria-rowcount={rows.length + 1}
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
            />
          ))}
          {editable && (
            <AddPropertyButton
              onAdd={(type) => {
                const id = addProperty(doc, {
                  name: newPropertyName(doc, propertyKind(type).label),
                  type,
                  afterId: lastColumn,
                });
                setHeaderMenu(id);
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
          {visibleRows.map(({ row, item }) => (
            <div
              key={row.id}
              role="row"
              data-testid="table-row"
              data-row-id={row.id}
              data-index={item?.index}
              ref={view.wrap && item ? virtualizer.measureElement : undefined}
              onDragOver={(e) => dropRowAt(e, row.id)}
              onDrop={finishRowDrop}
              className={cn(
                'group/row flex border-b border-line',
                virtual ? 'absolute top-0 left-0 w-full' : 'relative',
                dragRow === row.id && 'opacity-50',
              )}
              style={
                item
                  ? { transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)` }
                  : undefined
              }
            >
              {dropRow?.id === row.id && (
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
                draggable={canReorder}
                onOpen={() => onOpenRow(row.id)}
                onDragStart={() => setDragRow(row.id)}
                onDragEnd={() => {
                  setDragRow(null);
                  setDropRow(null);
                }}
              />
              {columns.map(({ property, width }) => {
                const cell = { rowId: row.id, propertyId: property.id };
                const isSelected =
                  selected?.rowId === row.id && selected.propertyId === property.id;
                const isEditing = editing?.rowId === row.id && editing.propertyId === property.id;
                return (
                  <Cell
                    key={property.id}
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
                  />
                );
              })}
            </div>
          ))}
        </div>

        {editable && (
          <button
            type="button"
            onClick={addNewRow}
            className="flex h-[33px] w-full items-center gap-1.5 border-b border-line px-2 text-muted hover:bg-hover"
            style={{ width: totalWidth }}
          >
            <Plus size={14} /> New
          </button>
        )}
      </div>
    </div>
  );
}

// --- Cells -------------------------------------------------------------------------------

interface CellProps {
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
      data-cell={`${row.id}:${property.id}`}
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
        <span className="flex min-w-0 flex-1 items-start gap-1.5">
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
}: {
  handle: DatabaseHandle;
  row: Row;
  editable: boolean;
  draggable: boolean;
  onOpen(): void;
  onDragStart(): void;
  onDragEnd(): void;
}) {
  const { client, user } = useApp();
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
              onSelect={() => void duplicateRowWithContent(client, handle, row.id, user.id)}
            >
              Duplicate
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
}

function HeaderCell(props: HeaderCellProps) {
  const { handle, property, view, ctx, width, editable, menuOpen, onMenuOpenChange } = props;
  const doc = handle.doc;
  const isTitle = property.type === 'title';
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
      draggable={editable && !isTitle}
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
          else if (name.trim() && name !== property.name)
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
          disabled={!editable}
          onClick={() => {
            setName(property.name);
            onMenuOpenChange(true);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left enabled:hover:bg-hover"
        >
          <PropertyIcon type={property.type} />
          <span className="truncate">{property.name}</span>
        </button>
        <MenuContent
          className="w-60"
          data-testid="property-menu"
        >
          <div className="p-1" onKeyDown={(e) => e.stopPropagation()}>
            <input
              ref={nameRef}
              value={name}
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
          {!isTitle && (
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
                    onSelect={() => changePropertyType(doc, property.id, type, ctx)}
                  >
                    <span className="flex-1">{propertyKind(type).label}</span>
                    {type === property.type && '✓'}
                  </MenuItem>
                ))}
              </MenuSubContent>
            </MenuSub>
          )}
          <MenuSeparator />
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
          <MenuSeparator />
          {!isTitle && (
            <MenuItem icon={<ArrowLeftToLine size={14} />} onSelect={() => props.onInsert('left')}>
              Insert left
            </MenuItem>
          )}
          <MenuItem icon={<ArrowRightToLine size={14} />} onSelect={() => props.onInsert('right')}>
            Insert right
          </MenuItem>
          {!isTitle && (
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
                onSelect={() => deleteProperty(doc, property.id)}
              >
                Delete property
              </MenuItem>
            </>
          )}
        </MenuContent>
      </Menu>
      {editable && (
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
