/**
 * The local cache (SQLite, Node's built-in `node:sqlite`): accounts, calendars, events and
 * settings. Everything the window shows comes from here, so the app opens and works offline.
 *
 * Tokens are stored sealed (see `secrets.ts`), never in plain text unless the system has no
 * keyring, and never logged.
 */
import { DatabaseSync } from 'node:sqlite';
import type { EventTime } from '../shared/dates';
import type { Account, CalEvent, Calendar, EditScope } from '../shared/types';

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
  // Edits made here, waiting to be sent (see outbox.ts).
  `CREATE TABLE outbox (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL,
     calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     not_before INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     base_edited TEXT,
     error TEXT
   );
   CREATE INDEX outbox_by_event ON outbox(event_id);`,
  // Reminders already shown (so a restart doesn't show them again).
  `CREATE TABLE notified (key TEXT PRIMARY KEY, at INTEGER NOT NULL);`,
  // v1.1: sources whose events are worked out here (Google): their items as read (series,
  // their changed or cancelled occurrences, single events), a sync cursor per calendar, and
  // the series each event belongs to.
  `CREATE TABLE items (
     id TEXT PRIMARY KEY,
     calendar_id TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
     source_id TEXT NOT NULL,
     series_id TEXT,
     json TEXT NOT NULL
   );
   CREATE INDEX items_by_calendar ON items(calendar_id, series_id);
   ALTER TABLE calendars ADD COLUMN cursor TEXT;
   ALTER TABLE events ADD COLUMN series_id TEXT;
   CREATE INDEX events_by_series ON events(calendar_id, series_id);`,
];

/** An item as a source sent it (Google's event resource), kept to work out events from. */
export interface SourceItem<T = unknown> {
  sourceId: string;
  /** The series it's an occurrence of (Google's `recurringEventId`), if any. */
  seriesId: string | null;
  data: T;
}

export type OpKind = 'create' | 'update' | 'trash';

/** What an edit sends: a title and/or a time; a trash keeps the event, for Undo. */
export interface OpPayload {
  title?: string;
  time?: EventTime;
  snapshot?: CalEvent;
  /** A recurring event's occurrences the edit is for (absent: this one). */
  scope?: EditScope;
  /** The other occurrences a series delete took away here, for Undo. */
  others?: CalEvent[];
}

export interface OutboxOp {
  id: number;
  eventId: string;
  calendarId: string;
  kind: OpKind;
  payload: OpPayload;
  /** Not sent before this (ms): a trash waits for Undo, a failed send backs off. */
  notBefore: number;
  attempts: number;
  /** The event's `lastEdited` when the edit was made (to notice changes made elsewhere). */
  baseEdited: string | null;
  error: string | null;
}

interface OpRow {
  id: number;
  event_id: string;
  calendar_id: string;
  kind: OpKind;
  payload: string;
  not_before: number;
  attempts: number;
  base_edited: string | null;
  error: string | null;
}

