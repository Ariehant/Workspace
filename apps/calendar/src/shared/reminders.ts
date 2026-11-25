/**
 * When notifications fire (HANDOFF.md 1): each calendar has a default (none, at start, or some
 * minutes before); all-day events notify at 09:00 on their day. Workspace's own reminders
 * aren't readable through the API, so these come from the calendar's settings only.
 */
import { instantOf } from './dates';
import type { CalEvent, Calendar } from './types';

/** The choices offered: minutes before the start (0 = at the start). */
export const REMINDER_CHOICES = [null, 0, 5, 10, 30, 60] as const;
export const DEFAULT_REMINDER = 10;
/** All-day events notify at this time on their day. */
export const ALL_DAY_REMINDER_MINUTES = 9 * 60;
/** A notification missed (asleep, closed) still shows until this long after the start. */
export const LATE_GRACE_MS = 15 * 60_000;

export interface Reminder {
  event: CalEvent;
  /** When to notify (ms, this machine's clock). */
  at: number;
  /** When the event starts (ms): a reminder isn't worth showing long after. */
  startsAt: number;
  /** Identifies this reminder: moving the event or changing the setting makes a new one. */
  key: string;
}

export function reminderLabel(minutes: number | null): string {
  if (minutes === null) return 'None';
  if (minutes === 0) return 'At the start';
  if (minutes === 60) return '1 hour before';
  return `${minutes} minutes before`;
}

/** An event's reminder in its calendar, or null if the calendar has none. */
export function reminderFor(event: CalEvent, calendar: Calendar | undefined): Reminder | null {
  if (
    !calendar ||
    !calendar.visible ||
    calendar.reminder === null ||
    calendar.reminder === undefined
  )
    return null;
  const minutes = calendar.reminder;
  if (event.allDay) {
    const at = instantOf(event.start).getTime() + ALL_DAY_REMINDER_MINUTES * 60_000;
    return { event, at, startsAt: at, key: `${event.id}|${event.start}|all-day` };
  }
  const startsAt = instantOf(event.start).getTime();
  return {
    event,
    at: startsAt - minutes * 60_000,
    startsAt,
    key: `${event.id}|${event.start}|${minutes}`,
  };
}

/** Reminders due now (not yet shown, and not stale), and when the next one is. */
export function dueReminders(
  events: CalEvent[],
  calendars: Map<string, Calendar>,
  now: number,
  shown: (key: string) => boolean,
): { due: Reminder[]; next: number | null } {
  const due: Reminder[] = [];
  let next: number | null = null;
  for (const event of events) {
    const reminder = reminderFor(event, calendars.get(event.calendarId));
    if (!reminder || shown(reminder.key)) continue;
    if (reminder.at <= now) {
      if (now <= reminder.startsAt + LATE_GRACE_MS) due.push(reminder);
    } else if (next === null || reminder.at < next) {
      next = reminder.at;
    }
  }
  due.sort((a, b) => a.at - b.at);
  return { due, next };
}
