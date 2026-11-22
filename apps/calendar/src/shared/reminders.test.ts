import { afterEach, describe, expect, it } from 'vitest';
import { dueReminders, LATE_GRACE_MS, reminderFor, reminderLabel } from './reminders';
import type { CalEvent, Calendar } from './types';

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const calendar = (reminder: number | null, visible = true): Calendar => ({
  id: 'cal',
  accountId: 'acc',
  databaseId: 'db',
  viewId: null,
  name: 'Tasks',
  colour: 'blue',
  visible,
  dateProperty: { id: 'x1', name: 'When' },
  titleProperty: { id: 'title', name: 'Name' },
  people: null,
  colourBy: null,
  reminder,
  status: 'ok',
  statusMessage: null,
});

const event = (id: string, start: string, allDay = false): CalEvent => ({
  id: `cal:${id}`,
  calendarId: 'cal',
  sourceId: id,
  title: id,
  allDay,
  start,
  end: start,
  endSet: false,
  floating: !allDay,
  url: null,
  colour: null,
  extra: [],
  lastEdited: '',
});

const local = (wall: string) => new Date(wall).getTime(); // parsed as local time

describe('reminders', () => {
  it('fires the chosen minutes before a timed event, in local time', () => {
    process.env.TZ = 'Asia/Kolkata';
    const r = reminderFor(event('standup', '2026-11-24T10:00'), calendar(10))!;
    expect(new Date(r.at).toISOString()).toBe('2026-11-24T04:20:00.000Z');
    expect(r.key).toBe('cal:standup|2026-11-24T10:00|10');
  });

  it('fires all-day events at 09:00 on their day', () => {
    process.env.TZ = 'America/Los_Angeles';
    const r = reminderFor(event('offsite', '2026-11-24', true), calendar(30))!;
    expect(new Date(r.at).toISOString()).toBe('2026-11-24T17:00:00.000Z');
  });

  it('has none for a calendar set to none, or hidden', () => {
    expect(reminderFor(event('a', '2026-11-24T10:00'), calendar(null))).toBeNull();
    expect(reminderFor(event('a', '2026-11-24T10:00'), calendar(10, false))).toBeNull();
  });

  it('is a new reminder when the event moves', () => {
    const a = reminderFor(event('a', '2026-11-24T10:00'), calendar(10))!;
    const b = reminderFor(event('a', '2026-11-24T11:00'), calendar(10))!;
    expect(a.key).not.toBe(b.key);
  });

  it('labels the choices', () => {
    expect([null, 0, 5, 60].map(reminderLabel)).toEqual([
      'None',
      'At the start',
      '5 minutes before',
      '1 hour before',
    ]);
  });
});

describe('due reminders', () => {
  const calendars = new Map([['cal', calendar(10)]]);
  const events = [
    event('past', '2026-11-24T08:00'),
    event('soon', '2026-11-24T10:05'),
    event('later', '2026-11-24T12:00'),
  ];

  it('gives what is due now, skips what was shown or is stale, and says when the next is', () => {
    const now = local('2026-11-24T10:00');
    const { due, next } = dueReminders(events, calendars, now, () => false);
    expect(due.map((r) => r.event.sourceId)).toEqual(['soon']);
    expect(next).toBe(local('2026-11-24T11:50'));
    expect(dueReminders(events, calendars, now, (k) => k.startsWith('cal:soon')).due).toEqual([]);
  });

  it('still shows a reminder missed while asleep, until shortly after the start', () => {
    const missed = event('missed', '2026-11-24T09:00');
    const start = local('2026-11-24T09:00');
    expect(dueReminders([missed], calendars, start + LATE_GRACE_MS, () => false).due).toHaveLength(
      1,
    );
    expect(dueReminders([missed], calendars, start + LATE_GRACE_MS + 1, () => false).due).toEqual(
      [],
    );
  });
});
