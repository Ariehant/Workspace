/**
 * Failed sign-ins per account: after `limit` failures in `windowMs`, the account refuses
 * password sign-ins until the window passes (whatever the password), which stops
 * guessing spread across many addresses. Kept in memory: a restart forgives.
 */
export class LoginThrottle {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now = () => Date.now(),
  ) {}

  /** Milliseconds until `key` may try again, or 0. */
  blockedFor(key: string): number {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    const left = entry.since + this.windowMs - this.now();
    if (left <= 0) {
      this.failures.delete(key);
      return 0;
    }
    return entry.count >= this.limit ? left : 0;
  }

  fail(key: string): void {
    const entry = this.failures.get(key);
    if (!entry || entry.since + this.windowMs <= this.now()) {
      this.failures.set(key, { count: 1, since: this.now() });
    } else {
      entry.count++;
    }
    if (this.failures.size > 100_000) this.prune();
  }

  succeed(key: string): void {
    this.failures.delete(key);
  }

  private prune() {
    for (const [key, entry] of this.failures) {
      if (entry.since + this.windowMs <= this.now()) this.failures.delete(key);
    }
  }
}
