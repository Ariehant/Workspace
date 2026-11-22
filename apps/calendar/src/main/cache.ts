/**
 * The local cache (SQLite, Node's built-in `node:sqlite`): accounts, calendars, events and
 * settings. Everything the window shows comes from here, so the app opens and works offline.
 *
 * Tokens are stored sealed (see `secrets.ts`), never in plain text unless the system has no
 * keyring, and never logged.
 */
import { DatabaseSync } from 'node:sqlite';
import type { Account, CalEvent, Calendar } from '../shared/types';

/** Each entry upgrades the schema by one version (`PRAGMA user_version`). */
export const MIGRATIONS: string[] = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     json TEXT NOT NULL,
     token TEXT NOT NULL,
     position INTEGER NOT NULL
   );
   CREATE TABLE calendars (
     id TEXT PRIMARY KEY,
     account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     json TEXT NOT NULL,
     position INTEGER NOT NULL,
     synced_at INTEGER,
     swept_at INTEGER
   );
   CREATE TABLE events (
     id TEXT PRIMARY KEY,
     calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL,
     first_day TEXT NOT NULL,
     last_day TEXT NOT NULL,
     title TEXT NOT NULL,
     json TEXT NOT NULL
   );
   CREATE INDEX events_by_day ON events(first_day, last_day);
   CREATE INDEX events_by_source ON events(calendar_id, source_id);`,
];

export interface SyncState {
  /** The server time the last sync read changes up to (ms), or null before the first. */
  syncedAt: number | null;
  /** When the last full window query (the deletion sweep) ran (ms, this machine's clock). */
  sweptAt: number | null;
}

/** The last day an event touches (a timed event ending at 00:00 ends the day before). */
export function lastDayOf(event: Pick<CalEvent, 'allDay' | 'start' | 'end'>): string {
  if (event.allDay) return event.end.slice(0, 10);
  const endDay = event.end.slice(0, 10);
  if (event.end.slice(11, 16) === '00:00' && endDay > event.start.slice(0, 10)) {
    const d = new Date(`${endDay}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return endDay;
}

export class Cache {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;`);
    this.migrate();
  }

  private migrate() {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private depth = 0;

  /** Run `fn` in a transaction (one inside another joins the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN');
    this.depth = 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  close() {
    this.db.close();
  }

  // --- Settings ------------------------------------------------------------------------

  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  // --- Accounts ------------------------------------------------------------------------

  accounts(): Account[] {
    return (
      this.db.prepare('SELECT json FROM accounts ORDER BY position').all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as Account);
  }

  account(id: string): Account | null {
    const row = this.db.prepare('SELECT json FROM accounts WHERE id = ?').get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Account) : null;
  }

  /** The account's sealed token (see `secrets.ts`). */
  sealedToken(id: string): string | null {
    const row = this.db.prepare('SELECT token FROM accounts WHERE id = ?').get(id) as
      { token: string } | undefined;
    return row?.token ?? null;
  }

  addAccount(account: Account, sealedToken: string) {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number };
    this.db
      .prepare('INSERT INTO accounts (id, json, token, position) VALUES (?, ?, ?, ?)')
      .run(account.id, JSON.stringify(account), sealedToken, n);
  }

  updateAccount(account: Account) {
    this.db
      .prepare('UPDATE accounts SET json = ? WHERE id = ?')
      .run(JSON.stringify(account), account.id);
  }

  removeAccount(id: string) {
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  }

  // --- Calendars -----------------------------------------------------------------------

  calendars(): Calendar[] {
    return (
      this.db.prepare('SELECT json FROM calendars ORDER BY position').all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json) as Calendar);
  }

  calendar(id: string): Calendar | null {
    const row = this.db.prepare('SELECT json FROM calendars WHERE id = ?').get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Calendar) : null;
  }

  addCalendar(calendar: Calendar) {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM calendars').get() as { n: number };
    this.db
      .prepare('INSERT INTO calendars (id, account_id, json, position) VALUES (?, ?, ?, ?)')
      .run(calendar.id, calendar.accountId, JSON.stringify(calendar), n);
  }

  updateCalendar(calendar: Calendar) {
    this.db
      .prepare('UPDATE calendars SET json = ? WHERE id = ?')
      .run(JSON.stringify(calendar), calendar.id);
  }

  removeCalendar(id: string) {
    this.db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
  }

  syncState(calendarId: string): SyncState {
    const row = this.db
      .prepare('SELECT synced_at, swept_at FROM calendars WHERE id = ?')
      .get(calendarId) as { synced_at: number | null; swept_at: number | null } | undefined;
    return { syncedAt: row?.synced_at ?? null, sweptAt: row?.swept_at ?? null };
  }

  setSyncState(calendarId: string, state: Partial<SyncState>) {
    if (state.syncedAt !== undefined)
      this.db
        .prepare('UPDATE calendars SET synced_at = ? WHERE id = ?')
        .run(state.syncedAt, calendarId);
    if (state.sweptAt !== undefined)
      this.db
        .prepare('UPDATE calendars SET swept_at = ? WHERE id = ?')
        .run(state.sweptAt, calendarId);
  }

  // --- Events --------------------------------------------------------------------------

  private putEvent(event: CalEvent) {
    this.db
      .prepare(
        `INSERT INTO events (id, calendar_id, source_id, first_day, last_day, title, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET first_day = excluded.first_day, last_day = excluded.last_day,
           title = excluded.title, json = excluded.json`,
      )
      .run(
        event.id,
        event.calendarId,
        event.sourceId,
        event.start.slice(0, 10),
        lastDayOf(event),
        event.title,
        JSON.stringify(event),
      );
  }

  /** Events touching the days `from`–`to` (inclusive), in every calendar. */
  eventsBetween(from: string, to: string): CalEvent[] {
    return (
      this.db
        .prepare(
          'SELECT json FROM events WHERE last_day >= ? AND first_day <= ? ORDER BY first_day, json',
        )
        .all(from, to) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as CalEvent);
  }

  event(id: string): CalEvent | null {
    const row = this.db.prepare('SELECT json FROM events WHERE id = ?').get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CalEvent) : null;
  }

  eventCount(calendarId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?').get(calendarId) as {
        n: number;
      }
    ).n;
  }

  /** A calendar's events, all replaced (the first sync and the deletion sweep). */
  replaceEvents(calendarId: string, events: CalEvent[]) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM events WHERE calendar_id = ?').run(calendarId);
      for (const event of events) this.putEvent(event);
    });
  }

  /** Changed events, and rows that left the calendar (by source id). */
  applyChanges(calendarId: string, upserts: CalEvent[], removedSourceIds: string[]) {
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM events WHERE calendar_id = ? AND source_id = ?');
      for (const sourceId of removedSourceIds) remove.run(calendarId, sourceId);
      for (const event of upserts) this.putEvent(event);
    });
  }
}