const opFrom = (r: OpRow): OutboxOp => ({
  id: r.id,
  eventId: r.event_id,
  calendarId: r.calendar_id,
  kind: r.kind,
  payload: JSON.parse(r.payload) as OpPayload,
  notBefore: r.not_before,
  attempts: r.attempts,
  baseEdited: r.base_edited,
  error: r.error,
});

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

  setSealedToken(id: string, sealedToken: string) {
    this.db.prepare('UPDATE accounts SET token = ? WHERE id = ?').run(sealedToken, id);
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

  /** The source's sync cursor for the calendar (Google's `nextSyncToken`). */
  cursor(calendarId: string): string | null {
    const row = this.db.prepare('SELECT cursor FROM calendars WHERE id = ?').get(calendarId) as
      { cursor: string | null } | undefined;
    return row?.cursor ?? null;
  }

  setCursor(calendarId: string, cursor: string | null) {
    this.db.prepare('UPDATE calendars SET cursor = ? WHERE id = ?').run(cursor, calendarId);
  }

  // --- Source items ----------------------------------------------------------------------

  items<T>(calendarId: string): SourceItem<T>[] {
    return (
      this.db
        .prepare('SELECT source_id, series_id, json FROM items WHERE calendar_id = ?')
        .all(calendarId) as { source_id: string; series_id: string | null; json: string }[]
    ).map((r) => ({ sourceId: r.source_id, seriesId: r.series_id, data: JSON.parse(r.json) as T }));
  }

  putItem(calendarId: string, item: SourceItem) {
    this.db
      .prepare(
        `INSERT INTO items (id, calendar_id, source_id, series_id, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET series_id = excluded.series_id, json = excluded.json`,
      )
      .run(
        `${calendarId}:${item.sourceId}`,
        calendarId,
        item.sourceId,
        item.seriesId,
        JSON.stringify(item.data),
      );
  }

  /** Removes an item, and the occurrences kept for it if it's a series. */
  removeItem(calendarId: string, sourceId: string) {
    this.db
      .prepare('DELETE FROM items WHERE calendar_id = ? AND (source_id = ? OR series_id = ?)')
      .run(calendarId, sourceId, sourceId);
  }

  clearItems(calendarId: string) {
    this.db.prepare('DELETE FROM items WHERE calendar_id = ?').run(calendarId);
  }

  // --- Events --------------------------------------------------------------------------

  putEvent(event: CalEvent) {
    this.db
      .prepare(
        `INSERT INTO events (id, calendar_id, source_id, first_day, last_day, title, json,
           series_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source_id = excluded.source_id,
           first_day = excluded.first_day, last_day = excluded.last_day,
           title = excluded.title, json = excluded.json, series_id = excluded.series_id`,
      )
      .run(
        event.id,
        event.calendarId,
        event.sourceId,
        event.start.slice(0, 10),
        lastDayOf(event),
        event.title,
        JSON.stringify(event),
        event.series?.id ?? null,
      );
  }

  deleteEvent(id: string) {
    this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
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

  /** Events whose title has `query` (case-insensitive), soonest first, at most `limit`. */
  search(query: string, limit = 50): CalEvent[] {
    const q = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    if (!q) return [];
    return (
      this.db
        .prepare(
          `SELECT json FROM events WHERE title LIKE ? ESCAPE '\\'
           ORDER BY first_day, title LIMIT ?`,
        )
        .all(`%${q}%`, limit) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as CalEvent);
  }

  event(id: string): CalEvent | null {
    const row = this.db.prepare('SELECT json FROM events WHERE id = ?').get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as CalEvent) : null;
  }

  /** The occurrences of a series shown here. */
  seriesEvents(calendarId: string, seriesId: string): CalEvent[] {
    return (
      this.db
        .prepare('SELECT json FROM events WHERE calendar_id = ? AND series_id = ?')
        .all(calendarId, seriesId) as { json: string }[]
    ).map((r) => JSON.parse(r.json) as CalEvent);
  }

  eventCount(calendarId: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE calendar_id = ?').get(calendarId) as {
        n: number;
      }
    ).n;
  }

  /**
   * An event read from its source, unless what's here should win: an event with edits waiting
   * to be sent keeps them (noting the source's version if it changed meanwhile), and an event
   * already newer here (an edit just sent) isn't replaced by an older read.
   */
  private mergeIncoming(event: CalEvent, pending: Map<string, OutboxOp[]>) {
    const ops = pending.get(event.id);
    if (ops) {
      const local = this.event(event.id);
      const update = ops.find((o) => o.kind === 'update');
      if (local && update && update.baseEdited !== null && event.lastEdited > update.baseEdited) {
        this.putEvent({
          ...local,
          conflict: {
            title: event.title,
            allDay: event.allDay,
            start: event.start,
            end: event.end,
          },
        });
      }
      return;
    }
    const cached = this.event(event.id);
    if (cached && cached.lastEdited > event.lastEdited) return;
    this.putEvent(cached?.conflict ? { ...event, conflict: cached.conflict } : event);
  }

  private pendingByEvent(calendarId: string): Map<string, OutboxOp[]> {
    const map = new Map<string, OutboxOp[]>();
    for (const op of this.opsOf(calendarId)) {
      map.set(op.eventId, [...(map.get(op.eventId) ?? []), op]);
    }
    return map;
  }

  /**
   * A calendar's events as its source has them now (the first sync and the deletion sweep).
   * Events not in `events` are dropped, except ones with edits waiting and ones edited here
   * after the read started (`readAt`, UTC ISO).
   */
  replaceEvents(calendarId: string, events: CalEvent[], readAt: string | null = null) {
    this.transaction(() => {
      const pending = this.pendingByEvent(calendarId);
      const incoming = new Set(events.map((e) => e.id));
      const cached = this.db
        .prepare('SELECT id, json FROM events WHERE calendar_id = ?')
        .all(calendarId) as { id: string; json: string }[];
      for (const row of cached) {
        if (incoming.has(row.id) || pending.has(row.id)) continue;
        const event = JSON.parse(row.json) as CalEvent;
        if (readAt && event.lastEdited >= readAt) continue;
        this.deleteEvent(row.id);
      }
      for (const event of events) this.mergeIncoming(event, pending);
    });
  }

  /**
   * A calendar's events as worked out from its items (Google): only what changed is written.
   * Events with edits waiting are kept as they are here; a newer copy here isn't replaced, nor
   * dropped if it was edited here after the read started (`readAt`, UTC ISO).
   */
  setDerivedEvents(calendarId: string, events: CalEvent[], readAt: string | null = null) {
    this.transaction(() => {
      const pending = this.pendingByEvent(calendarId);
      const cached = new Map(
        (
          this.db.prepare('SELECT id, json FROM events WHERE calendar_id = ?').all(calendarId) as {
            id: string;
            json: string;
          }[]
        ).map((r) => [r.id, r.json]),
      );
      const incoming = new Set(events.map((e) => e.id));
      for (const [id, json] of cached) {
        if (incoming.has(id) || pending.has(id)) continue;
        if (readAt && (JSON.parse(json) as CalEvent).lastEdited >= readAt) continue;
        this.deleteEvent(id);
      }
      for (const event of events) {
        const json = cached.get(event.id);
        if (json === JSON.stringify(event)) continue;
        if (json === undefined && !pending.has(event.id)) this.putEvent(event);
        else this.mergeIncoming(event, pending);
      }
    });
  }

  /**
   * Work out the clock times of events at real instants again (after the time zone changed).
   */
  relocalize(toWall: (instant: string) => string) {
    this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT json FROM events WHERE json LIKE '%"instant":%'`)
        .all() as { json: string }[];
      for (const row of rows) {
        const event = JSON.parse(row.json) as CalEvent;
        if (!event.instant) continue;
        const start = toWall(event.instant.start);
        const end = toWall(event.instant.end);
        if (start !== event.start || end !== event.end) this.putEvent({ ...event, start, end });
      }
    });
  }

  /** Changed events, and rows that left the calendar (by source id). */
  applyChanges(calendarId: string, upserts: CalEvent[], removedSourceIds: string[]) {
    this.transaction(() => {
      const pending = this.pendingByEvent(calendarId);
      for (const sourceId of removedSourceIds) {
        const id = `${calendarId}:${sourceId}`;
        if (!pending.has(id)) this.deleteEvent(id);
      }
      for (const event of upserts) this.mergeIncoming(event, pending);
    });
  }

  // --- Reminders shown -----------------------------------------------------------------

  wasNotified(key: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM notified WHERE key = ?').get(key);
  }

  markNotified(key: string, at: number) {
    this.db
      .prepare('INSERT INTO notified (key, at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING')
      .run(key, at);
  }

  /** Forget reminders shown before `before` (ms). */
  pruneNotified(before: number) {
    this.db.prepare('DELETE FROM notified WHERE at < ?').run(before);
  }

  // --- Outbox --------------------------------------------------------------------------

  addOp(op: Omit<OutboxOp, 'id' | 'attempts' | 'error'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO outbox (event_id, calendar_id, kind, payload, not_before, base_edited)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        op.eventId,
        op.calendarId,
        op.kind,
        JSON.stringify(op.payload),
        op.notBefore,
        op.baseEdited,
      );
    return Number(result.lastInsertRowid);
  }

  updateOp(op: OutboxOp) {
    this.db
      .prepare(
        `UPDATE outbox SET event_id = ?, payload = ?, not_before = ?, attempts = ?, error = ?,
           base_edited = ?
         WHERE id = ?`,
      )
      .run(
        op.eventId,
        JSON.stringify(op.payload),
        op.notBefore,
        op.attempts,
        op.error,
        op.baseEdited,
        op.id,
      );
  }

  removeOp(id: number) {
    this.db.prepare('DELETE FROM outbox WHERE id = ?').run(id);
  }

  /** Every waiting edit, oldest first. */
  ops(): OutboxOp[] {
    return (this.db.prepare('SELECT * FROM outbox ORDER BY id').all() as unknown as OpRow[]).map(
      opFrom,
    );
  }

  opsOf(calendarId: string): OutboxOp[] {
    return (
      this.db
        .prepare('SELECT * FROM outbox WHERE calendar_id = ? ORDER BY id')
        .all(calendarId) as unknown as OpRow[]
    ).map(opFrom);
  }

  opsFor(eventId: string): OutboxOp[] {
    return (
      this.db
        .prepare('SELECT * FROM outbox WHERE event_id = ? ORDER BY id')
        .all(eventId) as unknown as OpRow[]
    ).map(opFrom);
  }
}
