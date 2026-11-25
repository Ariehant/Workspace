import { describe, expect, it } from 'vitest';
import { parseDay } from './parse-date';

// A Sunday.
const today = '2026-11-22';

describe('go to date', () => {
  it('reads ISO dates, and refuses impossible ones', () => {
    expect(parseDay('2026-12-25', today)).toBe('2026-12-25');
    expect(parseDay('2026-2-30', today)).toBeNull();
  });

  it('reads relative words', () => {
    expect(parseDay('today', today)).toBe('2026-11-22');
    expect(parseDay('Tomorrow', today)).toBe('2026-11-23');
    expect(parseDay('yesterday', today)).toBe('2026-11-21');
    expect(parseDay('next week', today)).toBe('2026-11-29');
    expect(parseDay('next month', today)).toBe('2026-12-22');
  });

  it('reads weekdays as the next one', () => {
    expect(parseDay('friday', today)).toBe('2026-11-27');
    expect(parseDay('mon', today)).toBe('2026-11-23');
    expect(parseDay('sunday', today)).toBe('2026-11-29');
    expect(parseDay('next tuesday', today)).toBe('2026-11-24');
  });

  it('reads a month and day, the next time it comes', () => {
    expect(parseDay('dec 25', today)).toBe('2026-12-25');
    expect(parseDay('25 December', today)).toBe('2026-12-25');
    expect(parseDay('March 3rd', today)).toBe('2027-03-03');
    expect(parseDay('November 22', today)).toBe('2026-11-22');
    expect(parseDay('Jan 5, 2028', today)).toBe('2028-01-05');
  });

  it('returns null for anything else', () => {
    expect(parseDay('', today)).toBeNull();
    expect(parseDay('standup', today)).toBeNull();
    expect(parseDay('fr', today)).toBeNull();
  });
});
