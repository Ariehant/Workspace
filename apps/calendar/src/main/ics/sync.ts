/**
 * Calendars subscribed to by URL (HANDOFF.md 5): an iCalendar feed is read whole, every 30
 * minutes and when asked ("Sync now"), and only sent again when it changed (`If-None-Match`,
 * `If-Modified-Since`: a `304` costs nothing). Its events replace the calendar's, and are worked
 * out again when the window moves on a day or the time zone changes, as Google's are.
 */
import { syncWindow } from '../../shared/dates';
import { deriveEvents, type GoogleEvent } from '../../shared/google';
import type { IcsCalendar } from '../../shared/types';
import { localZone } from '../../shared/zones';
import type { Cache } from '../cache';
import type { SourceCalendar, SourceSync, SyncProblem } from '../sync';
import { IcsParseError, parseIcs, type ParsedFeed } from './parse';

export const REFRESH_EVERY_MS = 30 * 60_000;
const TIMEOUT_MS = 30_000;
/** A feed larger than this is refused (a calendar of decades is a few MB). */
export const MAX_FEED_BYTES = 20 * 1024 * 1024;

export class IcsFetchError extends Error {
  constructor(
    /** `network`, `not_found` (404/410), `forbidden` (401/403), `too_large` or `http`. */
    readonly code: 'network' | 'not_found' | 'forbidden' | 'too_large' | 'http',
    message: string,
  ) {
    super(message);
    this.name = 'IcsFetchError';
  }
}

/** `webcal://` is the same feed over HTTPS; only `http(s)` is fetched. */
export function feedUrl(input: string): string {
  const trimmed = input.trim();
  const url = new URL(trimmed.replace(/^webcals?:\/\//i, 'https://'));
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Enter a feed address starting with https://, http:// or webcal://.');
  url.hash = '';
  return url.href;
}

/** What's kept of the last read, to ask only for changes. */
interface Validators {
  etag: string | null;
  lastModified: string | null;
  /** When it was last read (ms), for the 30 minutes between refreshes. */
  readAt: number;
}

/**
 * Fetch a feed. Null when it hasn't changed since `validators`; redirects are followed (fetch
 * stops at 20).
 */
export async function fetchFeed(
  url: string,
  validators: Pick<Validators, 'etag' | 'lastModified'> | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; etag: string | null; lastModified: string | null } | null> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        accept: 'text/calendar, text/plain;q=0.8, */*;q=0.5',
        'user-agent': 'WorkspaceCalendar/1.2',
        ...(validators?.etag && { 'if-none-match': validators.etag }),
        ...(validators?.lastModified && { 'if-modified-since': validators.lastModified }),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new IcsFetchError('network', "Couldn't reach the feed's server.");
  }
  if (res.status === 304) return null;
  if (res.status === 404 || res.status === 410)
    throw new IcsFetchError('not_found', 'The feed is no longer at this address.');
  if (res.status === 401 || res.status === 403)
    throw new IcsFetchError(
      'forbidden',
      "The feed's server refuses it (the address may have changed).",
    );
  if (!res.ok) throw new IcsFetchError('http', `The feed's server answered ${res.status}.`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FEED_BYTES)
    throw new IcsFetchError('too_large', 'The feed is too large (over 20 MB).');
  // Read it with a cap, whatever the headers say.
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BYTES) {
        await reader.cancel();
        throw new IcsFetchError('too_large', 'The feed is too large (over 20 MB).');
      }
      chunks.push(value);
    }
  }
  return {
    text: Buffer.concat(chunks).toString('utf8'),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/** Read a feed once, to subscribe: its name and zone, and that it's a calendar. */
export async function probeFeed(url: string, fetchImpl?: typeof fetch): Promise<ParsedFeed> {
  const feed = await fetchFeed(url, null, fetchImpl);
  if (!feed) throw new IcsFetchError('http', 'The feed sent nothing.');
  return parseIcs(feed.text);
}

export class IcsCalendarSync implements SourceSync {
  private derivedFor = new Map<string, string>();
  private readonly now: () => number;
  private readonly zone: () => string;

  constructor(
    private readonly options: {
      cache: Cache;
      fetch?: typeof fetch;
      now?: () => number;
      zone?: () => string;
    },
  ) {
    this.now = options.now ?? Date.now;
    this.zone = options.zone ?? localZone;
  }

  async sync(calendar: SourceCalendar, full: boolean): Promise<void> {
    const ics = calendar as IcsCalendar;
    const { cache } = this.options;
    const stored = cache.cursor(ics.id);
    const validators = stored ? (JSON.parse(stored) as Validators) : null;
    const due = full || !validators || this.now() - validators.readAt >= REFRESH_EVERY_MS;
    let feed: ParsedFeed | null = null;
    let next: Validators | null = null;
    if (due) {
      const read = await fetchFeed(ics.url, validators, this.options.fetch);
      next = {
        etag: read ? read.etag : (validators?.etag ?? null),
        lastModified: read ? read.lastModified : (validators?.lastModified ?? null),
        readAt: this.now(),
      };
      if (read) feed = parseIcs(read.text);
    }
    if (!cache.calendar(ics.id)) return; // Removed while it was being read.

    const zone = this.zone();
    const window = syncWindow(new Date(this.now()));
    const key = `${window.from}|${window.to}|${zone}`;
    cache.transaction(() => {
      if (feed) {
        cache.clearItems(ics.id);
        for (const item of feed.items)
          cache.putItem(ics.id, {
            sourceId: item.id,
            seriesId: item.recurringEventId ?? null,
            data: item,
          });
      }
      if (next) cache.setCursor(ics.id, JSON.stringify(next));
      if (feed || this.derivedFor.get(ics.id) !== key) {
        const items = cache.items<GoogleEvent>(ics.id).map((i) => i.data);
        cache.setDerivedEvents(ics.id, deriveEvents(ics, items, window, zone));
        this.derivedFor.set(ics.id, key);
      }
    });
  }

  problem(error: unknown, calendar: SourceCalendar): SyncProblem {
    if (error instanceof IcsFetchError) {
      if (error.code === 'network') return { kind: 'offline' };
      if (error.code === 'not_found' || error.code === 'forbidden')
        return {
          kind: 'calendar',
          status: 'no-access',
          message: `“${calendar.name}”: ${error.message}`,
        };
      return {
        kind: 'calendar',
        status: 'needs-setup',
        message: `“${calendar.name}”: ${error.message}`,
      };
    }
    if (error instanceof IcsParseError)
      return {
        kind: 'calendar',
        status: 'needs-setup',
        message: `“${calendar.name}”: ${error.message}`,
      };
    return { kind: 'other', message: error instanceof Error ? error.message : String(error) };
  }
}
