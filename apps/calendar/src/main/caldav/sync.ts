/**
 * Keeps CalDAV calendars in the cache (HANDOFF.md 5): the server's changes since the last sync
 * token (`sync-collection`; servers without one are compared by ETag), kept as the server's
 * objects, one per event with its exceptions, and worked out into events as Google's and ICS
 * feeds' are (the same iCalendar reader and series expansion).
 */
import { syncWindow } from '../../shared/dates';
import { deriveEvents, type GoogleEvent } from '../../shared/google';
import type { CalDavCalendar, CalEvent } from '../../shared/types';
import { localZone } from '../../shared/zones';
import type { Cache } from '../cache';
import { parseIcs, resourceIdOf } from '../ics/parse';
import type { SourceCalendar, SourceSync, SyncProblem } from '../sync';
import { CalDavError, type CalDavClient, type RemoteObject } from './dav';

/** What's kept of a server object. */
export type StoredObject = RemoteObject;

/** A calendar's events, worked out from its server objects. */
export function deriveCalDav(
  calendar: CalDavCalendar,
  objects: StoredObject[],
  window: { from: string; to: string },
  zone: string,
): CalEvent[] {
  const items: GoogleEvent[] = [];
  for (const object of objects) {
    try {
      items.push(...parseIcs(object.ics).items);
    } catch {
      // An object that isn't readable iCalendar: left out (the others still show).
    }
  }
  return deriveEvents(calendar, items, window, zone);
}

export class CalDavCalendarSync implements SourceSync {
  private derivedFor = new Map<string, string>();
  private readonly now: () => number;
  private readonly zone: () => string;

  constructor(
    private readonly options: {
      cache: Cache;
      client: CalDavClient;
      now?: () => number;
      zone?: () => string;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.zone = options.zone ?? localZone;
  }

  async sync(calendar: SourceCalendar, full: boolean): Promise<void> {
    const dav = calendar as CalDavCalendar;
    const { cache, client } = this.options;
    const stored = cache.cursor(dav.id);
    const token =
      full || !stored ? null : (JSON.parse(stored) as { syncToken: string | null }).syncToken;
    const known = cache.items<StoredObject>(dav.id).map((i) => i.data);
    const readAt = new Date(this.now()).toISOString();
    const changes = await client.changes(dav.url, token, known);
    if (!cache.calendar(dav.id)) return; // Removed while it was being read.

    const zone = this.zone();
    const window = syncWindow(new Date(this.now()));
    const key = `${window.from}|${window.to}|${zone}`;
    const changed = changes.changed.length > 0 || changes.deleted.length > 0;
    cache.transaction(() => {
      const byHref = new Map(
        cache.items<StoredObject>(dav.id).map((i) => [i.data.href, i.sourceId]),
      );
      for (const href of changes.deleted) {
        const sourceId = byHref.get(href) ?? [...byHref].find(([h]) => sameHref(h, href))?.[1];
        if (sourceId) cache.removeItem(dav.id, sourceId);
      }
      for (const object of changes.changed) {
        const sourceId = resourceIdOf(object.ics);
        if (!sourceId) continue;
        cache.putItem(dav.id, { sourceId, seriesId: null, data: object });
      }
      cache.setCursor(dav.id, JSON.stringify({ syncToken: changes.syncToken }));
      if (changed || this.derivedFor.get(dav.id) !== key) {
        const objects = cache.items<StoredObject>(dav.id).map((i) => i.data);
        cache.setDerivedEvents(dav.id, deriveCalDav(dav, objects, window, zone), readAt);
        this.derivedFor.set(dav.id, key);
      }
    });
  }

  /** Work the calendar's events out again (after an edit changed its objects here). */
  rederive(calendar: CalDavCalendar) {
    const window = syncWindow(new Date(this.now()));
    const objects = this.options.cache.items<StoredObject>(calendar.id).map((i) => i.data);
    this.options.cache.setDerivedEvents(
      calendar.id,
      deriveCalDav(calendar, objects, window, this.zone()),
    );
  }

  problem(error: unknown, calendar: SourceCalendar): SyncProblem {
    if (!(error instanceof CalDavError))
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
          message: `“${calendar.name}” is no longer on the server, or this account can't see it.`,
        };
      default:
        return { kind: 'other', message: error.message };
    }
  }
}

const sameHref = (a: string, b: string) => {
  const path = (u: string) => {
    try {
      return decodeURIComponent(new URL(u, 'http://x').pathname);
    } catch {
      return u;
    }
  };
  return path(a) === path(b);
};
