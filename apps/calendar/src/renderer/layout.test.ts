import { describe, expect, it } from 'vitest';
import type { CalEvent } from '../shared/types';
import { daysFrom, layoutAllDay, layoutTimed } from './layout';

const ev = (title: string, start: string, end: string): CalEvent => ({
  id: title,
  calendarId: 'c',
  sourceId: title,
  title,
  allDay: start.length === 10,
  start,
  end,
  endSet: true,
  floating: start.length > 10,
  url: null,
  colour: null,
  extra: [],
  lastEdited: '',
});

const week = daysFrom('2026-11-23', 7);

describe('timed events', () => {
  it('places an event by its wall-clock minutes', () => {
    const [piece] = layoutTimed([ev('A', '2026-11-24T10:00', '2026-11-24T11:30')], week);
    expect(piece).toMatchObject({
      day: '2026-11-24',
      top: 600,
      bottom: 690,
      column: 0,
      columns: 1,
    });
  });

  it('gives overlapping events side-by-side columns, and others the full width', () => {
    const pieces = layoutTimed(
      [
        ev('A', '2026-11-24T09:00', '2026-11-24T11:00'),
        ev('B', '2026-11-24T10:00', '2026-11-24T12:00'),
        ev('C', '2026-11-24T11:00', '2026-11-24T12:00'),
        ev('D', '2026-11-24T14:00', '2026-11-24T15:00'),
      ],
      week,
    );
    const by = Object.fromEntries(pieces.map((p) => [p.event.title, p]));
    expect(by.A).toMatchObject({ column: 0, columns: 2 });
    expect(by.B).toMatchObject({ column: 1, columns: 2 });
    // C starts when A ends, so it reuses A's column.
    expect(by.C).toMatchObject({ column: 0, columns: 2 });
    expect(by.D).toMatchObject({ column: 0, columns: 1 });
  });

  it('splits an event across midnight, and ends one at 00:00 on the day before', () => {
    const pieces = layoutTimed(
      [
        ev('Late', '2026-11-24T22:00', '2026-11-25T01:00'),
        ev('To midnight', '2026-11-26T23:00', '2026-11-27T00:00'),
      ],
      week,
    );
    expect(pieces.map((p) => [p.event.title, p.day, p.top, p.bottom])).toEqual([
      ['Late', '2026-11-24', 1320, 1440],
      ['Late', '2026-11-25', 0, 60],
      ['To midnight', '2026-11-26', 1380, 1440],
    ]);
    expect(pieces[0]).toMatchObject({ continuesBefore: false, continuesAfter: true });
    expect(pieces[1]).toMatchObject({ continuesBefore: true, continuesAfter: false });
  });

  it('draws very short events tall enough to read', () => {
    const [piece] = layoutTimed([ev('Ping', '2026-11-24T10:00', '2026-11-24T10:05')], week);
    expect(piece!.bottom - piece!.top).toBe(20);
  });

  it('leaves out days not shown', () => {
    expect(layoutTimed([ev('Next', '2026-12-01T10:00', '2026-12-01T11:00')], week)).toEqual([]);
  });
});

describe('all-day events', () => {
  it('puts overlapping bars in separate lanes, longest first', () => {
    const { bars, lanes } = layoutAllDay(
      [
        ev('Day', '2026-11-24', '2026-11-24'),
        ev('Trip', '2026-11-24', '2026-11-27'),
        ev('Later', '2026-11-28', '2026-11-28'),
      ],
      week,
    );
    const by = Object.fromEntries(bars.map((b) => [b.event.title, b]));
    expect(by.Trip).toMatchObject({ start: 1, span: 4, lane: 0 });
    expect(by.Day).toMatchObject({ start: 1, span: 1, lane: 1 });
    expect(by.Later).toMatchObject({ start: 5, span: 1, lane: 0 });
    expect(lanes).toBe(2);
  });

  it('cuts bars at the edges of the week', () => {
    const { bars } = layoutAllDay([ev('Long', '2026-11-20', '2026-12-02')], week);
    expect(bars[0]).toMatchObject({
      start: 0,
      span: 7,
      continuesBefore: true,
      continuesAfter: true,
    });
  });
});
