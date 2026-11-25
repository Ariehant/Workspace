/**
 * Days as a time grid (the week, the day, or 1–7 days), with all-day events in a row above it.
 *
 * With the pointer: drag on empty space to create, drag an event to move it, drag its bottom
 * edge to resize it, and drag between the grid and the all-day row to switch. A click opens an
 * event (Enter does too). Esc cancels a drag.
 */
import { cn } from '@workspace/ui';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { dayOf, instantOf, minutesOf, type EventTime } from '../shared/dates';
import { canEdit, type CalEvent, type Calendar } from '../shared/types';
import { colourVar } from './api';
import { dayNumber, formatFullDay, formatHour, formatTime, formatWeekday } from './format';
import { draggedRange, moved, resized, snap, timeOf, toAllDay, toTimed } from './edits';
import { layoutAllDay, layoutTimed } from './layout';

export const HOUR_PX = 48;
const ALL_DAY_LANE_PX = 24;
const GUTTER_PX = 64;
const ZONE_GUTTER_PX = 56;
/** Pointer travel before a press on an event becomes a drag (else it's a click). */
const DRAG_THRESHOLD_PX = 4;
/** The id of the event being made (in a drag, or open in the panel before it's saved). */
export const DRAFT_ID = '__draft__';

export interface Draft {
  time: EventTime;
  calendarId: string;
  title: string;
}

interface Props {
  days: string[];
  events: CalEvent[];
  calendars: Map<string, Calendar>;
  /** The wall clock now (`YYYY-MM-DDTHH:mm`), for "today" and the now line. */
  now: string;
  selectedId: string | null;
  /** A new event being set up in the panel (shown in the grid until saved or cancelled). */
  draft: Draft | null;
  /** A second time zone shown as another time column (IANA name), or null. */
  secondZone: string | null;
  onOpen: (event: CalEvent) => void;
  onCreate: (time: EventTime) => void;
  onChange: (event: CalEvent, time: EventTime) => void;
  onPickDay: (day: string) => void;
}

export const colourOf = (event: CalEvent, calendars: Map<string, Calendar>) =>
  event.colour ?? calendars.get(event.calendarId)?.colour ?? 'blue';

export const titleOf = (event: Pick<CalEvent, 'title'>) => event.title || 'Untitled';

/** "10:00 AM – 11:30 AM" for a timed event, or "All day". */
export function timeLabel(event: Pick<CalEvent, 'allDay' | 'start' | 'end'>): string {
  if (event.allDay) return 'All day';
  return `${formatTime(minutesOf(event.start))} – ${formatTime(minutesOf(event.end))}`;
}

/** Whether events in this calendar can be changed here. */
export const editable = canEdit;

type Drag =
  | { kind: 'create'; zone: 'grid' | 'allday'; day: string; minutes: number }
  | {
      kind: 'move';
      event: CalEvent;
      dayIndex: number;
      minutes: number;
      x: number;
      y: number;
      dragging: boolean;
    }
  | { kind: 'resize'; event: CalEvent };

interface Slot {
  zone: 'grid' | 'allday';
  dayIndex: number;
  day: string;
  minutes: number;
}

