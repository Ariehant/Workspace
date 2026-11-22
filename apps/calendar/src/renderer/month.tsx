/** The month view: six weeks of days, each listing its events; and the agenda list. */
import { cn } from '@workspace/ui';
import { addDays, dayOf, minutesOf } from '../shared/dates';
import type { CalEvent, Calendar } from '../shared/types';
import { colourVar } from './api';
import { dayNumber, formatFullDay, formatTime, formatWeekday } from './format';
import { lastDayOf } from './layout';
import { colourOf, timeLabel, titleOf } from './week';

/** Events on a day, all-day ones first, then by time. */
export function eventsOn(events: CalEvent[], day: string): CalEvent[] {
  return events
    .filter((e) => dayOf(e.start) <= day && lastDayOf(e) >= day)
    .sort(
      (a, b) =>
        Number(b.allDay) - Number(a.allDay) ||
        a.start.localeCompare(b.start) ||
        titleOf(a).localeCompare(titleOf(b)),
    );
}

const MAX_PER_DAY = 4;

interface MonthProps {
  /** The first day shown (the start of the week the month starts in). */
  first: string;
  /** The month shown (`YYYY-MM`), for dimming days outside it. */
  month: string;
  today: string;
  events: CalEvent[];
  calendars: Map<string, Calendar>;
  selectedId: string | null;
  onOpen: (event: CalEvent) => void;
  onPickDay: (day: string) => void;
  onCreate: (day: string) => void;
}

export function MonthView(props: MonthProps) {
  const { first, month, today, events, calendars } = props;
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  return (
    <div className="flex min-h-0 flex-1 flex-col" role="region" aria-label="Calendar">
      <div className="grid grid-cols-7 border-b border-line text-center text-xs text-muted">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="py-1.5">
            {formatWeekday(d)}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((day) => {
          const list = eventsOn(events, day);
          const more = list.length - MAX_PER_DAY;
          return (
            <div
              key={day}
              role="group"
              aria-label={formatFullDay(day)}
              className={cn(
                'flex min-h-0 flex-col gap-0.5 overflow-hidden border-r border-b border-line p-1',
                day.slice(0, 7) !== month && 'bg-sidebar',
              )}
              onClick={(e) => e.target === e.currentTarget && props.onCreate(day)}
            >
              <button
                type="button"
                onClick={() => props.onPickDay(day)}
                aria-label={`Show ${formatFullDay(day)}`}
                className={cn(
                  'flex size-6 items-center justify-center self-start rounded-full text-xs hover:bg-hover',
                  day === today && 'bg-accent font-semibold text-accent-fg hover:bg-accent',
                  day.slice(0, 7) !== month && day !== today && 'text-faint',
                )}
              >
                {dayNumber(day)}
              </button>
              {list.slice(0, more > 0 ? MAX_PER_DAY - 1 : MAX_PER_DAY).map((event) => (
                <button
                  type="button"
                  key={event.id}
                  data-event-id={event.id}
                  aria-pressed={event.id === props.selectedId}
                  onClick={() => props.onOpen(event)}
                  aria-label={`${titleOf(event)}, ${timeLabel(event)}`}
                  style={colourVar(colourOf(event, calendars))}
                  className={cn(
                    'flex min-w-0 items-center gap-1 truncate rounded px-1 text-left text-xs leading-5',
                    event.allDay ? 'cal-event' : 'hover:bg-hover',
                    event.id === props.selectedId && 'ring-2 ring-accent',
                  )}
                >
                  {!event.allDay && (
                    <>
                      <span className="cal-swatch size-1.5 shrink-0 rounded-full" />
                      <span className="shrink-0 text-muted">
                        {formatTime(minutesOf(event.start))}
                      </span>
                    </>
                  )}
                  <span className="truncate">{titleOf(event)}</span>
                </button>
              ))}
              {more > 0 && (
                <button
                  type="button"
                  onClick={() => props.onPickDay(day)}
                  className="self-start rounded px-1 text-xs text-muted hover:bg-hover"
                >
                  {more + 1} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface AgendaProps {
  days: string[];
  today: string;
  events: CalEvent[];
  calendars: Map<string, Calendar>;
  selectedId: string | null;
  onOpen: (event: CalEvent) => void;
}

/** The agenda: the coming days that have events, as a scrolling list. */
export function AgendaView(props: AgendaProps) {
  const { days, today, events, calendars } = props;
  const withEvents = days
    .map((day) => ({ day, list: eventsOn(events, day) }))
    .filter((d) => d.list.length > 0);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" role="region" aria-label="Calendar">
      {withEvents.length === 0 && (
        <p className="p-8 text-center text-sm text-muted">Nothing scheduled in these days.</p>
      )}
      <ol className="mx-auto flex max-w-3xl flex-col px-4 py-2">
        {withEvents.map(({ day, list }) => (
          <li
            key={day}
            className="flex gap-4 border-b border-line py-3"
            aria-label={formatFullDay(day)}
          >
            <div className="w-28 shrink-0 text-sm">
              <div className={cn('font-semibold', day === today && 'text-accent')}>
                {formatWeekday(day)} {dayNumber(day)}
              </div>
              <div className="text-xs text-muted">
                {day === today ? 'Today' : formatFullDay(day)}
              </div>
            </div>
            <ul className="flex min-w-0 flex-1 flex-col gap-1">
              {list.map((event) => (
                <li key={event.id}>
                  <button
                    type="button"
                    data-event-id={event.id}
                    aria-pressed={event.id === props.selectedId}
                    onClick={() => props.onOpen(event)}
                    aria-label={`${titleOf(event)}, ${timeLabel(event)}`}
                    style={colourVar(colourOf(event, calendars))}
                    className={cn(
                      'flex w-full items-center gap-3 rounded px-2 py-1 text-left text-sm hover:bg-hover',
                      event.id === props.selectedId && 'bg-active',
                    )}
                  >
                    <span className="cal-swatch size-2.5 shrink-0 rounded-full" />
                    <span className="w-40 shrink-0 text-xs text-muted">{timeLabel(event)}</span>
                    <span className="truncate">{titleOf(event)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
