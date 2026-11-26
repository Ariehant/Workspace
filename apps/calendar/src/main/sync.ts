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
import {
  isWorkspaceAccount,
  type Account,
  type CalDavCalendar,
  type Calendar,
  type GoogleCalendar,
  type IcsCalendar,
  type WorkspaceAccount,
  type WorkspaceCalendar,
} from '../shared/types';
import type { Cache } from './cache';
import type { Log } from './log';
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
  engineFor: (account: WorkspaceAccount) => WorkspaceEngine | null;
  /** Another kind of account's source (Google, ICS), or null if its sign-in can't be read. */
  sourceFor?: (account: SourceAccount) => SourceSync | null;
  now?: () => number;
  sweepEveryMs?: number;
  /** Something the window shows changed (events, statuses). */
  onChange?: () => void;
  /** No tokens or event contents: counts, codes and messages from the server. */
  log?: Log;
}

/** How a failed sync of a calendar is shown. */
export type SyncProblem =
  | { kind: 'offline' }
  | { kind: 'account'; message: string }
  | { kind: 'calendar'; status: Calendar['status']; message: string }
  | { kind: 'other'; message: string };

/** Accounts whose calendars sync through a `SourceSync` (not Workspace's engine). */
export type SourceAccount = Exclude<Account, WorkspaceAccount>;
export type SourceCalendar = GoogleCalendar | IcsCalendar | CalDavCalendar;

/** A kind of source's calendars, synced (see google/sync.ts, ics/sync.ts). */
export interface SourceSync {
  sync(calendar: SourceCalendar, full: boolean): Promise<void>;
  problem(error: unknown, calendar: SourceCalendar): SyncProblem;
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
      if (!isWorkspaceAccount(account)) {
        const result = await this.syncSourceAccount(account, full);
        reached ||= result.reached;
        offline ||= result.offline;
        error = result.error ?? error;
        continue;
      }
      const engine = this.options.engineFor(account);
      if (!engine) {
        this.setAccountError(
          account,
          "The token for this account can't be read on this computer. Remove the account and connect it again.",
        );
        continue;
      }
      const calendars = this.cache
        .calendars()
        .filter((c): c is WorkspaceCalendar => c.accountId === account.id && !c.kind);
      for (const calendar of calendars) {
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
          if (e instanceof WorkspaceApiError)
            this.options.log?.('warn', `sync: calendar ${calendar.id}: ${e.code}`);
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
    if (offline && !reached) this.options.log?.('warn', 'sync: no server could be reached');
    if (error) this.options.log?.('error', `sync: ${error}`);
    this.changed();
  }

  /** Another kind of account's calendars (each source reads its own changes). */
  private async syncSourceAccount(account: SourceAccount, full: boolean) {
    const result = { reached: false, offline: false, error: null as string | null };
    const source = this.options.sourceFor?.(account);
    if (!source) {
      this.setAccountError(
        account,
        "This account's sign-in can't be read on this computer. Remove it and sign in again.",
      );
      return result;
    }
    const calendars = this.cache
      .calendars()
      .filter((c): c is SourceCalendar => c.accountId === account.id && c.kind === account.kind);
    for (const calendar of calendars) {
      try {
        await source.sync(calendar, full);
        result.reached = true;
        this.setAccountError(account, null);
        this.setCalendarStatus(calendar.id, 'ok', null);
      } catch (e) {
        const problem = source.problem(e, calendar);
        this.options.log?.(
          'warn',
          `sync: ${account.kind} calendar ${calendar.id}: ${problem.kind}`,
        );
        if (problem.kind === 'offline') {
          result.offline = true;
          break;
        }
        result.reached = true;
        if (problem.kind === 'account') {
          this.setAccountError(account, problem.message);
          break;
        }
        if (problem.kind === 'calendar')
          this.setCalendarStatus(calendar.id, problem.status, problem.message);
        else result.error = problem.message;
      }
    }
    this.changed();
    return result;
  }

  /** Sync one calendar: the whole window when it's due a sweep, else its changes. */
  async syncCalendar(engine: WorkspaceEngine, calendar: WorkspaceCalendar, full = false) {
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
        this.cache.replaceEvents(
          calendar.id,
          events,
          new Date(serverTime ?? startedAt).toISOString(),
        );
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
