/**
 * How often a connection may ask who's there (the online check). Clients keep to
 * `CLIENT_PING_LIMITS` and say when they may ask again; the server enforces the looser
 * `SERVER_PING_LIMITS` (so a little network delay between two checks doesn't drop one), and
 * drops checks beyond them.
 */
export interface PingLimits {
  /** The shortest time between two checks. */
  minGapMs: number;
  /** At most this many checks an hour. */
  perHour: number;
}

/** One check per 10 s, and as many an hour as checking every 20 s all hour long. */
export const CLIENT_PING_LIMITS: PingLimits = { minGapMs: 10_000, perHour: 180 };
export const SERVER_PING_LIMITS: PingLimits = { minGapMs: 5_000, perHour: 240 };

const HOUR_MS = 3_600_000;

export class PingLimiter {
  private times: number[] = [];

  constructor(private readonly limits: PingLimits) {}

  /** Counts a check now if it's within the limits: 0, else the ms until one would be. */
  take(now: number): number {
    this.times = this.times.filter((t) => now - t < HOUR_MS);
    const last = this.times[this.times.length - 1];
    let wait = last === undefined ? 0 : Math.max(0, last + this.limits.minGapMs - now);
    if (this.times.length >= this.limits.perHour) {
      wait = Math.max(wait, this.times[this.times.length - this.limits.perHour]! + HOUR_MS - now);
    }
    if (wait === 0) this.times.push(now);
    return wait;
  }
}
