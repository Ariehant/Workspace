import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveEvents } from '../../shared/google';
import { ianaZone, IcsParseError, parseIcs, safeId } from './parse';

const fixture = (name: string) =>
  readFileSync(new URL(`../../../test/fixtures/ics/${name}`, import.meta.url), 'utf8');

const calendar = { id: 'ics1', timeZone: 'Asia/Kolkata', accessRole: 'reader' };
const shown = (ics: string, zone: string, from = '2026-01-01', to = '2027-12-31') =>
  deriveEvents(calendar, parseIcs(ics).items, { from, to }, zone)
    .map((e) => `${e.title} ${e.start}${e.allDay ? '' : `–${e.end.slice(11)}`}`)
    .sort();

describe('reading iCalendar feeds', () => {
  it('reads a holiday feed: its name, zone, all-day days and a yearly series', () => {
    const feed = parseIcs(fixture('holidays.ics'));
    expect(feed.name).toBe('Holidays in India');
    expect(feed.timeZone).toBe('Asia/Kolkata');
    expect(shown(fixture('holidays.ics'), 'Asia/Kolkata')).toEqual([
      'Christmas 2026-12-25',
      'Diwali/Deepavali 2026-11-08',
      'Republic Day 2026-01-26',
      'Republic Day 2027-01-26',
    ]);
    const diwali = deriveEvents(
      calendar,
      feed.items,
      { from: '2026-11-01', to: '2026-11-30' },
      'UTC',
    )[0]!;
    expect(diwali).toMatchObject({
      allDay: true,
      start: '2026-11-08',
      end: '2026-11-08',
      floating: false,
    });
    expect(diwali.extra).toEqual([{ name: 'Description', value: 'Public holiday' }]);
    // A UID the calendar can't use as an id is replaced by its hash.
    expect(diwali.sourceId).toMatch(/^h[\w-]+$/);
  });

  it("reads Outlook's feeds: Windows zone names, exceptions, cancelled occurrences", () => {
    // In Kolkata: Berlin's 09:00 is 13:30; a Lab Time (+05:30) 10:00 is 10:00; Berlin's 12:00
    // is 16:30; 08:00 UTC is 13:30; the floating lunch stays at 12:30.
    expect(shown(fixture('outlook.ics'), 'Asia/Kolkata')).toEqual([
      'Floating lunch 2026-11-06T12:30–13:30',
      'Lab standup 2026-11-04T10:00–10:45',
      'Mozilla-style zone 2026-11-05T16:30–17:30',
      'UTC call 2026-11-06T13:30–14:30',
      'Weekly sync (moved) 2026-11-17T18:30–19:00',
      // The 9th is an EXDATE, the 16th moved, the 23rd cancelled.
      'Weekly sync 2026-11-02T13:30–14:00',
    ]);
  });

  it('shows floating times at the same clock time in any zone', () => {
    const inLondon = shown(fixture('outlook.ics'), 'Europe/London');
    expect(inLondon).toContain('Floating lunch 2026-11-06T12:30–13:30');
    expect(inLondon).toContain('Weekly sync 2026-11-02T08:00–08:30');
  });

  it('keeps a series in its own zone across a daylight-saving change', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:dst
SUMMARY:Planning
DTSTART;TZID=Europe/Berlin:20261019T090000
DTEND;TZID=Europe/Berlin:20261019T100000
RRULE:FREQ=WEEKLY;COUNT=2
END:VEVENT
END:VCALENDAR`;
    expect(shown(ics, 'UTC')).toEqual([
      'Planning 2026-10-19T07:00–08:00',
      'Planning 2026-10-26T08:00–09:00',
    ]);
  });

  it('reads floating series and their exceptions by clock time', () => {
    const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:gym
SUMMARY:Gym
DTSTART:20261102T070000
DURATION:PT1H
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
BEGIN:VEVENT
UID:gym
RECURRENCE-ID:20261103T070000
SUMMARY:Gym (late)
DTSTART:20261103T090000
DTEND:20261103T100000
END:VEVENT
END:VCALENDAR`;
    expect(shown(ics, 'America/New_York')).toEqual([
      'Gym (late) 2026-11-03T09:00–10:00',
      'Gym 2026-11-02T07:00–08:00',
      'Gym 2026-11-04T07:00–08:00',
    ]);
  });

  it("refuses what isn't a calendar", () => {
    expect(() => parseIcs('<html>Not found</html>')).toThrow(IcsParseError);
    expect(() => parseIcs('BEGIN:VCARD\nVERSION:4.0\nEND:VCARD')).toThrow(IcsParseError);
  });

  it('names IANA zones from what feeds write', () => {
    expect(ianaZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(ianaZone('"Asia/Calcutta"')).toBe('Asia/Kolkata');
    expect(ianaZone('India Standard Time')).toBe('Asia/Kolkata');
    expect(ianaZone('/mozilla.org/20050126_1/America/New_York')).toBe('America/New_York');
    expect(ianaZone('Lab Time')).toBeNull();
    expect(safeId('abc-123_X')).toBe('abc-123_X');
    expect(safeId('a@b.c')).toBe(safeId('a@b.c'));
    expect(safeId('a@b.c')).not.toBe(safeId('a@b.d'));
  });
});
