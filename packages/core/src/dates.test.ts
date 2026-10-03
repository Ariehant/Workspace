import { describe, expect, it } from 'vitest';
import { formatDate, fromIsoDate, parseDate, reminderTime, toIsoDate } from './dates';

// Thursday 1 Oct 2026, mid-morning.
const now = new Date(2026, 9, 1, 10, 30);
const iso = (q: string) => {
  const d = parseDate(q, now);
  return d ? toIsoDate(d) : null;
};

describe('parseDate', () => {
  it('understands relative days', () => {
    expect(iso('today')).toBe('2026-10-01');
    expect(iso('tod')).toBe('2026-10-01');
    expect(iso('Tomorrow')).toBe('2026-10-02');
    expect(iso('yesterday')).toBe('2026-09-30');
    expect(iso('in 3 days')).toBe('2026-10-04');
    expect(iso('in 2 weeks')).toBe('2026-10-15');
  });

  it('understands weekdays', () => {
    expect(iso('friday')).toBe('2026-10-02'); // the coming Friday
    expect(iso('thu')).toBe('2026-10-08'); // today is Thursday: next week's
    expect(iso('next mon')).toBe('2026-10-05');
    expect(iso('next thursday')).toBe('2026-10-08');
    expect(iso('last monday')).toBe('2026-09-28');
  });

  it('understands calendar dates', () => {
    expect(iso('2026-12-24')).toBe('2026-12-24');
    expect(iso('2026-2-3')).toBe('2026-02-03');
    expect(iso('oct 5')).toBe('2026-10-05');
    expect(iso('5 october 2027')).toBe('2027-10-05');
    expect(iso('january 15')).toBe('2027-01-15'); // next occurrence
    expect(iso('sept 30')).toBe('2027-09-30');
  });

  it('rejects non-dates and impossible dates', () => {
    for (const q of ['', 't', 'robot', 'feb 30', '2026-02-31', 'in 3 years', 'mo', '13/12/2026']) {
      expect(iso(q)).toBeNull();
    }
  });
});

describe('formatDate', () => {
  it('uses relative words near today', () => {
    expect(formatDate('2026-10-01', now)).toBe('Today');
    expect(formatDate('2026-10-02', now)).toBe('Tomorrow');
    expect(formatDate('2026-09-30', now)).toBe('Yesterday');
    expect(formatDate('2026-10-05', now)).toBe('Monday');
    expect(formatDate('2026-12-24', now)).toBe('Dec 24, 2026');
  });
});

describe('reminders', () => {
  it('fire at 9:00 local on the day', () => {
    expect(reminderTime('2026-10-02')).toBe(new Date(2026, 9, 2, 9).getTime());
    expect(fromIsoDate('nope')).toBeNull();
  });
});
