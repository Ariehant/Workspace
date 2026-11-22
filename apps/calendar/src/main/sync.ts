/**
 * Keeps the cache up to date with each calendar's source (HANDOFF.md 3.5):
 * - a calendar's first sync, and the deletion sweep every 15 minutes, read the whole window and
 *   replace the calendar's events (trashed rows simply stop coming back);
 * - in between, only the rows edited since the last sync are read.
 *
 * "Since" is the server's clock (its `Date` header) when the last read started, minus a minute,
 * so a machine whose clock is off doesn't miss changes.
 *
 * Failures are kept where the user can see them: on the calendar (lost access, a changed
 * schema), on the account (a token that stopped working), or as "offline".
 */
import { syncWindow } from '../shared/dates';
import type { Account, Calendar } from '../shared/types';
import type { Cache } from './cache';
import { WorkspaceApiError } from './workspace/client';
import { calendarProblem, type WorkspaceEngine } from './workspace/engine';

export const SWEEP_EVERY_MS = 15 * 60_000;

export interface SyncStatus {
  /** False after a request couldn't reach a server (true again after one that did). */
  online: boolean;
  syncing: boolean;
  /** The last unexpected failure (not about one calendar or account), for the status line. */
  error: string | null;
  /** When the last sync of everything finished (this machine's clock). */
  lastSync: number | null;
}

export interface SyncOptions {
  cache: Cache;
  /** The account's source, or null if its token can't be read. */
  engineFor: (account: Account) => WorkspaceEngine | null;
  now?: () => number;
  sweepEveryMs?: number;
  /** Something the window shows changed (events, statuses). */
  onChange?: () => void;
}

export class SyncService {
  status: SyncStatus = { online: true, syncing: false, error: null, lastSync: null };
  private readonly cache: Cache;
  private readonly now: () => number;
  private readonly sweepEveryMs: number;
  private running: Promise<void> | null = null;
  private again: { full: boolean } | null = null;

  constructor(private readonly options: SyncOptions) {
    this.cache = options.cache;
    this.now = options.now ?? Date.now;
    this.sweepEveryMs = options.sweepEveryMs ?? SWEEP_EVERY_MS;
  }

  private changed() {
    this.options.onChange?.();
  }

  /**
   * Sync every calendar. One run at a time: asking during a run queues one more run after it
   * (so a change made meanwhile isn't missed).
   */
  syncAll(options: { full?: boolean } = {}): Promise<void> {
    if (this.running) {
      this.again = { full: (this.again?.full ?? false) || !!options.full };
      return this.running;
    }
    this.running = (async () => {
      let next: { full: boolean } | null = { full: !!options.full };
      while (next) {
        this.again = null;
        await this.runOnce(next.full);
        next = this.again;
      }
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async runOnce(full: boolean) {
    this.status = { ...this.status, syncing: true };
    this.changed();
    let error: string | null = null;
    let reached = false;
    let offline = false;
    for (const account of this.cache.accounts()) {
      const engine = this.options.engineFor(account);
      if (!engine) {
        this.setAccountError(
          account,
          "The token for this account can't be read on this computer. Remove the account and connect it again.",
        );
        continue;
      }
      for (const calendar of this.cache.calendars().filter((c) => c.accountId === account.id)) {
        try {
          await this.syncCalendar(engine, calendar, full);
          reached = true;
          this.setAccountError(account, null);
        } catch (e) {
          if (e instanceof WorkspaceApiError && e.code === 'network') {
            offline = true;
            break; // The rest of this account's calendars would fail the same way.
          }
          if (e instanceof WorkspaceApiError && e.code === 'unauthorized') {
            reached = true;
            this.setAccountError(account, e.message);
            break;
          }
          const problem = calendarProblem(e, calendar);
          if (problem) {
            reached = true;
            this.setCalendarStatus(calendar.id, problem.status, problem.message);
          } else {
            error = e instanceof Error ? e.message : String(e);
          }
        }
      }
    }
    this.status = {
      online: reached || !offline,
      syncing: false,
      error,
      lastSync: this.now(),
    };
    this.changed();
  }

  /** Sync one calendar: the whole window when it's due a sweep, else its changes. */
  async syncCalendar(engine: WorkspaceEngine, calendar: Calendar, full = false) {
    const state = this.cache.syncState(calendar.id);
    const window = syncWindow(new Date(this.now()));
    const startedAt = this.now();
    const sweep =
      full ||
      state.syncedAt === null ||
      state.sweptAt === null ||
      startedAt - state.sweptAt >= this.sweepEveryMs;
    if (sweep) {
      const { events, serverTime } = await engine.fetchWindow(calendar, window);
      // Removed while its rows were being read: nothing to keep.
      if (!this.cache.calendar(calendar.id)) return;
      this.cache.transaction(() => {
        this.cache.replaceEvents(calendar.id, events);
        this.cache.setSyncState(calendar.id, {
          syncedAt: serverTime ?? startedAt,
          sweptAt: startedAt,
        });
      });
    } else {
      const { upserts, removed, serverTime } = await engine.fetchChanged(
        calendar,
        state.syncedAt!,
        window,
      );
      if (!this.cache.calendar(calendar.id)) return;
      this.cache.transaction(() => {
        this.cache.applyChanges(calendar.id, upserts, removed);
        this.cache.setSyncState(calendar.id, { syncedAt: serverTime ?? startedAt });
      });
    }
    this.setCalendarStatus(calendar.id, 'ok', null);
    this.changed();
  }

  private setCalendarStatus(id: string, status: Calendar['status'], message: string | null) {
    const current = this.cache.calendar(id);
    if (!current || (current.status === status && current.statusMessage === message)) return;
    this.cache.updateCalendar({ ...current, status, statusMessage: message });
    this.changed();
  }

  private setAccountError(account: Account, error: string | null) {
    const current = this.cache.account(account.id);
    if (!current || current.error === error) return;
    this.cache.updateAccount({ ...current, error });
    this.changed();
  }
}
