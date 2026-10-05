import {
  NO_VALUE,
  addRow,
  boardLayout,
  groupMoveValue,
  moveRow,
  moveRowAfter,
  type BoardColumn,
  type BoardLane,
  type GroupInfo,
  type Property,
  type Row,
} from '@workspace/database';
import { IconButton, Menu, MenuContent, MenuItem, MenuTrigger, cn } from '@workspace/ui';
import { ChevronRight, ChevronsLeftRight, Eye, EyeOff, MoreHorizontal, Plus } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useApp } from '../context';
import { writeCell } from './actions';
import {
  Card,
  GroupLabel,
  groupValues,
  shownProperties,
  toggleGroupKey,
  type LayoutViewProps,
} from './cards';
import { usePageVirtualizer } from './virtual';

const COLUMN_WIDTH = { small: 220, medium: 260, large: 310 } as const;
/** Above this many cards, a column only renders the cards in view. */
const VIRTUALIZE_FROM = 50;

interface Drag {
  rowId: string;
  column: GroupInfo;
  lane: GroupInfo | null;
}

interface Drop {
  column: string;
  lane: string | null;
  /** Insert before this card; `null` for the end of the column. */
  beforeId: string | null;
}

const tint = (info: GroupInfo, on: boolean) =>
  on && info.color && info.color !== 'default'
    ? { backgroundColor: `color-mix(in srgb, var(--ws-${info.color}) 7%, transparent)` }
    : undefined;

