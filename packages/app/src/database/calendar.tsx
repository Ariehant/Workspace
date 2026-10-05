import {
  calendarWeeks,
  cellValue,
  dateOfDay,
  dayIndex,
  isDateValue,
  isoOfDay,
  layoutWeek,
  rowDays,
  shiftDateValue,
  updateView,
  withEndDay,
  type DateValue,
  type Property,
  type Row,
} from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { Button, IconButton, cn } from '@workspace/ui';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState, type DragEvent } from 'react';
import { useApp } from '../context';
import { newRow, writeCell } from './actions';
import type { LayoutViewProps } from './cards';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const BAR = 24;

/** The day of a week row under the pointer. */
function dayAt(e: DragEvent<HTMLElement>, week: number[]): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const col = Math.min(6, Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * 7)));
  return week[col]!;
}
const DAY_HEADER = 28;

/** Date-like properties a calendar or timeline can be shown by. */
export const dateProperties = (properties: readonly Property[]) =>
  properties.filter(
    (p) => p.type === 'date' || p.type === 'createdTime' || p.type === 'lastEditedTime',
  );

interface Drag {
  rowId: string;
  /** move: the day grabbed; resize: drag the end; place: from the "No date" list. */
  mode: 'move' | 'resize' | 'place';
  grabDay: number;
}

