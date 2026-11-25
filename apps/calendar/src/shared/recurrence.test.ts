import { describe, expect, it } from 'vitest';
import { expand, type Series } from './recurrence';
import { basicUtc, instantAt, wallAt, zoneOffset } from './zones';

describe('time zones', () => {
  it('turns wall times into instants and back', () => {
    expect(instantAt('2026-07-01T09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-07-01T07:00:00.000Z',
    );
    expect(instantAt('2026-12-01T09:00', 'Europe/Berlin').toISOString()).toBe(
      '2026-12-01T08:00:00.000Z',
    );
    expect(instantAt('2026-12-01T09:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-12-01T03:30:00.000Z',
    );
    expect(wallAt('2026-12-01T03:30:00Z', 'Asia/Kolkata')).toBe('2026-12-01T09:00');
    expect(wallAt('2026-12-01T03:30:00Z', 'America/Los_Angeles')).toBe('2026-11-30T19:30');
    expect(instantAt('2026-12-01', 'UTC').toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('moves a time in the spring gap forward, and takes the first of a repeated hour', () => {
    // Berlin skips 02:00–03:00 on 2026-03-29 and repeats it on 2026-10-25.
    expect(instantAt('2026-03-29T02:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(wallAt('2026-03-29T01:30:00Z', 'Europe/Berlin')).toBe('2026-03-29T03:30');
    expect(instantAt('2026-10-25T02:30', 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(zoneOffset('Europe/Berlin', Date.parse('2026-10-25T01:30:00Z'))).toBe(3_600_000);
  });

  it("writes instants as Google's ids do", () => {
    expect(basicUtc('2026-12-01T08:00:00.000Z')).toBe('20261201T080000Z');
  });
});

const weekly: Series = {
  allDay: false,
  start: '2026-11-02T09:00',
  timeZone: 'Europe/Berlin',
  rules: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'],
};

const starts = (series: Series, from: string, to: string) =>
  expand(series, from, to).map((o) => o.start);

describe('expanding series', () => {
  it('repeats daily, with COUNT', () => {
    expect(
      starts(
        { allDay: false, start: '2026-11-02T09:00', timeZone: 'UTC', rules: ['RRULE:FREQ=DAILY;COUNT=3'] },
        '2026-10-01',
        '2027-01-01',
      ),
    ).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
      '2026-11-04T09:00:00.000Z',
    ]);
  });

  it('repeats weekly on days, only within the range asked for', () => {
    expect(starts(weekly, '2026-11-09', '2026-11-15')).toEqual([
      '2026-11-09T08:00:00.000Z',
      '2026-11-11T08:00:00.000Z',
    ]);
  });

  it('keeps the wall time across a daylight-saving change in the series\' zone', () => {
    const series: Series = { ...weekly, start: '2026-10-19T09:00', rules: ['RRULE:FREQ=WEEKLY'] };
    expect(starts(series, '2026-10-19', '2026-11-01')).toEqual([
      '2026-10-19T07:00:00.000Z', // CEST
      '2026-10-26T08:00:00.000Z', // CET, the day after the change
    ]);
  });

  it('repeats monthly on a weekday and on a day of the month', () => {
    const second: Series = {
      allDay: false,
      start: '2026-11-10T14:00',
      timeZone: 'UTC',
      rules: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'],
    };
    expect(starts(second, '2026-11-01', '2027-01-31')).toEqual([
      '2026-11-10T14:00:00.000Z',
      '2026-12-08T14:00:00.000Z',
      '2027-01-12T14:00:00.000Z',
    ]);
    const thirtyFirst: Series = { ...second, start: '2026-10-31T14:00', rules: ['RRULE:FREQ=MONTHLY'] };
    // Months without a 31st are skipped (RFC 5545).
    expect(starts(thirtyFirst, '2026-10-01', '2027-01-31')).toEqual([
      '2026-10-31T14:00:00.000Z',
      '2026-12-31T14:00:00.000Z',
      '2027-01-31T14:00:00.000Z',
    ]);
  });

  it('stops at a UTC UNTIL, read on the series\' clock', () => {
    // 08:00Z is 09:00 in Berlin: the occurrence at UNTIL is included.
    const series = { ...weekly, rules: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T080000Z'] };
    expect(starts(series, '2026-11-01', '2026-12-31')).toEqual([
      '2026-11-02T08:00:00.000Z',
      '2026-11-09T08:00:00.000Z',
      '2026-11-16T08:00:00.000Z',
    ]);
    const before = { ...weekly, rules: ['RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261116T075959Z'] };
    expect(starts(before, '2026-11-01', '2026-12-31')).toHaveLength(2);
  });

  it('leaves out EXDATEs and adds RDATEs, in any of their forms', () => {
    const series: Series = {
      ...weekly,
      rules: [
        'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
        'EXDATE;TZID=Europe/Berlin:20261109T090000',
        'EXDATE:20261116T080000Z',
        'RDATE;TZID=Europe/Berlin:20261112T090000',
      ],
    };
    expect(starts(series, '2026-11-01', '2026-12-31')).toEqual([
      '2026-11-02T08:00:00.000Z',
      '2026-11-12T08:00:00.000Z',
      '2026-11-23T08:00:00.000Z',
    ]);
  });

  it('always includes the first occurrence, even off the rule', () => {
    // Starts on a Tuesday, repeats on Mondays.
    const series = { ...weekly, start: '2026-11-03T09:00', rules: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2'] };
    expect(starts(series, '2026-11-01', '2026-11-30')).toEqual([
      '2026-11-03T08:00:00.000Z',
      '2026-11-09T08:00:00.000Z',
    ]);
  });

  it('repeats all-day series by day, with a date UNTIL and EXDATE', () => {
    const series: Series = {
      allDay: true,
      start: '2026-12-24',
      timeZone: 'UTC',
      rules: ['RRULE:FREQ=YEARLY;UNTIL=20281224', 'EXDATE;VALUE=DATE:20271224'],
    };
    expect(starts(series, '2026-01-01', '2030-12-31')).toEqual(['2026-12-24', '2028-12-24']);
  });

  it('ignores rules it cannot read rather than failing', () => {
    expect(
      starts({ ...weekly, rules: ['RRULE:FREQ=NONSENSE', 'X-THING:1'] }, '2026-11-01', '2026-11-30'),
    ).toEqual(['2026-11-02T08:00:00.000Z']);
  });
});