/** Board: a column per group (and a swimlane per sub-group); drag cards between them. */
export function BoardView(props: LayoutViewProps) {
  const { handle, snapshot, view, result, ctx, editable, onOpenRow } = props;
  const { user, databases } = useApp();
  const doc = handle.doc;
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  const groupProperty = byId.get(view.groupBy?.propertyId ?? '');
  const laneProperty = byId.get(view.subGroupBy?.propertyId ?? '');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [editingTitle, setEditingTitle] = useState<string | null>(null);

  if (!groupProperty || !result.groups) {
    return (
      <p className="py-6 text-sm text-muted" data-testid="board-view">
        Choose a property to group the board by (Group in the toolbar).
      </p>
    );
  }
  const layout = boardLayout(result, snapshot, view, ctx);
  const columns = layout.columns.filter((c) => !c.hidden);
  const hiddenColumns = layout.columns.filter((c) => c.hidden);
  const lanes = layout.lanes.filter((l) => !l.hidden);
  const width = COLUMN_WIDTH[view.cardSize];
  const properties = shownProperties(view, snapshot);
  const canReorder = view.sorts.length === 0;

  const addCard = (column: GroupInfo, lane: GroupInfo | null) => {
    const id = addRow(doc, { actor: user.id, values: groupValues(view, [column, lane]) });
    setEditingTitle(id);
  };

  const finishDrop = (cards: Row[]) => {
    const target = drop;
    setDrag(null);
    setDrop(null);
    if (!drag || !target) return;
    const row = snapshot.rows.find((r) => r.id === drag.rowId);
    const toColumn = layout.columns.find((c) => c.info.key === target.column)?.info;
    if (!row || !toColumn) return;
    const toLane = layout.lanes.find((l) => l.info?.key === target.lane)?.info ?? null;
    doc.transact(() => {
      if (toColumn.key !== drag.column.key) {
        const value = groupMoveValue(row, groupProperty, drag.column, toColumn);
        if (value !== undefined)
          writeCell(databases, handle, row.id, groupProperty, value, user.id);
      }
      if (laneProperty && toLane && toLane.key !== drag.lane?.key) {
        const value = groupMoveValue(row, laneProperty, drag.lane, toLane);
        if (value !== undefined) writeCell(databases, handle, row.id, laneProperty, value, user.id);
      }
      if (!canReorder) return;
      const others = cards.filter((c) => c.id !== row.id);
      if (target.beforeId && target.beforeId !== row.id) moveRow(doc, row.id, target.beforeId);
      else if (!target.beforeId && others.length)
        moveRowAfter(doc, row.id, others[others.length - 1]!.id);
    });
  };

  const header = (column: BoardColumn, count: number) => (
    <div
      className="group/col flex h-9 items-center gap-1.5 px-1 text-sm"
      data-testid="board-column-header"
    >
      <span className="flex min-w-0 items-center gap-2">
        <GroupLabel info={column.info} property={groupProperty} />
        <span className="text-faint" data-testid="group-count">
          {count}
        </span>
      </span>
      <span className="ml-auto flex items-center opacity-0 group-hover/col:opacity-100 focus-within:opacity-100">
        {editable && (
          <Menu>
            <MenuTrigger asChild>
              <IconButton label={`${column.info.label} options`} size="sm">
                <MoreHorizontal size={14} />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem
                icon={<ChevronsLeftRight size={14} />}
                onSelect={() => toggleGroupKey(handle, view, 0, column.info.key, 'collapsed')}
              >
                Collapse column
              </MenuItem>
              <MenuItem
                icon={<EyeOff size={14} />}
                onSelect={() => toggleGroupKey(handle, view, 0, column.info.key, 'hidden')}
              >
                Hide column
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
        {editable && column.info.value !== undefined && lanes.length <= 1 && (
          <IconButton
            label="New in group"
            size="sm"
            onClick={() => addCard(column.info, lanes[0]?.info ?? null)}
          >
            <Plus size={14} />
          </IconButton>
        )}
      </span>
    </div>
  );

  const cellFor = (lane: BoardLane, column: BoardColumn) => {
    const cards = lane.cells.get(column.info.key) ?? [];
    return (
      <BoardCell
        key={column.info.key}
        lane={lane}
        column={column}
        cards={cards}
        width={width}
        props={props}
        properties={properties}
        editable={editable}
        drag={drag}
        drop={drop}
        editingTitle={editingTitle}
        onTitleDone={() => setEditingTitle(null)}
        onOpen={onOpenRow}
        onDragStart={(rowId) => setDrag({ rowId, column: column.info, lane: lane.info })}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        onDropAt={(beforeId) => {
          const next = { column: column.info.key, lane: lane.info?.key ?? null, beforeId };
          if (
            drop?.column !== next.column ||
            drop.lane !== next.lane ||
            drop.beforeId !== beforeId
          ) {
            setDrop(next);
          }
        }}
        onDrop={() => finishDrop(cards)}
        onAdd={
          editable &&
          column.info.value !== undefined &&
          (!laneProperty || lane.info?.value !== undefined)
            ? () => addCard(column.info, lane.info)
            : undefined
        }
      />
    );
  };

  const collapsed = (column: BoardColumn, count: number) => (
    <button
      key={column.info.key}
      type="button"
      data-testid="board-column-collapsed"
      onClick={() => toggleGroupKey(handle, view, 0, column.info.key, 'collapsed')}
      title={`Expand ${column.info.label}`}
      style={tint(column.info, view.colorColumns)}
      className="flex w-10 shrink-0 flex-col items-center gap-2 self-start rounded-md py-2 text-sm hover:bg-hover"
    >
      <span className="[writing-mode:vertical-rl]">
        <GroupLabel info={column.info} property={groupProperty} />
      </span>
      <span className="text-faint">{count}</span>
    </button>
  );

  const columnCount = (column: BoardColumn) =>
    layout.lanes.reduce((n, l) => n + (l.cells.get(column.info.key)?.length ?? 0), 0);

  return (
    <div className="overflow-x-auto pb-4" data-testid="board-view">
      <div className="inline-flex min-w-full flex-col gap-2 pt-2">
        {/* Column headers */}
        <div className="flex gap-3">
          {columns.map((column) =>
            column.collapsed ? (
              <div key={column.info.key} className="w-10 shrink-0" />
            ) : (
              <div
                key={column.info.key}
                style={{ width, ...tint(column.info, view.colorColumns) }}
                className="shrink-0 rounded-t-md"
                data-testid="board-column"
                data-group-key={column.info.key}
              >
                {header(column, columnCount(column))}
              </div>
            ),
          )}
          {hiddenColumns.length > 0 && (
            <div className="w-52 shrink-0 px-1 text-sm" data-testid="hidden-columns">
              <p className="flex h-9 items-center text-muted">Hidden groups</p>
              {hiddenColumns.map((column) => (
                <button
                  key={column.info.key}
                  type="button"
                  disabled={!editable}
                  onClick={() => toggleGroupKey(handle, view, 0, column.info.key, 'hidden')}
                  className="group/h flex h-8 w-full items-center gap-2 rounded px-1 hover:bg-hover"
                >
                  <GroupLabel info={column.info} property={groupProperty} />
                  <span className="text-faint">{columnCount(column)}</span>
                  <Eye
                    size={13}
                    aria-label={`Show ${column.info.label}`}
                    className="ml-auto text-muted opacity-0 group-hover/h:opacity-100"
                  />
                </button>
              ))}
            </div>
          )}
        </div>

        {lanes.map((lane) => (
          <div
            key={lane.info?.key ?? 'all'}
            data-testid="board-lane"
            data-lane-key={lane.info?.key}
          >
            {lane.info && (
              <div className="flex h-9 items-center gap-1.5 text-sm" data-testid="lane-header">
                <IconButton
                  label={lane.collapsed ? 'Expand group' : 'Collapse group'}
                  size="sm"
                  onClick={() => toggleGroupKey(handle, view, 1, lane.info!.key, 'collapsed')}
                >
                  <ChevronRight
                    size={14}
                    className={cn('transition-transform', !lane.collapsed && 'rotate-90')}
                  />
                </IconButton>
                <GroupLabel info={lane.info} property={laneProperty} />
                <span className="text-faint">{lane.count}</span>
                {editable && (
                  <IconButton
                    label="Hide group"
                    size="sm"
                    onClick={() => toggleGroupKey(handle, view, 1, lane.info!.key, 'hidden')}
                  >
                    <EyeOff size={13} />
                  </IconButton>
                )}
              </div>
            )}
            {!lane.collapsed && (
              <div className="flex items-start gap-3">
                {columns.map((column) =>
                  column.collapsed ? (
                    lane === lanes[0] ? (
                      collapsed(column, columnCount(column))
                    ) : (
                      <div key={column.info.key} className="w-10 shrink-0" />
                    )
                  ) : (
                    cellFor(lane, column)
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One column of one lane: its cards (virtualized when long) and "+ New". */
function BoardCell({
  lane,
  column,
  cards,
  width,
  props,
  properties,
  editable,
  drag,
  drop,
  editingTitle,
  onTitleDone,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropAt,
  onDrop,
  onAdd,
}: {
  lane: BoardLane;
  column: BoardColumn;
  cards: Row[];
  width: number;
  props: LayoutViewProps;
  properties: Property[];
  editable: boolean;
  drag: Drag | null;
  drop: Drop | null;
  editingTitle: string | null;
  onTitleDone(): void;
  onOpen(rowId: string): void;
  onDragStart(rowId: string): void;
  onDragEnd(): void;
  onDropAt(beforeId: string | null): void;
  onDrop(): void;
  onAdd?: () => void;
}) {
  const { view } = props;
  const virtual = cards.length >= VIRTUALIZE_FROM;
  const { bodyRef, virtualizer } = usePageVirtualizer({
    count: cards.length,
    enabled: virtual,
    estimateSize: () => 44 + properties.length * 22 + (view.cardPreview.kind === 'none' ? 0 : 150),
    getItemKey: (i) => cards[i]?.id ?? i,
  });
  const here = drop?.column === column.info.key && drop.lane === (lane.info?.key ?? null);
  const indicator = (
    <div aria-hidden className="h-0.5 rounded bg-accent" data-testid="drop-indicator" />
  );
  const onCardOver = (event: DragEvent<HTMLElement>, index: number) => {
    if (!drag) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    onDropAt(before ? cards[index]!.id : (cards[index + 1]?.id ?? null));
  };
  const card = (row: Row, index: number) => (
    <div key={row.id} onDragOver={(e) => onCardOver(e, index)} className="flex flex-col gap-2">
      {here && drop.beforeId === row.id && indicator}
      <Card
        handle={props.handle}
        snapshot={props.snapshot}
        view={view}
        row={row}
        properties={properties}
        ctx={props.ctx}
        layout="board"
        editingTitle={editingTitle === row.id}
        onTitleDone={onTitleDone}
        onOpen={() => onOpen(row.id)}
        draggable={editable}
        dragging={drag?.rowId === row.id}
        onDragStart={() => onDragStart(row.id)}
        onDragEnd={onDragEnd}
      />
    </div>
  );
  return (
    <div
      data-testid="board-cell"
      data-group-key={column.info.key}
      style={{ width, ...tint(column.info, view.colorColumns) }}
      onDragOver={(e) => {
        if (!drag) return;
        e.preventDefault();
        onDropAt(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className="flex min-h-16 shrink-0 flex-col gap-2 rounded-b-md p-1"
    >
      {virtual ? (
        <div ref={bodyRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((v) => (
            <div
              key={v.key}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${v.start - virtualizer.options.scrollMargin}px)` }}
            >
              {card(cards[v.index]!, v.index)}
            </div>
          ))}
        </div>
      ) : (
        <div ref={bodyRef} className="flex flex-col gap-2">
          {cards.map(card)}
        </div>
      )}
      {here && drop.beforeId === null && indicator}
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          data-testid="board-new"
          className="flex h-8 items-center gap-1.5 rounded px-2 text-sm text-muted hover:bg-hover"
        >
          <Plus size={14} /> New
        </button>
      )}
      {column.info.key === NO_VALUE && cards.length === 0 && !onAdd && (
        <span className="px-2 text-xs text-faint">No cards</span>
      )}
    </div>
  );
}
