/** The week (or any run of days) as a time grid, with all-day events in a row above it. */
import { cn } from '@workspace/ui';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { dayOf, minutesOf } from '../shared/dates';
import type { CalEvent, Calendar } from '../shared/types';
import { colourVar } from './api';
import { dayNumber, formatFullDay, formatHour, formatTime, formatWeekday } from './format';
import { layoutAllDay, layoutTimed } from './layout';

export const HOUR_PX = 48;
const ALL_DAY_LANE_PX = 24;
const GUTTER_PX = 64;

interface Props {
  days: string[];
  events: CalEvent[];
  calendars: Map<string, Calendar>;
  /** The wall clock now (`YYYY-MM-DDTHH:mm`), for "today" and the now line. */
  now: string;
}

const colourOf = (event: CalEvent, calendars: Map<string, Calendar>) =>
  event.colour ?? calendars.get(event.calendarId)?.colour ?? 'blue';

export const titleOf = (event: CalEvent) => event.title || 'Untitled';

/** "10:00 AM – 11:30 AM" for a timed event, or "All day". */
export function timeLabel(event: CalEvent): string {
  if (event.allDay) return 'All day';
  return `${formatTime(minutesOf(event.start))} – ${formatTime(minutesOf(event.end))}`;
}

export function WeekView({ days, events, calendars, now }: Props) {
  const today = dayOf(now);
  const scroller = useRef<HTMLDivElement>(null);
  const timed = useMemo(() => layoutTimed(events, days), [events, days]);
  const allDay = useMemo(() => layoutAllDay(events, days), [events, days]);
  const columns = `${GUTTER_PX}px repeat(${days.length}, minmax(0, 1fr))`;

  // Open at the working day (or an hour before now, this week), not at midnight.
  const firstDay = days[0];
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const hours = days.includes(today) ? Math.max(0, minutesOf(now) / 60 - 1) : 7.5;
    el.scrollTop = hours * HOUR_PX;
    // Only when the days shown change, not every minute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstDay, days.length]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Calendar">
      {/* Day headings */}
      <div className="grid border-b border-line" style={{ gridTemplateColumns: columns }}>
        <div />
        {days.map((day) => (
          <div
            key={day}
            className="flex items-baseline justify-center gap-1.5 py-2 text-xs text-muted"
            aria-label={formatFullDay(day)}
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
          </div>
        ))}
      </div>

      {/* All-day row */}
      <div
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
          <div key={day} className="border-l border-line" />
        ))}
        {allDay.bars.map((bar) => (
          <button
            type="button"
            key={bar.event.id}
            className={cn(
              'cal-event absolute truncate rounded px-1.5 text-left text-xs leading-[20px]',
              bar.continuesBefore && 'rounded-l-none',
              bar.continuesAfter && 'rounded-r-none',
            )}
            style={{
              ...colourVar(colourOf(bar.event, calendars)),
              top: 4 + bar.lane * ALL_DAY_LANE_PX,
              height: ALL_DAY_LANE_PX - 4,
              left: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${bar.start / days.length} + 2px)`,
              width: `calc((100% - ${GUTTER_PX}px) * ${bar.span / days.length} - 4px)`,
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
          className="relative grid"
          style={{ gridTemplateColumns: columns, height: 24 * HOUR_PX }}
        >
          <div className="relative">
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
          {days.map((day) => (
            <DayColumn
              key={day}
              day={day}
              pieces={timed.filter((p) => p.day === day)}
              calendars={calendars}
              nowMinutes={day === today ? minutesOf(now) : null}
            />
          ))}
          {/* Hour lines across all days */}
          <div className="pointer-events-none absolute inset-0" style={{ left: GUTTER_PX }}>
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

function DayColumn({
  day,
  pieces,
  calendars,
  nowMinutes,
}: {
  day: string;
  pieces: ReturnType<typeof layoutTimed>;
  calendars: Map<string, Calendar>;
  nowMinutes: number | null;
}) {
  return (
    <div className="relative border-l border-line" role="group" aria-label={formatFullDay(day)}>
      {pieces.map((piece) => {
        const height = ((piece.bottom - piece.top) / 60) * HOUR_PX;
        const short = height < 36;
        return (
          <button
            type="button"
            key={`${piece.event.id}:${piece.day}`}
            className={cn(
              'cal-event absolute z-10 overflow-hidden rounded px-1.5 text-left text-xs',
              short ? 'leading-[16px]' : 'py-0.5',
              piece.continuesBefore && 'rounded-t-none',
              piece.continuesAfter && 'rounded-b-none',
            )}
            style={{
              ...colourVar(colourOf(piece.event, calendars)),
              top: (piece.top / 60) * HOUR_PX + 1,
              height: height - 2,
              left: `calc(${(piece.column / piece.columns) * 100}% + 2px)`,
              width: `calc(${100 / piece.columns}% - 4px)`,
            }}
            aria-label={`${titleOf(piece.event)}, ${timeLabel(piece.event)}`}
            title={`${titleOf(piece.event)}\n${timeLabel(piece.event)}`}
          >
            <span className={cn('font-medium', short && 'mr-1')}>{titleOf(piece.event)}</span>
            {short ? (
              <span className="text-muted">{formatTime(minutesOf(piece.event.start))}</span>
            ) : (
              <div className="truncate text-muted">{timeLabel(piece.event)}</div>
            )}
          </button>
        );
      })}
      {nowMinutes !== null && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger"
          style={{ top: (nowMinutes / 60) * HOUR_PX }}
          aria-hidden
        >
          <div className="absolute -top-[5px] -left-[5px] size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  );
}
