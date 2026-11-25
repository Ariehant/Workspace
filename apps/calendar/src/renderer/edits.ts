/** New times for drags and panel edits (pure: wall-clock arithmetic, snapped to the grid). */
import {
  addDays,
  addMinutes,
  atMinutes,
  dayOf,
  diffDays,
  diffMinutes,
  minutesOf,
  type EventTime,
} from '../shared/dates';
import type { CalEvent } from '../shared/types';

/** Drags snap to quarter hours. */
export const SNAP_MINUTES = 15;
/** A new event dragged or clicked without a length is an hour long. */
export const NEW_EVENT_MINUTES = 60;

export const snap = (minutes: number, step = SNAP_MINUTES) => Math.round(minutes / step) * step;

export const timeOf = (event: CalEvent): EventTime => ({
  allDay: event.allDay,
  start: event.start,
  end: event.end,
  endSet: event.endSet,
});

/** A new timed event from a drag between two points of the grid (either order). */
export function draggedRange(day1: string, min1: number, day2: string, min2: number): EventTime {
  let a = atMinutes(day1, snap(min1));
  let b = atMinutes(day2, snap(min2));
  if (b < a) [a, b] = [b, a];
  if (diffMinutes(a, b) < SNAP_MINUTES) b = addMinutes(a, NEW_EVENT_MINUTES);
  return { allDay: false, start: a, end: b, endSet: true };
}

/** An event moved by whole days and minutes, keeping its length. */
export function moved(time: EventTime, days: number, minutes: number): EventTime {
  if (time.allDay) {
    return { ...time, start: addDays(time.start, days), end: addDays(time.end, days) };
  }
  const by = days * 24 * 60 + minutes;
  return { ...time, start: addMinutes(time.start, by), end: addMinutes(time.end, by) };
}

/** An event with a new end (dragging its bottom edge), at least a quarter hour long. */
export function resized(time: EventTime, endDay: string, endMinutes: number): EventTime {
  if (time.allDay) {
    const end = endDay < time.start ? time.start : endDay;
    return { ...time, end, endSet: end > time.start };
  }
  let end = atMinutes(endDay, snap(endMinutes));
  if (diffMinutes(time.start, end) < SNAP_MINUTES) end = addMinutes(time.start, SNAP_MINUTES);
  // A resize sets an end, even for a row that had none.
  return { ...time, end, endSet: true };
}

/** A timed event dropped on the all-day row: all day on that day (as many days as it touched). */
export function toAllDay(time: EventTime, day: string): EventTime {
  if (time.allDay) return { ...time, ...moved(time, diffDays(time.start, day), 0) };
  const span = Math.max(0, diffDays(dayOf(time.start), dayOf(addMinutes(time.end, -1))));
  return { allDay: true, start: day, end: addDays(day, span), endSet: span > 0 };
}

/** An all-day event dropped on the grid: an hour at that time. */
export function toTimed(day: string, minutes: number): EventTime {
  const start = atMinutes(day, snap(minutes));
  return { allDay: false, start, end: addMinutes(start, NEW_EVENT_MINUTES), endSet: true };
}

/** The minute of the day an event starts at, for keeping it there across days. */
export const startMinutes = (time: EventTime) => (time.allDay ? 0 : minutesOf(time.start));

/** A time set in the panel's fields: keeps the end after the start, and the length on a move. */
export function withStart(time: EventTime, start: string): EventTime {
  if (time.allDay) {
    const days = diffDays(time.start, start);
    return { ...time, start, end: addDays(time.end, days) };
  }
  const length = diffMinutes(time.start, time.end);
  return { ...time, start, end: addMinutes(start, length) };
}

export function withEnd(time: EventTime, end: string): EventTime {
  if (time.allDay) {
    const last = end < time.start ? time.start : end;
    return { ...time, end: last, endSet: last > time.start };
  }
  const fixed = end <= time.start ? addMinutes(time.start, SNAP_MINUTES) : end;
  return { ...time, end: fixed, endSet: true };
}

/** Switch between all day and timed from the panel. */
export function withAllDay(time: EventTime, allDay: boolean, defaultMinutes = 9 * 60): EventTime {
  if (allDay === time.allDay) return time;
  if (allDay) return toAllDay(time, dayOf(time.start));
  return toTimed(time.start, defaultMinutes);
}
