import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDay,
  formatPlainNumber,
  formatTimeOfDay,
  regionChoices,
  regionOf,
  resolveRegion,
} from './region';

const day = new Date(2026, 10, 17, 15, 5); // Tuesday 17 November 2026, 15:05

describe('regions', () => {
  it('takes the formats from the region', () => {
    expect(resolveRegion({ region: 'US' })).toMatchObject({
      locale: 'en-US',
      date: 'full',
      time: '12h',
      weekStart: 0,
    });
    expect(resolveRegion({ region: 'GB' })).toMatchObject({ time: '24h', weekStart: 1 });
    expect(resolveRegion({ region: 'DE' })).toMatchObject({ time: '24h', weekStart: 1 });
    expect(resolveRegion({ region: 'IN' })).toMatchObject({ time: '12h', weekStart: 0 });
  });

  it('defaults to the system locale, and to the US when that has no region', () => {
    expect(resolveRegion({}, 'de-AT').code).toBe('AT');
    expect(resolveRegion({}, 'hi-IN').code).toBe('IN');
    expect(resolveRegion({}, 'not a locale').code).toBe('US');
    expect(regionOf('fr')).toBe('FR'); // a bare language gets its likely region
  });

  it('lets each format be set on its own', () => {
    const r = resolveRegion({ region: 'US', date: 'dmy', time: '24h', weekStart: 1 });
    expect(r).toMatchObject({ locale: 'en-US', date: 'dmy', time: '24h', weekStart: 1 });
    // Values that aren't formats are ignored.
    expect(resolveRegion({ region: 'US', date: 'bad' as never }).date).toBe('full');
  });

  it('formats days, times and numbers the region’s way', () => {
    const us = resolveRegion({ region: 'US' });
    const gb = resolveRegion({ region: 'GB' });
    const de = resolveRegion({ region: 'DE' });
    const india = resolveRegion({ region: 'IN' });
    expect(formatDay(day, 'full', us)).toBe('Nov 17, 2026');
    expect(formatDay(day, 'full', gb)).toBe('17 Nov 2026');
    expect(formatDay(day, 'dmy', us)).toBe('17/11/2026');
    expect(formatDay(day, 'ymd', us)).toBe('2026/11/17');
    expect(formatTimeOfDay(day, '12h')).toBe('3:05 PM');
    expect(formatTimeOfDay(day, '24h')).toBe('15:05');
    expect(formatDateTime(day, gb)).toBe('17 Nov 2026 15:05');
    expect(formatPlainNumber(1234.5, { grouping: true }, us)).toBe('1,234.5');
    expect(formatPlainNumber(1234.5, { grouping: true }, de)).toBe('1.234,5');
    expect(formatPlainNumber(1234.5, {}, de)).toBe('1234,5');
    expect(formatPlainNumber(1234567, { grouping: true }, india)).toBe('12,34,567');
  });

  it('offers regions by their English names', () => {
    const choices = regionChoices();
    expect(choices.find((c) => c.code === 'IN')?.name).toBe('India');
    expect(choices.map((c) => c.name)).toEqual(
      [...choices.map((c) => c.name)].sort((a, b) => a.localeCompare(b)),
    );
  });
});
