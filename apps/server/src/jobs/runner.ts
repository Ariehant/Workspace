/**
 * Runs the job queue's jobs (`store.jobs`): each kind has a handler, polled for due jobs
 * a few at a time. A handler that throws is retried later (1 min, 5 min, 30 min, 2 h,
 * 8 h), unless it throws `PermanentJobError`; then, or when its attempts run out, the
 * job is marked failed. Finished jobs are kept a week (for run logs), then deleted.
 *
 * Handlers must be safe to run twice: a server that stops mid-job runs it again later.
 */
import type { Job, PgStore } from '@workspace/storage-remote';

export type JobHandler = (job: Job) => Promise<unknown>;

/** A failure that trying again won't fix (an invalid URL, a deleted database). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

export interface JobRunnerOptions {
  /** How often to look for due jobs. */
  pollMs?: number;
  /** Jobs run at once (per server). */
  concurrency?: number;
  /** How long a job may run before another server may take it. */
  lockMs?: number;
  /** Wait before each retry (the last one repeats). */
  backoffMs?: readonly number[];
  /** How long finished jobs are kept. */
  keepMs?: number;
  now?: () => number;
  onError?: (error: unknown, job: Job | null) => void;
}

const MINUTE = 60_000;
export const DEFAULT_BACKOFF = [MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE, 480 * MINUTE];
const CLEANUP_EVERY_MS = 3_600_000;

export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<number> | null = null;
  private lastCleanup = 0;
  private closed = false;
  private readonly options: Required<Omit<JobRunnerOptions, 'onError'>> &
    Pick<JobRunnerOptions, 'onError'>;

  constructor(
    private readonly store: PgStore,
    options: JobRunnerOptions = {},
  ) {
    this.options = {
      pollMs: 1000,
      concurrency: 4,
      lockMs: 5 * MINUTE,
      backoffMs: DEFAULT_BACKOFF,
      keepMs: 7 * 24 * 3_600_000,
      now: Date.now,
      ...options,
    };
  }

  /** Run jobs of `kind` with `handler` (its result is kept with the job). */
  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => void this.poke(), this.options.pollMs);
    this.timer.unref?.();
    void this.poke();
  }

  /** Look for due jobs now (e.g. right after adding one); resolves with how many ran. */
  poke(): Promise<number> {
    if (this.closed) return Promise.resolve(0);
    this.polling ??= this.runDue().finally(() => (this.polling = null));
    return this.polling;
  }

  /** Stop polling and wait for the jobs running. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.polling?.catch(() => {});
  }

  private async runDue(): Promise<number> {
    let ran = 0;
    try {
      const now = this.options.now();
      if (now - this.lastCleanup > CLEANUP_EVERY_MS) {
        this.lastCleanup = now;
        await this.store.jobs.cleanup(now - this.options.keepMs);
      }
      if (this.handlers.size === 0) return 0;
      // Until nothing is due (a burst is worked through without waiting for the next tick).
      for (;;) {
        const jobs = await this.store.jobs.claim(
          [...this.handlers.keys()],
          this.options.concurrency,
          this.options.lockMs,
        );
        if (jobs.length === 0 || this.closed) break;
        await Promise.all(jobs.map((job) => this.run(job)));
        ran += jobs.length;
      }
    } catch (error) {
      this.options.onError?.(error, null);
    }
    return ran;
  }

  private async run(job: Job): Promise<void> {
    const handler = this.handlers.get(job.kind)!;
    try {
      const result = await handler(job);
      await this.store.jobs.complete(job.id, result ?? null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const permanent = error instanceof PermanentJobError;
      const { backoffMs } = this.options;
      const wait = backoffMs[Math.min(job.attempts - 1, backoffMs.length - 1)] ?? MINUTE;
      await this.store.jobs
        .fail(job.id, message, permanent ? null : this.options.now() + wait)
        .catch((e: unknown) => this.options.onError?.(e, job));
      if (!permanent) this.options.onError?.(error, job);
    }
  }
}