export function WeekView(props: Props) {
  const { days, events, calendars, now, selectedId, draft, secondZone } = props;
  const today = dayOf(now);
  const scroller = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{ id: string; time: EventTime } | null>(null);
  const gutter = GUTTER_PX + (secondZone ? ZONE_GUTTER_PX : 0);

  // What's drawn: events (one being dragged at its new time) and the draft.
  const shown = useMemo(() => {
    const list = events.map((e) => (ghost && e.id === ghost.id ? { ...e, ...ghost.time } : e));
    const pending = ghost?.id === DRAFT_ID ? ghost.time : draft?.time;
    if (pending) {
      list.push({
        id: DRAFT_ID,
        calendarId: draft?.calendarId ?? '',
        sourceId: DRAFT_ID,
        title: draft?.title || 'New event',
        ...pending,
        floating: true,
        url: null,
        colour: null,
        extra: [],
        lastEdited: '',
      });
    }
    return list;
  }, [events, ghost, draft]);

  const timed = useMemo(() => layoutTimed(shown, days), [shown, days]);
  const allDay = useMemo(() => layoutAllDay(shown, days), [shown, days]);
  const columns = `${gutter}px repeat(${days.length}, minmax(0, 1fr))`;

  // Open at the working day (or an hour before now, when today is shown), not at midnight.
  const firstDay = days[0];
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const hours = days.includes(today) ? Math.max(0, minutesOf(now) / 60 - 1) : 7.5;
    el.scrollTop = hours * HOUR_PX;
    // Only when the days shown change, not every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, days.length]);

  /** The grid slot under a point of the window. */
  const slotAt = (x: number, y: number): Slot | null => {
    const grid = gridRef.current?.getBoundingClientRect();
    const view = scroller.current?.getBoundingClientRect();
    if (!grid || !view) return null;
    const width = (grid.width - gutter) / days.length;
    const dayIndex = Math.min(
      days.length - 1,
      Math.max(0, Math.floor((x - grid.left - gutter) / width)),
    );
    const day = days[dayIndex]!;
    if (y < view.top) return { zone: 'allday', dayIndex, day, minutes: 0 };
    const minutes = Math.min(24 * 60, Math.max(0, ((y - grid.top) / HOUR_PX) * 60));
    return { zone: 'grid', dayIndex, day, minutes };
  };

  /** The time a drag would give, for the slot under the pointer. */
  const timeFor = (d: Drag, slot: Slot): EventTime | null => {
    if (d.kind === 'create') {
      if (d.zone === 'allday') {
        const [a, b] = [d.day, slot.day].sort() as [string, string];
        return { allDay: true, start: a, end: b, endSet: b > a };
      }
      return draggedRange(
        d.day,
        d.minutes,
        slot.day,
        slot.zone === 'grid' ? slot.minutes : d.minutes,
      );
    }
    if (d.kind === 'resize') {
      if (slot.zone !== 'grid' && !d.event.allDay) return null;
      return resized(timeOf(d.event), slot.day, slot.minutes);
    }
    const time = timeOf(d.event);
    const byDays = slot.dayIndex - d.dayIndex;
    if (slot.zone === 'allday') {
      return time.allDay ? moved(time, byDays, 0) : toAllDay(time, slot.day);
    }
    if (time.allDay) return toTimed(slot.day, slot.minutes);
    return moved(time, byDays, snap(slot.minutes - d.minutes));
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === 'move' && !d.dragging) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) return;
        d.dragging = true;
      }
      const slot = slotAt(e.clientX, e.clientY);
      const time = slot && timeFor(d, slot);
      if (time) setGhost({ id: d.kind === 'create' ? DRAFT_ID : d.event.id, time });
    };
    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      const slot = slotAt(e.clientX, e.clientY);
      setGhost(null);
      if (d.kind === 'move' && !d.dragging) return props.onOpen(d.event);
      const time = slot && timeFor(d, slot);
      if (!time) return;
      if (d.kind === 'create') props.onCreate(time);
      else if (
        time.start !== d.event.start ||
        time.end !== d.event.end ||
        time.allDay !== d.event.allDay
      )
        props.onChange(d.event, time);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        drag.current = null;
        setGhost(null);
        e.stopPropagation();
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  });

  const startCreate = (e: React.PointerEvent, zone: 'grid' | 'allday') => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const slot = slotAt(e.clientX, e.clientY);
    if (!slot) return;
    e.preventDefault();
    const d: Drag = { kind: 'create', zone, day: slot.day, minutes: slot.minutes };
    drag.current = d;
    setGhost({ id: DRAFT_ID, time: timeFor(d, { ...slot, zone })! });
  };

  const startMove = (e: React.PointerEvent, event: CalEvent) => {
    if (e.button !== 0 || event.id === DRAFT_ID) return;
    if (!editable(calendars.get(event.calendarId))) return; // a click still opens it (onClick)
    const slot = slotAt(e.clientX, e.clientY);
    if (!slot) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    drag.current = {
      kind: 'move',
      event: events.find((x) => x.id === event.id) ?? event,
      dayIndex: slot.dayIndex,
      minutes: slot.minutes,
      x: e.clientX,
      y: e.clientY,
      dragging: false,
    };
  };

  const startResize = (e: React.PointerEvent, event: CalEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { kind: 'resize', event: events.find((x) => x.id === event.id) ?? event };
  };

  const eventProps = (event: CalEvent) => ({
    'data-event-id': event.id === DRAFT_ID ? undefined : event.id,
    'aria-pressed': event.id === selectedId,
    onPointerDown: (e: React.PointerEvent) => startMove(e, event),
    // Keyboard (Enter/Space) opens; pointer clicks are handled on release.
    onClick: (e: React.MouseEvent) => {
      if (event.id === DRAFT_ID) return;
      if (e.detail === 0 || !editable(calendars.get(event.calendarId))) props.onOpen(event);
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col select-none" role="region" aria-label="Calendar">
      {/* Day headings */}
      <div className="grid border-b border-line" style={{ gridTemplateColumns: columns }}>
        <div className="flex items-end justify-end gap-2 pr-2 pb-1 text-[10px] text-faint">
          {secondZone && <span title={secondZone}>{zoneLabel(secondZone, days[0]!)}</span>}
          {secondZone && <span>{zoneLabel(localZone(), days[0]!)}</span>}
        </div>
        {days.map((day) => (
          <button
            type="button"
            key={day}
            onClick={() => props.onPickDay(day)}
            className="flex items-baseline justify-center gap-1.5 py-2 text-xs text-muted hover:bg-hover"
            aria-label={formatFullDay(day)}
            aria-current={day === today ? 'date' : undefined}
          >
            <span>{formatWeekday(day)}</span>
            <span
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-full text-base font-medium',
                day === today ? 'bg-accent text-accent-fg' : 'text-fg',
              )}
            >
              {dayNumber(day)}
            </span>
          </button>
        ))}
      </div>

      {/* All-day row */}
      <div
        ref={allDayRef}
        className="relative grid border-b border-line"
        style={{
          gridTemplateColumns: columns,
          minHeight: Math.max(1, allDay.lanes) * ALL_DAY_LANE_PX + 8,
        }}
        aria-label="All-day events"
        role="group"
      >
        <div className="self-center pr-2 text-right text-[11px] text-faint">All day</div>
        {days.map((day) => (
          <div
            key={day}
            className="border-l border-line"
            onPointerDown={(e) => startCreate(e, 'allday')}
            data-testid={`all-day-${day}`}
          />
        ))}
        {allDay.bars.map((bar) => (
          <button
            type="button"
            key={bar.event.id}
            {...eventProps(bar.event)}
            className={cn(
              'cal-event absolute truncate rounded px-1.5 text-left text-xs leading-[20px] outline-offset-1',
              bar.continuesBefore && 'rounded-l-none',
              bar.continuesAfter && 'rounded-r-none',
              bar.event.id === selectedId && 'ring-2 ring-accent',
              (bar.event.id === ghost?.id || bar.event.id === DRAFT_ID) && 'opacity-80 shadow-menu',
            )}
            style={{
              ...colourVar(colourOf(bar.event, calendars)),
              top: 4 + bar.lane * ALL_DAY_LANE_PX,
              height: ALL_DAY_LANE_PX - 4,
              left: `calc(${gutter}px + (100% - ${gutter}px) * ${bar.start / days.length} + 2px)`,
              width: `calc((100% - ${gutter}px) * ${bar.span / days.length} - 4px)`,
            }}
            aria-label={`${titleOf(bar.event)}, all day`}
            title={titleOf(bar.event)}
          >
            {titleOf(bar.event)}
          </button>
        ))}
      </div>

      {/* Time grid */}
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-y-auto"
        data-testid="time-grid"
      >
        <div
          ref={gridRef}
          className="relative grid"
          style={{ gridTemplateColumns: columns, height: 24 * HOUR_PX }}
        >
          <div className="relative flex">
            {secondZone && (
              <div
                className="relative border-r border-line"
                style={{ width: ZONE_GUTTER_PX }}
                aria-label={`Times in ${secondZone}`}
                role="group"
              >
                {Array.from({ length: 23 }, (_, i) => (
                  <div
                    key={i}
                    className="absolute right-2 -translate-y-1/2 text-[11px] text-faint"
                    style={{ top: (i + 1) * HOUR_PX }}
                  >
                    {hourIn(secondZone, days[0]!, i + 1)}
                  </div>
                ))}
              </div>
            )}
            <div className="relative flex-1">
              {Array.from({ length: 23 }, (_, i) => (
                <div
                  key={i}
                  className="absolute right-2 -translate-y-1/2 text-[11px] text-faint"
                  style={{ top: (i + 1) * HOUR_PX }}
                >
                  {formatHour(i + 1)}
                </div>
              ))}
            </div>
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="relative border-l border-line"
              role="group"
              aria-label={formatFullDay(day)}
              data-testid={`day-${day}`}
              onPointerDown={(e) => startCreate(e, 'grid')}
            >
              {timed
                .filter((p) => p.day === day)
                .map((piece) => {
                  const height = ((piece.bottom - piece.top) / 60) * HOUR_PX;
                  const short = height < 36;
                  const event = piece.event;
                  const canEdit =
                    event.id !== DRAFT_ID && editable(calendars.get(event.calendarId));
                  return (
                    <button
                      type="button"
                      key={`${event.id}:${piece.day}`}
                      {...eventProps(event)}
                      className={cn(
                        'cal-event absolute z-10 overflow-hidden rounded px-1.5 text-left text-xs outline-offset-1',
                        short ? 'leading-[16px]' : 'py-0.5',
                        piece.continuesBefore && 'rounded-t-none',
                        piece.continuesAfter && 'rounded-b-none',
                        event.id === selectedId && 'z-20 ring-2 ring-accent',
                        (event.id === ghost?.id || event.id === DRAFT_ID) &&
                          'z-30 opacity-90 shadow-menu',
                      )}
                      style={{
                        ...colourVar(colourOf(event, calendars)),
                        top: (piece.top / 60) * HOUR_PX + 1,
                        height: height - 2,
                        left: `calc(${(piece.column / piece.columns) * 100}% + 2px)`,
                        width: `calc(${100 / piece.columns}% - 4px)`,
                      }}
                      aria-label={`${titleOf(event)}, ${timeLabel(event)}`}
                      title={`${titleOf(event)}\n${timeLabel(event)}`}
                    >
                      <span className={cn('font-medium', short && 'mr-1')}>{titleOf(event)}</span>
                      {short ? (
                        <span className="text-muted">{formatTime(minutesOf(event.start))}</span>
                      ) : (
                        <div className="truncate text-muted">{timeLabel(event)}</div>
                      )}
                      {canEdit && !piece.continuesAfter && (
                        <span
                          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
                          onPointerDown={(e) => startResize(e, event)}
                          aria-hidden
                          data-testid="resize-handle"
                        />
                      )}
                    </button>
                  );
                })}
              {day === today && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger"
                  style={{ top: (minutesOf(now) / 60) * HOUR_PX }}
                  aria-hidden
                >
                  <div className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-danger" />
                </div>
              )}
            </div>
          ))}
          {/* Hour lines across all days */}
          <div className="pointer-events-none absolute inset-0" style={{ left: gutter }}>
            {Array.from({ length: 23 }, (_, i) => (
              <div
                key={i}
                className="absolute inset-x-0 border-t border-line"
                style={{ top: (i + 1) * HOUR_PX }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A zone's short name on a day ("GMT+5:30", "PST"). */
function zoneLabel(zone: string, day: string): string {
  try {
    const part = new Intl.DateTimeFormat(undefined, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(instantOf(`${day}T12:00`))
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? zone;
  } catch {
    return zone;
  }
}

/** What the clock shows in `zone` when it's `hour`:00 here, on `day`. */
function hourIn(zone: string, day: string, hour: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
    })
      .format(instantOf(`${day}T${String(hour).padStart(2, '0')}:00`))
      .replace(':00', '');
  } catch {
    return '';
  }
}
