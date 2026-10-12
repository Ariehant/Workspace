import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, clampZoom, formatZoom, stepZoom } from './zoom';

describe('zoom', () => {
  it('steps in and out through the levels', () => {
    expect(stepZoom(1, 'in')).toBe(1.1);
    expect(stepZoom(1.1, 'in')).toBe(1.25);
    expect(stepZoom(1, 'out')).toBe(0.9);
    expect(stepZoom(0.9, 'out')).toBe(0.8);
  });

  it('stops at both ends', () => {
    expect(stepZoom(MAX_ZOOM, 'in')).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, 'out')).toBe(MIN_ZOOM);
  });

  it('moves from a level between steps to the nearest step that way', () => {
    expect(stepZoom(1.05, 'in')).toBe(1.1);
    expect(stepZoom(1.05, 'out')).toBe(1);
    // Rounding from Chromium's zoom levels doesn't count as being between steps.
    expect(stepZoom(1.0999999, 'in')).toBe(1.25);
  });

  it('keeps stored values in range', () => {
    expect(clampZoom(10)).toBe(MAX_ZOOM);
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom('big')).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(clampZoom(undefined)).toBe(1);
  });

  it('formats as a percentage', () => {
    expect(formatZoom(1.1)).toBe('110%');
    expect(formatZoom(0.67)).toBe('67%');
  });
});
