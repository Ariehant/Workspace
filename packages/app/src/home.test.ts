import { resolveRegion, setRegion } from '@workspace/core';
import { afterEach, describe, expect, it } from 'vitest';
import { greeting, upcomingWhen } from './home';

describe('Home', () => {
  afterEach(() => setRegion(resolveRegion()));

  it('greets by the time of day', () => {
    expect(greeting(new Date(2026, 10, 18, 4, 59))).toBe('Good evening');
    expect(greeting(new Date(2026, 10, 18, 5))).toBe('Good morning');
    expect(greeting(new Date(2026, 10, 18, 11, 59))).toBe('Good morning');
    expect(greeting(new Date(2026, 10, 18, 12))).toBe('Good afternoon');
    expect(greeting(new Date(2026, 10, 18, 18))).toBe('Good evening');
  });

  it('says when a reminder fires: today, tomorrow, a weekday, then a date', () => {
    setRegion(resolveRegion({ region: 'US', time: '12h' }, 'en-US'));
    const now = new Date(2026, 10, 18, 9); // a Wednesday
    const at = (day: number, hour: number) => new Date(2026, 10, day, hour).getTime();
    expect(upcomingWhen(at(18, 15), now)).toBe('Today 3:00 PM');
    expect(upcomingWhen(at(19, 9), now)).toBe('Tomorrow 9:00 AM');
    expect(upcomingWhen(at(23, 9), now)).toBe('Monday 9:00 AM');
    expect(upcomingWhen(at(25, 9), now)).toBe('Nov 25 9:00 AM');
  });
});
