/**
 * The job queue (Phase 6): work done outside a request, such as webhook deliveries,
 * scheduled automations and email digests, kept in Postgres rather than a separate
 * queue service.
 *
 * - A job can be enqueued in the transaction that caused it, so it exists exactly when
 *   that change does.
 * - Workers claim due jobs with `FOR UPDATE SKIP LOCKED`: two never get the same one.
 * - A claimed job is locked for a while. If its worker dies, it runs again once the lock
 *   expires (so handlers must be safe to run twice).
 * - A job that fails is retried at a later time chosen by the worker, until its attempts
 *   run out.
 */
import type pg from 'pg';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface NewJob {
  workspaceId: string | null;
  kind: string;
  payload?: unknown;
  /** When to run (ms since epoch); now by default. */
  runAt?: number;
  maxAttempts?: number;
  /** At most one open job per key: a second one with the same key isn't added. */
  key?: string | null;
}

export interface Job {
  id: string;
  workspaceId: string | null;
  kind: string;
  payload: unknown;
  key: string | null;
  runAt: number;
  /** Including the current one, for a claimed job. */
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  result: unknown;
  createdAt: number;
  doneAt: number | null;
  failedAt: number | null;
}

interface JobRow {
  id: string;
  workspace_id: string | null;
  kind: string;
  payload: unknown;
  key: string | null;
  run_at: Date;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  result: unknown;
  created_at: Date;
  done_at: Date | null;
  failed_at: Date | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  payload: r.payload,
  key: r.key,
  runAt: r.run_at.getTime(),
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  lastError: r.last_error,
  result: r.result,
  createdAt: r.created_at.getTime(),
  doneAt: r.done_at?.getTime() ?? null,
  failedAt: r.failed_at?.getTime() ?? null,
});

/** Errors kept with a job are cut to this length. */
const MAX_ERROR = 2_000;

export class Jobs {
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Add jobs; pass a transaction's client to add them with what caused them. Returns
   * the new jobs' ids (a job whose key is taken is skipped).
   */
  async enqueue(jobs: readonly NewJob[], db: Queryable = this.pool): Promise<string[]> {
    const ids: string[] = [];
    for (const job of jobs) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO jobs (workspace_id, kind, payload, run_at, max_attempts, key)
         VALUES ($1, $2, $3, coalesce($4, now()), $5, $6)
         ON CONFLICT (key) WHERE key IS NOT NULL AND done_at IS NULL AND failed_at IS NULL
         DO NOTHING
         RETURNING id`,
        [
          job.workspaceId,
          job.kind,
          JSON.stringify(job.payload ?? {}),
          job.runAt === undefined ? null : new Date(job.runAt),
          job.maxAttempts ?? 6,
          job.key ?? null,
        ],
      );
      if (rows[0]) ids.push(rows[0].id);
    }
    return ids;
  }

  /**
   * Take up to `limit` due jobs of these kinds, locked for `lockMs`. Their attempts
   * count goes up now, so a job whose worker died has used that attempt.
   */
  async claim(kinds: readonly string[], limit: number, lockMs: number): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `UPDATE jobs SET attempts = attempts + 1,
         locked_until = now() + $3 * interval '1 millisecond'
       WHERE id IN (
         SELECT id FROM jobs
         WHERE done_at IS NULL AND failed_at IS NULL AND kind = ANY($1)
           AND run_at <= now() AND attempts < max_attempts
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY run_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED)
       RETURNING *`,
      [kinds, limit, lockMs],
    );
    return rows.map(toJob).sort((a, b) => a.runAt - b.runAt);
  }

  /** A claimed job finished; `result` is kept for a while (e.g. for run logs). */
  async complete(id: string, result: unknown = null): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET done_at = now(), locked_until = NULL, result = $2 WHERE id = $1`,
      [id, JSON.stringify(result)],
    );
  }

  /**
   * A claimed job failed: try again at `retryAt`, or (null, or no attempts left) give
   * up. Returns whether it will run again.
   */
  async fail(id: string, error: string, retryAt: number | null): Promise<boolean> {
    const { rows } = await this.pool.query<{ retry: boolean }>(
      `UPDATE jobs SET locked_until = NULL, last_error = $2,
         run_at = CASE WHEN $3::timestamptz IS NOT NULL AND attempts < max_attempts
                  THEN $3::timestamptz ELSE run_at END,
         failed_at = CASE WHEN $3::timestamptz IS NULL OR attempts >= max_attempts
                     THEN now() ELSE NULL END
       WHERE id = $1
       RETURNING failed_at IS NULL AS retry`,
      [id, error.slice(0, MAX_ERROR), retryAt === null ? null : new Date(retryAt)],
    );
    return rows[0]?.retry ?? false;
  }

  async get(id: string): Promise<Job | null> {
    const { rows } = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0] ? toJob(rows[0]) : null;
  }

  /** A workspace's latest jobs of a kind (newest first), e.g. an automation's runs. */
  async recent(workspaceId: string, kind: string, limit = 50): Promise<Job[]> {
    const { rows } = await this.pool.query<JobRow>(
      `SELECT * FROM jobs WHERE workspace_id = $1 AND kind = $2
       ORDER BY created_at DESC LIMIT $3`,
      [workspaceId, kind, limit],
    );
    return rows.map(toJob);
  }

  /**
   * Housekeeping: jobs whose last attempt's worker died are marked failed, and jobs
   * finished before `before` are deleted. Returns how many were deleted.
   */
  async cleanup(before: number): Promise<number> {
    await this.pool.query(
      `UPDATE jobs SET failed_at = now(), locked_until = NULL,
         last_error = coalesce(last_error, 'Stopped while running')
       WHERE done_at IS NULL AND failed_at IS NULL AND attempts >= max_attempts
         AND locked_until < now()`,
    );
    const { rowCount } = await this.pool.query(
      `DELETE FROM jobs WHERE coalesce(done_at, failed_at) < $1`,
      [new Date(before)],
    );
    return rowCount ?? 0;
  }
}
