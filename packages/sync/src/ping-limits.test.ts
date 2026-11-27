import { describe, expect, it } from 'vitest';
import { CLIENT_PING_LIMITS, PingLimiter } from './ping-limits';

describe('PingLimiter', () => {
  it('keeps the gap between checks and the hourly count', () => {
    const limiter = new PingLimiter({ minGapMs: 10_000, perHour: 3 });
    expect(limiter.take(0)).toBe(0);
    expect(limiter.take(4_000)).toBe(6_000);
    expect(limiter.take(10_000)).toBe(0);
    expect(limiter.take(20_000)).toBe(0);
    // The fourth in the hour waits until the first is an hour old.
    expect(limiter.take(30_000)).toBe(3_570_000);
    expect(limiter.take(3_600_000)).toBe(0);
  });

  it('lets a client check every 20 s for an hour', () => {
    const limiter = new PingLimiter(CLIENT_PING_LIMITS);
    for (let t = 0; t < 3_600_000; t += 20_000) expect(limiter.take(t)).toBe(0);
  });
});
