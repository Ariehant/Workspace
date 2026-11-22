/** Where events go in the day and week grids (pure, so it can be tested). */
import { addDays, diffDays, dayOf, minutesOf } from '../shared/dates';
import type { CalEvent } from '../shared/types';

/** The shortest an event is drawn, in minutes (so a 5-minute event can still be read). */
export const MIN_MINUTES = 20;

/** A timed event's part on one day of the grid. */
export interface TimedPiece {
  event: CalEvent;
  day: string;
  /** Minutes since midnight. */
  top: number;
  bottom: number;
  /** Its column among the events it overlaps, and how many columns they need. */
  column: number;
  columns: number;
  /** The event started on an earlier day / goes on to a later one. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/** An all-day event's bar in the row above the grid. */
export interface AllDayBar {
  event: CalEvent;
  /** Index of the first day shown, and how many days it covers. */
  start: number;
  span: number;
  lane: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

const DAY_MINUTES = 24 * 60;

/** Split timed events into per-day pieces for `days`, and give overlapping pieces columns. */
export function layoutTimed(events: CalEvent[], days: string[]): TimedPiece[] {
  const shown = new Set(days);
  const byDay = new Map<string, Omit<TimedPiece, 'column' | 'columns'>[]>();
  for (const event of events) {
    if (event.allDay) continue;
    const first = dayOf(event.start);
    const endDay = dayOf(event.end);
    const endMin = minutesOf(event.end);
    // An event ending at 00:00 ends the day before.
    const last = endMin === 0 && endDay > first ? addDays(endDay, -1) : endDay;
    for (let day = first; day <= last; day = addDays(day, 1)) {
      if (!shown.has(day)) continue;
      const top = day === first ? minutesOf(event.start) : 0;
      const bottom = day === endDay ? endMin : DAY_MINUTES;
      const list = byDay.get(day) ?? [];
      list.push({
        event,
        day,
        top,
        bottom: Math.min(DAY_MINUTES, Math.max(bottom, top + MIN_MINUTES)),
        continuesBefore: day !== first,
        continuesAfter: day !== last,
      });
      byDay.set(day, list);
    }
  }

  const out: TimedPiece[] = [];
  for (const day of days) {
    const pieces = (byDay.get(day) ?? []).sort(
      (a, b) => a.top - b.top || b.bottom - a.bottom || a.event.title.localeCompare(b.event.title),
    );
    // Groups of pieces that overlap one another (directly or through others).
    let group: (typeof pieces)[number][] = [];
    let groupEnd = -1;
    const flush = () => {
      const columnEnds: number[] = [];
      const placed = group.map((piece) => {
        let column = columnEnds.findIndex((end) => end <= piece.top);
        if (column === -1) column = columnEnds.length;
        columnEnds[column] = piece.bottom;
        return { ...piece, column };
      });
      for (const p of placed) out.push({ ...p, columns: columnEnds.length });
      group = [];
      groupEnd = -1;
    };
    for (const piece of pieces) {
      if (group.length && piece.top >= groupEnd) flush();
      group.push(piece);
      groupEnd = Math.max(groupEnd, piece.bottom);
    }
    if (group.length) flush();
  }
  return out;
}

/** All-day events as bars across `days` (consecutive), in lanes that don't overlap. */
export function layoutAllDay(
  events: CalEvent[],
  days: string[],
): { bars: AllDayBar[]; lanes: number } {
  if (days.length === 0) return { bars: [], lanes: 0 };
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const visible = events
    .filter((e) => e.allDay && e.end >= first && e.start <= last)
    .sort(
      (a, b) =>
        a.start.localeCompare(b.start) ||
        diffDays(b.start, b.end) - diffDays(a.start, a.end) ||
        a.title.localeCompare(b.title),
    );
  const laneEnds: number[] = [];
  const bars: AllDayBar[] = [];
  for (const event of visible) {
    const start = Math.max(0, diffDays(first, event.start));
    const end = Math.min(days.length - 1, diffDays(first, event.end));
    let lane = laneEnds.findIndex((e) => e < start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    bars.push({
      event,
      start,
      span: end - start + 1,
      lane,
      continuesBefore: event.start < first,
      continuesAfter: event.end > last,
    });
  }
  return { bars, lanes: laneEnds.length };
}

/** `count` consecutive days from `start`. */
export const daysFrom = (start: string, count: number): string[] =>
  Array.from({ length: count }, (_, i) => addDays(start, i));

/** The last day an event touches (a timed event ending at 00:00 ends the day before). */
export function lastDayOf(event: Pick<CalEvent, 'allDay' | 'start' | 'end'>): string {
  if (event.allDay) return event.end;
  const endDay = dayOf(event.end);
  return minutesOf(event.end) === 0 && endDay > dayOf(event.start) ? addDays(endDay, -1) : endDay;
}
