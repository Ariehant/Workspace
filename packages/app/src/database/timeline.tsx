import {
  TIMELINE_ZOOMS,
  dragSpan,
  pxPerDay,
  readRelation,
  relationIds,
  rowSpan,
  setRelation,
  timelineProperties,
  timelineTicks,
  timelineX,
  updateView,
  type Row,
  type TimelineSpan,
  type TimelineZoom,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { Button, cn } from '@workspace/ui';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useApp } from '../context';
import { writeCell } from './actions';
import { CellDisplay } from './cells';
import { SectionHeader, shownProperties, toggleGroupKey, type LayoutViewProps } from './cards';
import { useMinute } from './hooks';
import { buildLines, type Line } from './list';

const DAY_MS = 86_400_000;
const ROW_H = 36;
const HEADER_H = 48;
const TABLE_W = 260;

interface Dragging {
  rowId: string;
  edge: 'move' | 'start' | 'end';
  startX: number;
  dx: number;
  moved: boolean;
}

interface Linking {
  fromId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Timeline: bars from start to end dates on a zoomable time axis. */
export function TimelineView(props: LayoutViewProps) {
  const { handle, snapshot, view, result, ctx, editable, onOpenRow } = props;
  const { user, databases, platform } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<Dragging | null>(null);
  const [linking, setLinking] = useState<Linking | null>(null);
  const { start, end } = timelineProperties(view, snapshot.properties);
  const zoom = view.timelineZoom;
  const perDay = pxPerDay(zoom);

  // The axis spans the bars plus margins, and always today.
  const now = useMinute();
  const spans = new Map<string, TimelineSpan>();
  if (start) {
    for (const row of result.rows) {
      const span = rowSpan(row, start, end);
      if (span) spans.set(row.id, span);
    }
  }
  const all = [...spans.values()];
  const margin = Math.max(14, Math.ceil(900 / perDay)) * DAY_MS;
  const dayStart = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const origin = dayStart(Math.min(now, ...all.map((s) => s.start)) - margin);
  const last = Math.max(now, ...all.map((s) => s.end)) + margin;
  const width = timelineX(last, origin, zoom);
  const ticks = timelineTicks(origin, last, zoom);
  const x = (ms: number) => timelineX(ms, origin, zoom);

  // Start scrolled to today.
  const scrollTo = (ms: number) => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, x(ms) - el.clientWidth / 3);
  };
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    const key = `${view.id}:${zoom}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    const el = scrollRef.current;
    if (el) el.scrollLeft = Math.max(0, timelineX(now, origin, zoom) - el.clientWidth / 3);
  });

  const lines = buildLines<Row>(result, (rows, path) =>
    rows.map((row) => ({ key: `${path}${row.id}`, item: row })),
  );
  const levels = [view.groupBy, view.subGroupBy];
  const rowLine = new Map<string, number>();
  lines.forEach((line, i) => {
    if (line.kind === 'item' && !rowLine.has(line.item.id)) rowLine.set(line.item.id, i);
  });
  const lineHeight = (line: Line<Row>) =>
    line.kind === 'header' ? 41 : line.kind === 'new' ? 0 : ROW_H;
  const tops: number[] = [];
  lines.reduce((top, line, i) => {
    tops[i] = top;
    return top + lineHeight(line);
  }, 0);
  const bodyHeight = lines.reduce((h, l) => h + lineHeight(l), 0);
  const settable = editable && start?.type === 'date' && (!end || end.type === 'date');
  const shown = shownProperties(view, snapshot).slice(0, 2);

  // Snapped change while dragging: whole days, or hours in the hours zoom.
  const deltaOf = (dx: number) =>
    zoom === 'hours'
      ? { days: 0, hours: Math.round(dx / (perDay / 24)) }
      : { days: Math.round(dx / perDay) };
  const previewDx = (d: Dragging) => {
    const delta = deltaOf(d.dx);
    return zoom === 'hours' ? (delta.hours! * perDay) / 24 : delta.days * perDay;
  };

  const startDrag = (e: ReactPointerEvent, rowId: string, edge: Dragging['edge']) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging({ rowId, edge, startX: e.clientX, dx: 0, moved: false });
  };
  const moveDrag = (e: ReactPointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    setDragging({ ...dragging, dx, moved: dragging.moved || Math.abs(dx) > 3 });
  };
  const endDrag = () => {
    const d = dragging;
    setDragging(null);
    if (!d) return;
    if (!d.moved) {
      onOpenRow(d.rowId);
      return;
    }
    const row = snapshot.rows.find((r) => r.id === d.rowId);
    const delta = deltaOf(d.dx);
    if (!row || !start || !settable || (delta.days === 0 && !delta.hours)) return;
    handle.doc.transact(() => {
      for (const [propertyId, value] of dragSpan(row, start, end, d.edge, delta)) {
        const property = snapshot.properties.find((p) => p.id === propertyId)!;
        writeCell(databases, handle, row.id, property, value, user.id);
      }
    });
  };

  // Dependencies: arrows from a blocking row's end to the blocked row's start.
  const deps = snapshot.meta.dependencies;
  const arrows: { from: string; to: string; late: boolean }[] = [];
  if (deps && view.showDependencies) {
    for (const row of result.rows) {
      const span = spans.get(row.id);
      if (!span) continue;
      for (const blocker of relationIds(row.values[deps.blockedById])) {
        const other = spans.get(blocker);
        if (other && rowLine.has(blocker)) {
          arrows.push({ from: blocker, to: row.id, late: other.end > span.start });
        }
      }
    }
  }
  const barGeometry = (rowId: string) => {
    const span = spans.get(rowId)!;
    let left = x(span.start);
    let right = x(span.end);
    if (dragging?.rowId === rowId && dragging.moved) {
      const off = previewDx(dragging);
      if (dragging.edge !== 'end') left += off;
      if (dragging.edge !== 'start') right += off;
    }
    if (right - left < 6) right = left + 6;
    return { left, right, y: tops[rowLine.get(rowId)!]! + ROW_H / 2 };
  };

  const startLink = (e: ReactPointerEvent, rowId: string) => {
    if (!deps || e.button !== 0) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = barGeometry(rowId);
    setLinking({ fromId: rowId, x1: g.right, y1: g.y, x2: g.right, y2: g.y });
  };
  const moveLink = (e: ReactPointerEvent) => {
    const body = bodyRef.current;
    if (!linking || !body) return;
    const rect = body.getBoundingClientRect();
    setLinking({ ...linking, x2: e.clientX - rect.left, y2: e.clientY - rect.top });
  };
  const endLink = (e: ReactPointerEvent) => {
    const link = linking;
    setLinking(null);
    if (!link || !deps) return;
    const target = document
      .elementsFromPoint(e.clientX, e.clientY)
      .map((el) => el.closest<HTMLElement>('[data-testid="timeline-bar"]'))
      .find((el) => el && el.dataset.rowId !== link.fromId);
    const toId = target?.dataset.rowId;
    if (!toId) return;
    const blockedBy = readRelation(handle.doc, toId, deps.blockedById);
    if (blockedBy.includes(link.fromId)) return;
    setRelation(
      databases.resolveDoc,
      handle.id,
      toId,
      deps.blockedById,
      [...blockedBy, link.fromId],
      user.id,
    );
  };

  const header = (line: Extract<Line<Row>, { kind: 'header' }>) => (
    <SectionHeader
      group={line.group}
      property={snapshot.properties.find((p) => p.id === levels[line.depth]?.propertyId)}
      depth={line.depth}
      editable={editable}
      onToggle={() => toggleGroupKey(handle, view, line.depth, line.group.info.key, 'collapsed')}
      onHide={() => toggleGroupKey(handle, view, line.depth, line.group.info.key, 'hidden')}
    />
  );

  if (!start) {
    return (
      <p className="py-6 text-sm text-muted" data-testid="timeline-view">
        Add a date property to show this view as a timeline.
      </p>
    );
  }

  return (
    <div data-testid="timeline-view" className="pt-2 pb-4 text-sm">
      <div className="flex h-10 items-center gap-1">
        <select
          aria-label="Zoom"
          value={zoom}
          disabled={!editable || snapshot.meta.lockViews}
          onChange={(e) =>
            updateView(handle.doc, view.id, { timelineZoom: e.target.value as TimelineZoom })
          }
          className="h-7 rounded border border-line bg-transparent px-1.5 text-sm"
        >
          {TIMELINE_ZOOMS.map((z) => (
            <option key={z.id} value={z.id}>
              {z.label}
            </option>
          ))}
        </select>
        <Button onClick={() => scrollTo(now)}>Today</Button>
        <label className="flex items-center gap-1 text-muted">
          Jump to
          <input
            type="date"
            aria-label="Jump to date"
            onChange={(e) => {
              if (e.target.value) scrollTo(new Date(`${e.target.value}T00:00`).getTime());
            }}
            className="h-7 rounded border border-line bg-transparent px-1.5 text-sm text-fg"
          />
        </label>
      </div>
      <div className="flex border-t border-line">
        {view.timelineTable && (
          <div
            className="shrink-0 border-r border-line"
            style={{ width: TABLE_W }}
            data-testid="timeline-table"
          >
            <div
              className="flex items-end border-b border-line px-2 pb-1 text-muted"
              style={{ height: HEADER_H }}
            >
              Name
            </div>
            {lines.map((line) =>
              line.kind === 'header' ? (
                <div key={line.key} className="px-1">
                  {header(line)}
                </div>
              ) : line.kind === 'item' ? (
                <div
                  key={line.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenRow(line.item.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpenRow(line.item.id)}
                  className={cn(
                    'flex items-center gap-1.5 border-b border-line/60 px-2 hover:bg-hover',
                    line.depth > 0 && 'pl-6',
                  )}
                  style={{ height: ROW_H }}
                  data-testid="timeline-row"
                >
                  <PageIcon
                    icon={line.item.icon}
                    size={14}
                    fileUrl={platform.fileUrl}
                    className="shrink-0 text-muted"
                  />
                  <span className="min-w-0 flex-1 truncate">{line.item.title || 'Untitled'}</span>
                  {shown.map((p) => (
                    <span key={p.id} className="flex max-w-24 min-w-0 items-center text-xs">
                      <CellDisplay row={line.item} property={p} ctx={ctx} variant="panel" />
                    </span>
                  ))}
                </div>
              ) : null,
            )}
          </div>
        )}
        <div
          ref={scrollRef}
          className="min-w-0 flex-1 overflow-x-auto"
          data-testid="timeline-scroll"
        >
          <div style={{ width }} className="relative">
            {/* Axis */}
            <div
              className="relative border-b border-line text-xs text-muted"
              style={{ height: HEADER_H }}
            >
              {ticks.major.map((t) => (
                <span
                  key={`M${t.ms}`}
                  className="absolute top-1 font-medium whitespace-nowrap text-fg"
                  style={{ left: x(t.ms) + 4 }}
                >
                  {t.label}
                </span>
              ))}
              {ticks.minor.map((t) => (
                <span
                  key={`m${t.ms}`}
                  className="absolute bottom-1 whitespace-nowrap"
                  style={{ left: x(t.ms) + 2 }}
                >
                  {t.label}
                </span>
              ))}
            </div>
            <div
              ref={bodyRef}
              className="relative"
              style={{ height: Math.max(bodyHeight, ROW_H * 3) }}
              onPointerMove={(e) => {
                moveDrag(e);
                moveLink(e);
              }}
              onPointerUp={(e) => {
                if (linking) endLink(e);
                else endDrag();
              }}
            >
              {ticks.minor.map((t) => (
                <div
                  key={`g${t.ms}`}
                  className="absolute inset-y-0 w-px bg-line/40"
                  style={{ left: x(t.ms) }}
                />
              ))}
              <div
                className="absolute inset-y-0 z-10 w-0.5 bg-danger"
                style={{ left: x(now) }}
                data-testid="timeline-today"
              />
              {lines.map((line, i) => {
                if (line.kind !== 'item') return null;
                const span = spans.get(line.item.id);
                if (!span) return null;
                const g = barGeometry(line.item.id);
                return (
                  <div
                    key={line.key}
                    data-testid="timeline-bar"
                    data-row-id={line.item.id}
                    onPointerDown={(e) => startDrag(e, line.item.id, 'move')}
                    className={cn(
                      'group/bar absolute z-20 flex items-center rounded border border-accent/40 bg-accent/15 px-2 text-xs select-none',
                      settable ? 'cursor-grab' : 'cursor-pointer',
                      dragging?.rowId === line.item.id &&
                        dragging.moved &&
                        'cursor-grabbing shadow-menu',
                    )}
                    style={{
                      left: g.left,
                      width: g.right - g.left,
                      top: tops[i]! + 6,
                      height: ROW_H - 12,
                    }}
                  >
                    <span className="truncate font-medium" data-testid="timeline-bar-title">
                      {line.item.title || 'Untitled'}
                    </span>
                    {settable && (
                      <>
                        <div
                          role="separator"
                          aria-label={`Change start of ${line.item.title || 'Untitled'}`}
                          onPointerDown={(e) => startDrag(e, line.item.id, 'start')}
                          className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize rounded-l hover:bg-accent/50"
                        />
                        <div
                          role="separator"
                          aria-label={`Change end of ${line.item.title || 'Untitled'}`}
                          onPointerDown={(e) => startDrag(e, line.item.id, 'end')}
                          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize rounded-r hover:bg-accent/50"
                        />
                      </>
                    )}
                    {editable && deps && view.showDependencies && (
                      <div
                        role="button"
                        aria-label={`Draw dependency from ${line.item.title || 'Untitled'}`}
                        onPointerDown={(e) => startLink(e, line.item.id)}
                        className="absolute top-1/2 -right-4 size-3 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-accent bg-surface opacity-0 group-hover/bar:opacity-100"
                      />
                    )}
                  </div>
                );
              })}
              {(arrows.length > 0 || linking) && (
                <svg
                  className="pointer-events-none absolute inset-0 z-10"
                  width={width}
                  height={Math.max(bodyHeight, ROW_H * 3)}
                  data-testid="timeline-arrows"
                >
                  <defs>
                    <marker
                      id="ws-arrow"
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto"
                    >
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--ws-muted)" />
                    </marker>
                  </defs>
                  {arrows.map((a) => {
                    const from = barGeometry(a.from);
                    const to = barGeometry(a.to);
                    const midX = Math.max(from.right + 12, to.left - 12);
                    return (
                      <path
                        key={`${a.from}>${a.to}`}
                        data-testid="dependency-arrow"
                        data-late={a.late || undefined}
                        d={`M${from.right},${from.y} H${midX} V${to.y} H${to.left}`}
                        fill="none"
                        stroke={a.late ? 'var(--ws-danger)' : 'var(--ws-muted)'}
                        strokeWidth={1.5}
                        markerEnd="url(#ws-arrow)"
                      />
                    );
                  })}
                  {linking && (
                    <line
                      x1={linking.x1}
                      y1={linking.y1}
                      x2={linking.x2}
                      y2={linking.y2}
                      stroke="var(--ws-accent)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )}
                </svg>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
