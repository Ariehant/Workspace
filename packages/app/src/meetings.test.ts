import { describe, expect, it } from 'vitest';
import { byDay, nextHalfHour, upcomingRange } from './meetings';
import { dayHeading, eventTime } from './meetings-view';
import type { UpcomingEvent } from './platform';

const event = (start: string, end = start, allDay = !start.includes('T')): UpcomingEvent => ({
  rowId: start,
  title: start,
  icon: null,
  databaseId: 'db',
  databaseTitle: 'Meetings',
  propertyId: 'date',
  start,
  end: allDay ? `${end.slice(0, 10)}T23:59` : end,
  allDay,
});

describe('Meetings', () => {
  const now = new Date(2026, 11, 1, 9, 10); // Tue 1 Dec 2026, 9:10

  it('asks for now to the end of the 14th day', () => {
    expect(upcomingRange(now)).toEqual({ from: '2026-12-01T09:10', to: '2026-12-15' });
  });

  it('starts new meetings at the next half hour', () => {
    expect(nextHalfHour(now)).toEqual(new Date(2026, 11, 1, 9, 30));
    expect(nextHalfHour(new Date(2026, 11, 1, 9, 30))).toEqual(new Date(2026, 11, 1, 9, 30));
    expect(nextHalfHour(new Date(2026, 11, 1, 9, 30, 5))).toEqual(new Date(2026, 11, 1, 10, 0));
    expect(nextHalfHour(new Date(2026, 11, 1, 23, 45))).toEqual(new Date(2026, 11, 2, 0, 0));
  });

  it('groups events by day, an event that began earlier under today', () => {
    const trip = event('2026-11-29', '2026-12-02');
    const standup = event('2026-12-01T09:30');
    const review = event('2026-12-03T14:00', '2026-12-03T15:00');
    expect(byDay([trip, standup, review], now)).toEqual([
      ['2026-12-01', [trip, standup]],
      ['2026-12-03', [review]],
    ]);
  });

  it('names days and times', () => {
    expect(dayHeading('2026-12-01', now)).toBe('Today');
    expect(dayHeading('2026-12-02', now)).toBe('Tomorrow');
    expect(dayHeading('2026-12-14', now)).not.toMatch(/Today|Tomorrow/);
    expect(eventTime(event('2026-12-01'), '2026-12-01')).toBe('All day');
    expect(eventTime(event('2026-12-03T14:00', '2026-12-03T15:00'), '2026-12-03')).toMatch(
      /2:00 PM – 3:00 PM|14:00 – 15:00/,
    );
    // Began yesterday, ends today: until its end.
    expect(eventTime(event('2026-11-30T22:00', '2026-12-01T01:00'), '2026-12-01')).toMatch(
      /^until (1:00 AM|01:00)$/,
    );
  });
});
