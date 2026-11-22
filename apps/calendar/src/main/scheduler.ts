/**
 * When to sync: on a timer (every minute with the window open, every 5 minutes when the app
 * only runs in the tray), and at once when poked (the window gains focus, the computer wakes,
 * the user asks).
 */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly run: (full: boolean) => Promise<void>,
    private intervalMs: number,
  ) {}

  start() {
    this.stopped = false;
    this.poke();
  }

  /** Sync now (`full`: also sweep for deleted rows), and start the interval again from here. */
  poke(full = false) {
    if (this.stopped) return;
    this.clear();
    void this.run(full)
      .catch(() => {})
      .finally(() => this.schedule());
  }

  setInterval(ms: number) {
    if (ms === this.intervalMs) return;
    this.intervalMs = ms;
    if (this.timer) this.schedule();
  }

  stop() {
    this.stopped = true;
    this.clear();
  }

  private schedule() {
    if (this.stopped) return;
    this.clear();
    this.timer = setTimeout(() => this.poke(), this.intervalMs);
  }

  private clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
