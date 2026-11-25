/**
 * Keeps a Google account's calendars in the cache (HANDOFF.md 4):
 * - the first sync reads every event ending after the window's start, and keeps Google's sync
 *   token; later syncs read only the changes since it (deleted events come back `cancelled`);
 * - a sync token Google no longer accepts (`410`) means a sync from scratch, as does "Sync now";
 * - the items are kept as Google sent them (series once, plus their changed occurrences), and
 *   the events shown are worked out from them (shared/google.ts) whenever they change, the
 *   window moves on a day, or the time zone changes.
 */
import { addDays, syncWindow } from '../../shared/dates';
import { deriveEvents, type GoogleEvent } from '../../shared/google';
import type { GoogleCalendar } from '../../shared/types';
import { instantAt, localZone } from '../../shared/zones';
import type { Cache } from '../cache';
import type { GoogleSync, SyncProblem } from '../sync';
import { GoogleApiError, type GoogleEngine } from './client';

export class GoogleCalendarSync implements GoogleSync {
  /** What each calendar's events were last worked out for (the window's start and zone). */
  private derivedFor = new Map<string, string>();
  private readonly now: () => number;
  private readonly zone: () => string;

  constructor(
    private readonly options: {
      cache: Cache;
      engine: GoogleEngine;
      now?: () => number;
      zone?: () => string;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.zone = options.zone ?? localZone;
  }

  async sync(calendar: GoogleCalendar, full: boolean): Promise<void> {
    const { cache, engine } = this.options;
    const zone = this.zone();
    const window = syncWindow(new Date(this.now()));
    const cursor = full ? null : cache.cursor(calendar.id);
    let read: { items: GoogleEvent[]; nextSyncToken: string | null } | null = null;
    if (cursor) {
      try {
        read = await engine.events(calendar.googleId, { syncToken: cursor });
      } catch (e) {
        if (!(e instanceof GoogleApiError && e.code === 'gone')) throw e;
      }
    }
    const fromScratch = !read;
    // A day early: the window's first day starts at midnight here, maybe earlier elsewhere.
    read ??= await engine.events(calendar.googleId, {
      timeMin: instantAt(addDays(window.from, -1), zone).toISOString(),
    });
    // Removed while its events were being read: nothing to keep.
    if (!cache.calendar(calendar.id)) return;

    const key = `${window.from}|${window.to}|${zone}`;
    cache.transaction(() => {
      if (fromScratch) cache.clearItems(calendar.id);
      for (const item of read.items) {
        // A deleted event or series goes; a cancelled occurrence stays, to hide its occurrence.
        if (item.status === 'cancelled' && !item.recurringEventId)
          cache.removeItem(calendar.id, item.id);
        else
          cache.putItem(calendar.id, {
            sourceId: item.id,
            seriesId: item.recurringEventId ?? null,
            data: item,
          });
      }
      cache.setCursor(calendar.id, read.nextSyncToken);
      if (fromScratch || read.items.length || this.derivedFor.get(calendar.id) !== key) {
        const items = cache.items<GoogleEvent>(calendar.id).map((i) => i.data);
        cache.setDerivedEvents(calendar.id, deriveEvents(calendar, items, window, zone));
        this.derivedFor.set(calendar.id, key);
      }
    });
  }

  problem(error: unknown, calendar: GoogleCalendar): SyncProblem {
    if (!(error instanceof GoogleApiError))
      return { kind: 'other', message: error instanceof Error ? error.message : String(error) };
    switch (error.code) {
      case 'network':
        return { kind: 'offline' };
      case 'unauthorized':
        return { kind: 'account', message: error.message };
      case 'not_found':
      case 'forbidden':
        return {
          kind: 'calendar',
          status: 'no-access',
          message: `This Google account can no longer see “${calendar.name}”.`,
        };
      default:
        return { kind: 'other', message: error.message };
    }
  }
}