/** Calendar: rows on the days of their date (ranges span days), by month or week. */
export function CalendarView(props: LayoutViewProps) {
  const { handle, snapshot, view, result, editable, onOpenRow } = props;
  const { user, databases, platform, client } = useApp();
  const [anchor, setAnchor] = useState(() => new Date());
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [noDate, setNoDate] = useState(false);
  const dates = dateProperties(snapshot.properties);
  const property = dates.find((p) => p.id === view.dateProperty) ?? dates[0];
  if (!property) {
    return (
      <p className="py-6 text-sm text-muted" data-testid="calendar-view">
        Add a date property to show this view as a calendar.
      </p>
    );
  }
  const settable = editable && property.type === 'date';
  const weeks = calendarWeeks(anchor, view.calendarMode, view.weekStart);
  const today = dayIndex(new Date());
  const dated = result.rows.flatMap((row) => {
    const days = rowDays(row, property);
    return days ? [{ row, ...days }] : [];
  });
  const undated = result.rows.filter((row) => !rowDays(row, property));
  const month = anchor.getMonth();
  const step = (n: number) =>
    setAnchor((a) =>
      view.calendarMode === 'week'
        ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + 7 * n)
        : new Date(a.getFullYear(), a.getMonth() + n, 1),
    );
  const title =
    view.calendarMode === 'week'
      ? `${MONTHS[dateOfDay(weeks[0]![0]!).getMonth()]} ${dateOfDay(weeks[0]![0]!).getFullYear()}`
      : `${MONTHS[month]} ${anchor.getFullYear()}`;

  const write = (row: Row, value: DateValue) =>
    writeCell(databases, handle, row.id, property, value, user.id);
  const dropOn = (day: number) => {
    const current = drag;
    setDrag(null);
    setOver(null);
    const row = current && snapshot.rows.find((r) => r.id === current.rowId);
    if (!current || !row || !settable) return;
    const value = cellValue(row, property);
    if (current.mode === 'place' || !isDateValue(value)) write(row, { start: isoOfDay(day) });
    else if (current.mode === 'resize') write(row, withEndDay(value, day));
    else if (day !== current.grabDay) write(row, shiftDateValue(value, day - current.grabDay));
  };
  const newOn = (day: number) => {
    const id = newRow(client, handle, snapshot, view, {
      actor: user.id,
      values: property.type === 'date' ? { [property.id]: { start: isoOfDay(day) } } : {},
    });
    onOpenRow(id);
  };

  return (
    <div data-testid="calendar-view" className="flex gap-3 pt-2 pb-4 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex h-10 items-center gap-1">
          <h3 className="mr-auto text-base font-semibold" data-testid="calendar-title">
            {title}
          </h3>
          {undated.length > 0 && (
            <Button onClick={() => setNoDate(!noDate)} aria-pressed={noDate}>
              No date ({undated.length})
            </Button>
          )}
          <div
            className="flex rounded border border-line"
            role="group"
            aria-label="Calendar layout"
          >
            {(['month', 'week'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view.calendarMode === mode}
                disabled={!editable || snapshot.meta.lockViews}
                onClick={() => updateView(handle.doc, view.id, { calendarMode: mode })}
                className={cn(
                  'h-7 px-2 capitalize',
                  view.calendarMode === mode ? 'bg-active text-fg' : 'text-muted hover:bg-hover',
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <IconButton label="Previous" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <Button onClick={() => setAnchor(new Date())}>Today</Button>
          <IconButton label="Next" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
        <div className="grid grid-cols-7 border-b border-line text-xs text-muted">
          {weeks[0]!.map((day) => (
            <div key={day} className="px-2 py-1">
              {WEEKDAYS[dateOfDay(day).getDay()]}
            </div>
          ))}
        </div>
        {weeks.map((week) => {
          const { bars, lanes } = layoutWeek(dated, week[0]!);
          const minHeight = view.calendarMode === 'week' ? 360 : 112;
          const height = Math.max(minHeight, DAY_HEADER + lanes * (BAR + 2) + 24);
          return (
            <div
              key={week[0]}
              className="relative grid grid-cols-7 border-b border-line"
              style={{ height }}
              data-testid="calendar-week"
              // Drops land on the day under the pointer (bars included).
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const day = dayAt(e, week);
                if (over !== day) setOver(day);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropOn(dayAt(e, week));
              }}
            >
              {week.map((day) => {
                const date = dateOfDay(day);
                const outside = view.calendarMode === 'month' && date.getMonth() !== month;
                return (
                  <div
                    key={day}
                    data-testid="calendar-day"
                    data-day={isoOfDay(day)}
                    className={cn(
                      'group/day relative border-r border-line px-1.5 py-1 last:border-r-0',
                      outside && 'bg-hover/40',
                      over === day && 'bg-accent/10',
                    )}
                  >
                    <div className="flex items-center justify-between">
                      {settable && (
                        <IconButton
                          label={`New on ${isoOfDay(day)}`}
                          size="sm"
                          className="invisible group-hover/day:visible"
                          onClick={() => newOn(day)}
                        >
                          <Plus size={13} />
                        </IconButton>
                      )}
                      <span
                        className={cn(
                          'ml-auto flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs',
                          day === today
                            ? 'bg-danger font-semibold text-white'
                            : outside
                              ? 'text-faint'
                              : 'text-muted',
                        )}
                      >
                        {date.getDate() === 1 && view.calendarMode === 'month'
                          ? `${MONTHS[date.getMonth()]!.slice(0, 3)} 1`
                          : date.getDate()}
                      </span>
                    </div>
                  </div>
                );
              })}
              {bars.map((bar) => (
                <div
                  key={bar.row.id}
                  role="button"
                  tabIndex={0}
                  data-testid="calendar-event"
                  data-row-id={bar.row.id}
                  draggable={settable}
                  onDragStart={(e: DragEvent<HTMLDivElement>) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', bar.row.title);
                    const weekRect = e.currentTarget.parentElement!.getBoundingClientRect();
                    const col = Math.min(
                      6,
                      Math.max(0, Math.floor(((e.clientX - weekRect.left) / weekRect.width) * 7)),
                    );
                    setDrag({ rowId: bar.row.id, mode: 'move', grabDay: week[col]! });
                  }}
                  onDragEnd={() => {
                    setDrag(null);
                    setOver(null);
                  }}
                  onClick={() => onOpenRow(bar.row.id)}
                  onKeyDown={(e) => e.key === 'Enter' && onOpenRow(bar.row.id)}
                  className={cn(
                    'group/event absolute flex items-center gap-1 overflow-hidden border border-line bg-surface px-1.5 text-xs shadow-sm hover:bg-hover',
                    bar.continuesBefore ? 'rounded-l-none' : 'rounded-l',
                    bar.continuesAfter ? 'rounded-r-none' : 'rounded-r',
                    drag?.rowId === bar.row.id && 'opacity-50',
                  )}
                  style={{
                    top: DAY_HEADER + bar.lane * (BAR + 2),
                    height: BAR,
                    left: `calc(${(bar.startCol / 7) * 100}% + 3px)`,
                    width: `calc(${((bar.endCol - bar.startCol + 1) / 7) * 100}% - 6px)`,
                  }}
                >
                  <PageIcon
                    icon={bar.row.icon}
                    size={12}
                    fileUrl={platform.fileUrl}
                    className="shrink-0 text-muted"
                  />
                  <span className="truncate font-medium" data-testid="calendar-event-title">
                    {bar.row.title || 'Untitled'}
                  </span>
                  {settable && !bar.continuesAfter && (
                    <div
                      role="separator"
                      aria-label={`Resize ${bar.row.title || 'Untitled'}`}
                      draggable
                      onClick={(e) => e.stopPropagation()}
                      onDragStart={(e) => {
                        e.stopPropagation();
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', bar.row.title);
                        setDrag({
                          rowId: bar.row.id,
                          mode: 'resize',
                          grabDay: week[0]! + bar.endCol,
                        });
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setOver(null);
                      }}
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize opacity-0 group-hover/event:opacity-100 hover:bg-accent/40"
                    />
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {noDate && undated.length > 0 && (
        <aside className="w-56 shrink-0 border-l border-line pl-3" data-testid="no-date-panel">
          <p className="flex h-10 items-center font-medium">No date</p>
          <p className="mb-2 text-xs text-muted">Drag a page onto a day to give it a date.</p>
          {undated.map((row) => (
            <div
              key={row.id}
              role="button"
              tabIndex={0}
              draggable={settable}
              data-testid="no-date-row"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', row.title);
                setDrag({ rowId: row.id, mode: 'place', grabDay: 0 });
              }}
              onDragEnd={() => setDrag(null)}
              onClick={() => onOpenRow(row.id)}
              className="mb-1 flex h-8 items-center gap-1.5 rounded border border-line px-2 hover:bg-hover"
            >
              <PageIcon
                icon={row.icon}
                size={14}
                fileUrl={platform.fileUrl}
                className="shrink-0 text-muted"
              />
              <span className="truncate">{row.title || 'Untitled'}</span>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}
