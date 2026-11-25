/**
 * A CalDAV server (HANDOFF.md 5): Nextcloud, Fastmail, Radicale, iCloud, with a username and an
 * app password (HTTP Basic, so only over HTTPS unless the server is this machine).
 *
 * tsdav finds the account's calendars (`.well-known/caldav`, the principal, its calendar home)
 * and reads changes (`sync-collection`, or ETags where a server has no sync tokens). Writes are
 * plain `PUT` and `DELETE` with `If-Match` (or `If-None-Match: *` to create), sent here so their
 * status codes and ETags are ours to read.
 */
import { createDAVClient, type DAVCalendar, type DAVObject } from 'tsdav';

export class CalDavError extends Error {
  constructor(
    /** `network`, `unauthorized`, `not_found`, `forbidden`, `precondition_failed`, `server`. */
    readonly code:
      | 'network'
      | 'unauthorized'
      | 'not_found'
      | 'forbidden'
      | 'precondition_failed'
      | 'not_caldav'
      | 'server',
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'CalDavError';
  }
}

export interface CalDavCredentials {
  server: string;
  username: string;
  password: string;
}

/** A calendar on the server, as the connect dialog lists it. */
export interface RemoteCalendar {
  url: string;
  name: string;
  /** `#rrggbb`, or null. */
  colour: string | null;
  /** An IANA zone from the calendar's `calendar-timezone`, or null. */
  timeZone: string | null;
}

/** An event resource on the server: its address, version and iCalendar text. */
export interface RemoteObject {
  href: string;
  etag: string | null;
  ics: string;
}

/** `https://cloud.example.com` (or with a path), checked; HTTP only for this machine. */
export function normaliseServer(input: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new CalDavError('not_caldav', "That isn't a server address.");
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    throw new CalDavError(
      'not_caldav',
      'Use an https:// address (the password is sent with every request).',
    );
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/$/, '');
}

function errorFromStatus(status: number, what: string): CalDavError {
  if (status === 401)
    return new CalDavError('unauthorized', 'The server refused the username or app password.', 401);
  if (status === 403) return new CalDavError('forbidden', `The server doesn't allow ${what}.`, 403);
  if (status === 404 || status === 410)
    return new CalDavError('not_found', `The server has no such ${what}.`, status);
  if (status === 412)
    return new CalDavError('precondition_failed', 'It changed on the server.', 412);
  return new CalDavError('server', `The server answered ${status} for ${what}.`, status);
}

/** tsdav's failures as ours (it throws plain errors, with the status in the message). */
function asCalDavError(error: unknown, what: string): CalDavError {
  if (error instanceof CalDavError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (
    error instanceof TypeError ||
    /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(message)
  )
    return new CalDavError('network', "Couldn't reach the server.");
  const status = /\b(401|403|404|410|412|5\d\d)\b/.exec(message)?.[1];
  if (status) return errorFromStatus(Number(status), what);
  if (/Invalid credentials|unauthori[sz]ed/i.test(message)) return errorFromStatus(401, what);
  if (/cannot find (homeUrl|rootUrl|principalUrl)|no account/i.test(message))
    return new CalDavError('not_caldav', "That server doesn't answer as a CalDAV server.");
  return new CalDavError('server', message);
}

const hexColour = (value: unknown) => {
  const m =
    typeof value === 'string' ? /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value.trim()) : null;
  return m ? `#${m[1]!.toLowerCase()}` : null;
};

const displayName = (calendar: DAVCalendar) =>
  typeof calendar.displayName === 'string' && calendar.displayName.trim()
    ? calendar.displayName.trim()
    : decodeURIComponent(calendar.url.replace(/\/$/, '').split('/').pop() ?? 'Calendar');

/** The zone a `calendar-timezone` (a VTIMEZONE) names, if it's an IANA one. */
function zoneOf(calendar: DAVCalendar): string | null {
  const tz =
    typeof calendar.timezone === 'string' ? /TZID:([^\r\n]+)/.exec(calendar.timezone)?.[1] : null;
  return tz?.trim() || null;
}

export class CalDavClient {
  private client: ReturnType<typeof createDAVClient> | null = null;
  private readonly auth: string;
  private readonly fetch: typeof fetch;

  constructor(
    readonly credentials: CalDavCredentials,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.auth = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    this.fetch = fetchImpl;
  }

