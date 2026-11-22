/**
 * Shows operating-system notifications before events (HANDOFF.md 1), from the cache.
 *
 * It checks at least once a minute (so sleep, wake and clock changes are noticed), and at once
 * after a sync or an edit. A reminder shown is remembered in the cache, so a restart doesn't
 * show it again; one missed while the computer slept still shows until shortly after the start.
 */
import { addDays, today } from '../shared/dates';
import { dueReminders, type Reminder } from '../shared/reminders';
import type { CalEvent, Calendar } from '../shared/types';
import type { Cache } from './cache';

export const MAX_WAIT_MS = 60_000;
export const SNOOZE_MS = 5 * 60_000;
const KEEP_SHOWN_MS = 7 * 24 * 3600_000;

export interface NotifierOptions {
  cache: Cache;
  /** Show a notification (`snoozed`: the reminder came back after a snooze). */
  show: (reminder: Reminder, calendar: Calendar | undefined, snoozed: boolean) => void;
  now?: () => number;
}

export class Notifier {
  private readonly cache: Cache;
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  /** Snoozed reminders: event id → when to show it again. */
  private readonly snoozed = new Map<string, number>();

  constructor(private readonly options: NotifierOptions) {
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
  }

  /** Show what's due, and set the timer for the next check. */
  check = () => {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const now = this.now();
    const day = today(new Date(now));
    const events = this.cache.eventsBetween(addDays(day, -1), addDays(day, 1));
    const calendars = new Map(this.cache.calendars().map((c) => [c.id, c]));
    const { due, next } = dueReminders(events, calendars, now, (key) =>
      this.cache.wasNotified(key),
    );
    for (const reminder of due) {
      this.cache.markNotified(reminder.key, now);
      this.options.show(reminder, calendars.get(reminder.event.calendarId), false);
    }
    let soonest = next;
    for (const [eventId, at] of this.snoozed) {
      const event = this.cache.event(eventId);
      if (!event) {
        this.snoozed.delete(eventId);
      } else if (at <= now) {
        this.snoozed.delete(eventId);
        this.options.show(snoozeReminder(event, at), calendars.get(event.calendarId), true);
      } else if (soonest === null || at < soonest) {
        soonest = at;
      }
    }
    this.cache.pruneNotified(now - KEEP_SHOWN_MS);
    const wait = soonest === null ? MAX_WAIT_MS : Math.min(MAX_WAIT_MS, Math.max(0, soonest - now));
    this.timer = setTimeout(this.check, wait);
    this.timer.unref?.();
  };

  /** Remind again about an event in five minutes. */
  snooze(eventId: string, ms = SNOOZE_MS) {
    this.snoozed.set(eventId, this.now() + ms);
    this.check();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

const snoozeReminder = (event: CalEvent, at: number): Reminder => ({
  event,
  at,
  startsAt: at,
  key: `${event.id}|snooze|${at}`,
});
