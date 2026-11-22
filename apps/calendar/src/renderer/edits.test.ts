import { describe, expect, it } from 'vitest';
import {
  draggedRange,
  moved,
  resized,
  toAllDay,
  toTimed,
  withAllDay,
  withEnd,
  withStart,
} from './edits';

const timed = (start: string, end: string, endSet = true) => ({
  allDay: false,
  start,
  end,
  endSet,
});

describe('dragging on the grid', () => {
  it('creates from a drag, snapped to quarter hours, in either direction', () => {
    expect(draggedRange('2026-11-24', 9 * 60 + 7, '2026-11-24', 10 * 60 + 22)).toEqual(
      timed('2026-11-24T09:00', '2026-11-24T10:15'),
    );
    expect(draggedRange('2026-11-24', 11 * 60, '2026-11-24', 10 * 60)).toEqual(
      timed('2026-11-24T10:00', '2026-11-24T11:00'),
    );
  });

  it('makes a click (no drag) an hour long', () => {
    expect(draggedRange('2026-11-24', 14 * 60, '2026-11-24', 14 * 60 + 3)).toEqual(
      timed('2026-11-24T14:00', '2026-11-24T15:00'),
    );
  });

  it('moves keeping the length, across midnight too', () => {
    expect(moved(timed('2026-11-24T23:00', '2026-11-25T00:30'), 1, 30)).toEqual(
      timed('2026-11-25T23:30', '2026-11-26T01:00'),
    );
    expect(
      moved({ allDay: true, start: '2026-11-24', end: '2026-11-26', endSet: true }, -2, 0),
    ).toEqual({ allDay: true, start: '2026-11-22', end: '2026-11-24', endSet: true });
  });

  it('resizes to at least a quarter hour, and sets an end on a row that had none', () => {
    expect(
      resized(timed('2026-11-24T10:00', '2026-11-24T11:00', false), '2026-11-24', 11 * 60 + 40),
    ).toEqual(timed('2026-11-24T10:00', '2026-11-24T11:45'));
    expect(resized(timed('2026-11-24T10:00', '2026-11-24T11:00'), '2026-11-24', 9 * 60)).toEqual(
      timed('2026-11-24T10:00', '2026-11-24T10:15'),
    );
  });

  it('switches between the grid and the all-day row', () => {
    expect(toAllDay(timed('2026-11-24T10:00', '2026-11-24T11:00'), '2026-11-25')).toEqual({
      allDay: true,
      start: '2026-11-25',
      end: '2026-11-25',
      endSet: false,
    });
    // An event ending at midnight touches one day only.
    expect(toAllDay(timed('2026-11-24T22:00', '2026-11-25T00:00'), '2026-11-24').end).toBe(
      '2026-11-24',
    );
    expect(toTimed('2026-11-24', 13 * 60 + 10)).toEqual(
      timed('2026-11-24T13:15', '2026-11-24T14:15'),
    );
  });
});

describe('panel fields', () => {
  it('moves the end with the start, and keeps the end after the start', () => {
    const t = timed('2026-11-24T10:00', '2026-11-24T11:30');
    expect(withStart(t, '2026-11-25T09:00')).toEqual(timed('2026-11-25T09:00', '2026-11-25T10:30'));
    expect(withEnd(t, '2026-11-24T09:00')).toEqual(timed('2026-11-24T10:00', '2026-11-24T10:15'));
    const allDay = { allDay: true, start: '2026-11-24', end: '2026-11-25', endSet: true };
    expect(withStart(allDay, '2026-11-28')).toEqual({
      ...allDay,
      start: '2026-11-28',
      end: '2026-11-29',
    });
  });

  it('switches all day on and off', () => {
    const t = timed('2026-11-24T10:00', '2026-11-24T11:00');
    const allDay = withAllDay(t, true);
    expect(allDay).toEqual({ allDay: true, start: '2026-11-24', end: '2026-11-24', endSet: false });
    expect(withAllDay(allDay, false)).toEqual(timed('2026-11-24T09:00', '2026-11-24T10:00'));
  });
});