  /** tsdav's client, logged in once (it discovers the account's calendar home). */
  private dav() {
    this.client ??= createDAVClient({
      serverUrl: this.credentials.server,
      credentials: { username: this.credentials.username, password: this.credentials.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: this.fetch,
    }).catch((error: unknown) => {
      this.client = null; // Try discovery again next time.
      throw asCalDavError(error, 'calendars');
    });
    return this.client;
  }

  /** The account's event calendars. */
  async calendars(): Promise<RemoteCalendar[]> {
    const dav = await this.dav();
    let calendars: DAVCalendar[];
    try {
      calendars = await dav.fetchCalendars();
    } catch (error) {
      throw asCalDavError(error, 'calendars');
    }
    return calendars
      .filter((c) => !c.components?.length || c.components.includes('VEVENT'))
      .map((c) => ({
        url: c.url,
        name: displayName(c),
        colour: hexColour(c.calendarColor),
        timeZone: zoneOf(c),
      }));
  }

  /**
   * What changed in a calendar since `syncToken` (everything without one), given the objects
   * kept here (for servers without sync tokens, compared by ETag).
   */
  async changes(
    calendarUrl: string,
    syncToken: string | null,
    known: { href: string; etag: string | null }[],
  ): Promise<{ changed: RemoteObject[]; deleted: string[]; syncToken: string | null }> {
    const dav = await this.dav();
    try {
      const [calendar] = (await dav.fetchCalendars()).filter((c) => sameUrl(c.url, calendarUrl));
      if (!calendar) throw new CalDavError('not_found', 'The server has no such calendar.', 404);
      const result = await dav.smartCollectionSyncDetailed({
        collection: {
          ...calendar,
          syncToken: syncToken ?? undefined,
          objects: known.map((o) => ({ url: o.href, etag: o.etag ?? undefined })),
          objectMultiGet: dav.calendarMultiGet,
          // For servers without sync tokens: every object, compared by ETag.
          fetchObjects: (params?: { collection: DAVCalendar }) =>
            dav.fetchCalendarObjects({ calendar: params!.collection }),
        },
        method: calendar.reports?.includes('syncCollection') ? 'webdav' : 'basic',
      });
      const objects = result.objects as {
        created: DAVObject[];
        updated: DAVObject[];
        deleted: DAVObject[];
      };
      return {
        changed: [...objects.created, ...objects.updated]
          .filter((o) => typeof o.data === 'string')
          .map((o) => ({ href: o.url, etag: o.etag ?? null, ics: o.data as string })),
        deleted: objects.deleted.map((o) => o.url),
        syncToken: result.syncToken ?? null,
      };
    } catch (error) {
      throw asCalDavError(error, 'calendar');
    }
  }

  private async request(
    method: string,
    url: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ) {
    try {
      return await this.fetch(url, {
        method,
        headers: { authorization: this.auth, ...init.headers },
        ...(init.body !== undefined && { body: init.body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CalDavError('network', "Couldn't reach the server.");
    }
  }

  /** One object, now: null if it's gone. */
  async get(href: string): Promise<RemoteObject | null> {
    const res = await this.request('GET', href, { headers: { accept: 'text/calendar' } });
    if (res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw errorFromStatus(res.status, 'event');
    return { href, etag: res.headers.get('etag'), ics: await res.text() };
  }

  /**
   * Write an object: a new one (`etag` undefined: refused if it exists), or a change to the
   * version `etag` names (null: whatever is there). Returns its new ETag, if the server says.
   */
  async put(href: string, ics: string, etag: string | null | undefined): Promise<string | null> {
    const res = await this.request('PUT', href, {
      body: ics,
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        ...(etag === undefined ? { 'if-none-match': '*' } : etag ? { 'if-match': etag } : {}),
      },
    });
    if (!res.ok) throw errorFromStatus(res.status, 'event');
    return res.headers.get('etag');
  }

  async delete(href: string, etag: string | null): Promise<void> {
    const res = await this.request('DELETE', href, etag ? { headers: { 'if-match': etag } } : {});
    if (res.status === 404 || res.status === 410) return; // Already gone.
    if (!res.ok) throw errorFromStatus(res.status, 'event');
  }
}

/** Two addresses for the same collection (servers differ on trailing slashes and hosts). */
export function sameUrl(a: string, b: string): boolean {
  const path = (u: string) => {
    try {
      return decodeURIComponent(new URL(u, 'http://x').pathname).replace(/\/$/, '');
    } catch {
      return u.replace(/\/$/, '');
    }
  };
  return path(a) === path(b);
}
