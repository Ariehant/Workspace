import { afterEach, describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  addMonths,
  diffMinutes,
  instantOf,
  nowWall,
  readApiDate,
  startOfWeek,
  syncWindow,
  today,
  writeApiDate,
} from './dates';

const ZONES = ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati'];
const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

describe('reading date values', () => {
  it('reads a day as an all-day event', () => {
    expect(readApiDate({ start: '2026-11-24', end: null, time_zone: null })).toEqual({
      allDay: true,
      start: '2026-11-24',
      end: '2026-11-24',
      endSet: false,
    });
  });

  it('reads a range of days, including its last day', () => {
    expect(readApiDate({ start: '2026-11-24', end: '2026-11-26' })).toEqual({
      allDay: true,
      start: '2026-11-24',
      end: '2026-11-26',
      endSet: true,
    });
  });

  it('takes a time as written, ignoring the +00:00', () => {
    expect(
      readApiDate({
        start: '2026-11-24T10:00:00.000+00:00',
        end: '2026-11-24T11:30:00.000+00:00',
        time_zone: null,
      }),
    ).toEqual({ allDay: false, start: '2026-11-24T10:00', end: '2026-11-24T11:30', endSet: true });
  });

  it('shows a time with no end as an hour, and remembers it had none', () => {
    expect(readApiDate({ start: '2026-11-24T10:00:00.000+00:00', end: null })).toEqual({
      allDay: false,
      start: '2026-11-24T10:00',
      end: '2026-11-24T11:00',
      endSet: false,
    });
  });

  it('runs an event without an end past midnight into the next day', () => {
    expect(readApiDate({ start: '2026-12-31T23:30:00.000+00:00', end: null })).toMatchObject({
      start: '2026-12-31T23:30',
      end: '2027-01-01T00:30',
    });
  });

  it('keeps a time just before midnight on its own day', () => {
    const t = readApiDate({
      start: '2026-11-24T23:45:00.000+00:00',
      end: '2026-11-25T00:15:00.000+00:00',
    });
    expect(t).toMatchObject({ start: '2026-11-24T23:45', end: '2026-11-25T00:15' });
  });

  it('ignores an end that is not after the start', () => {
    expect(readApiDate({ start: '2026-11-24T10:00', end: '2026-11-24T09:00' })).toMatchObject({
      end: '2026-11-24T11:00',
      endSet: false,
    });
    expect(readApiDate({ start: '2026-11-24', end: '2026-11-20' })).toMatchObject({
      end: '2026-11-24',
      endSet: false,
    });
  });

  it('returns null for an empty or unreadable value', () => {
    expect(readApiDate(null)).toBeNull();
    expect(readApiDate(undefined)).toBeNull();
    expect(readApiDate({ start: 'soon', end: null })).toBeNull();
  });
});

describe('writing date values', () => {
  it('writes times with no zone, to the minute', () => {
    expect(
      writeApiDate({
        allDay: false,
        start: '2026-11-24T10:00',
        end: '2026-11-24T11:00',
        endSet: true,
      }),
    ).toEqual({ start: '2026-11-24T10:00', end: '2026-11-24T11:00' });
  });

  it("doesn't invent an end for a row that had none", () => {
    expect(
      writeApiDate({
        allDay: false,
        start: '2026-11-24T10:00',
        end: '2026-11-24T11:00',
        endSet: false,
      }),
    ).toEqual({ start: '2026-11-24T10:00', end: null });
  });

  it('writes all-day events as days, with an end only for a range', () => {
    expect(
      writeApiDate({ allDay: true, start: '2026-11-24', end: '2026-11-24', endSet: false }),
    ).toEqual({ start: '2026-11-24', end: null });
    expect(
      writeApiDate({ allDay: true, start: '2026-11-24', end: '2026-11-26', endSet: true }),
    ).toEqual({ start: '2026-11-24', end: '2026-11-26' });
  });

  it('never sends a Z or an offset', () => {
    const out = writeApiDate({
      allDay: false,
      start: '2026-11-24T10:00',
      end: '2026-11-24T11:00',
      endSet: true,
    });
    for (const v of [out.start, out.end]) expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('time zones', () => {
  for (const zone of ZONES) {
    it(`shows a 10:00 row at 10:00 and writes back the shown clock time (${zone})`, () => {
      process.env.TZ = zone;
      const read = readApiDate({ start: '2026-11-24T10:00:00.000+00:00', end: null })!;
      expect(read.start).toBe('2026-11-24T10:00');
      // The user drags it 90 minutes later.
      const moved = {
        ...read,
        start: addMinutes(read.start, 90),
        end: addMinutes(read.end, 90),
      };
      expect(writeApiDate(moved)).toEqual({ start: '2026-11-24T11:30', end: null });
    });
  }

  it('reads "now" on the local wall clock', () => {
    const instant = new Date('2026-11-24T04:30:00Z');
    process.env.TZ = 'Asia/Kolkata';
    expect(nowWall(instant)).toBe('2026-11-24T10:00');
    process.env.TZ = 'America/Los_Angeles';
    expect(nowWall(instant)).toBe('2026-11-23T20:30');
    expect(today(instant)).toBe('2026-11-23');
  });

  it('finds the instant of a wall-clock time on this machine', () => {
    process.env.TZ = 'Asia/Kolkata';
    expect(instantOf('2026-11-24T10:00').toISOString()).toBe('2026-11-24T04:30:00.000Z');
    process.env.TZ = 'America/Los_Angeles';
    expect(instantOf('2026-11-24T10:00').toISOString()).toBe('2026-11-24T18:00:00.000Z');
  });

  it('does arithmetic without daylight saving shifting wall-clock times', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 2026-11-01 is the end of daylight saving in the US.
    expect(addMinutes('2026-11-01T00:30', 120)).toBe('2026-11-01T02:30');
    expect(diffMinutes('2026-11-01T00:00', '2026-11-02T00:00')).toBe(24 * 60);
  });
});

describe('calendar arithmetic', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('adds months, keeping the day where it exists', () => {
    expect(addMonths('2026-08-31', -6)).toBe('2026-02-28');
    expect(addMonths('2026-11-22', 12)).toBe('2027-11-22');
  });

  it('finds the start of a week', () => {
    expect(startOfWeek('2026-11-22', 1)).toBe('2026-11-16'); // a Sunday → Monday before
    expect(startOfWeek('2026-11-22', 0)).toBe('2026-11-22');
    expect(startOfWeek('2026-11-24', 1)).toBe('2026-11-23');
  });

  it('keeps 6 months back and 12 ahead', () => {
    process.env.TZ = 'UTC';
    expect(syncWindow(new Date('2026-11-22T12:00:00Z'))).toEqual({
      from: '2026-05-22',
      to: '2027-11-22',
    });
  });
});
