/**
 * A stand-in for Google Calendar, for the integration tests and E2E: the sign-in page (which
 * answers at once), the token endpoint (checking the client, PKCE and refresh tokens; access
 * tokens that can be made to expire), revocation, `calendarList`, and `events` (list with
 * paging, sync tokens and `410`; insert, patch and delete with etags and `412`).
 *
 * Tests change what's "in Google" with `put` and `remove`, as someone editing in Google would.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleCalendarEntry, GoogleEvent } from '../src/shared/google';

interface Stored {
  event: GoogleEvent;
  seq: number;
}

export interface FakeGoogle {
  origin: string;
  clientId: string;
  clientSecret: string;
  email: string;
  calendars: Map<string, { entry: GoogleCalendarEntry; events: Map<string, Stored> }>;
  /** `expires_in` given with new access tokens (seconds). */
  expiresIn: number;
  /** Items per page of `events.list` (Google's is up to 2500). */
  pageSize: number;
  /** Failures for the next API requests, in order. */
  failures: { status: number; reason?: string; retryAfter?: string }[];
  /** API requests made: `GET /calendar/v3/...?...` (no tokens). */
  requests: string[];
  grants: string[];
  revoked: string[];
  addCalendar(entry: GoogleCalendarEntry): void;
  /** Adds or changes an event, as if edited in Google. */
  put(calendarId: string, event: Omit<GoogleEvent, 'etag' | 'updated'>): GoogleEvent;
  /** Deletes an event, as if deleted in Google (sync reads it as cancelled). */
  remove(calendarId: string, eventId: string): void;
  /** Makes every access token stop working (as an hour passing would). */
  expireTokens(): void;
  /** Makes every sync token so far answer `410`. */
  invalidateSyncTokens(): void;
  close(): Promise<void>;
}

const read = async (req: IncomingMessage) => {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
};

const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** When an event ends (ms), for `timeMin`; series and unreadable times count as never. */
function endOf(event: GoogleEvent): number {
  if (event.recurrence?.length) return Infinity;
  const end = event.end?.dateTime ?? event.end?.date;
  return end ? Date.parse(end) : Infinity;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const access = new Set<string>();
  let n = 0;
  let seq = 0;
  let generation = 1;
  let clock = Date.parse('2026-11-01T00:00:00Z');
  const updated = () => new Date((clock += 1000)).toISOString();

  const fake = {
    clientId: 'calendar-test.apps.googleusercontent.com',
    clientSecret: 'not-so-secret',
    email: 'ada@lab.io',
    calendars: new Map<string, { entry: GoogleCalendarEntry; events: Map<string, Stored> }>(),
    expiresIn: 3600,
    pageSize: 2500,
    failures: [] as FakeGoogle['failures'],
    requests: [] as string[],
    grants: [] as string[],
    revoked: [] as string[],
    addCalendar(entry: GoogleCalendarEntry) {
      fake.calendars.set(entry.id, { entry, events: new Map() });
    },
    put(calendarId: string, event: Omit<GoogleEvent, 'etag' | 'updated'>): GoogleEvent {
      const calendar = fake.calendars.get(calendarId);
      if (!calendar) throw new Error(`No calendar ${calendarId}`);
      const stored: GoogleEvent = {
        status: 'confirmed',
        ...event,
        etag: `"${++n}"`,
        updated: updated(),
        htmlLink: `https://www.google.com/calendar/event?eid=${b64url(event.id)}`,
      };
      calendar.events.set(event.id, { event: stored, seq: ++seq });
      return stored;
    },
    remove(calendarId: string, eventId: string) {
      const calendar = fake.calendars.get(calendarId);
      const found = calendar?.events.get(eventId);
      if (!calendar || !found) throw new Error(`No event ${eventId}`);
      calendar.events.set(eventId, {
        event: { ...found.event, status: 'cancelled', etag: `"${++n}"`, updated: updated() },
        seq: ++seq,
      });
    },
    expireTokens() {
      access.clear();
    },
    invalidateSyncTokens() {
      generation++;
    },
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(body));
      };
      const apiError = (status: number, reason: string, message = reason) =>
        json(status, { error: { code: status, message, errors: [{ reason }] } });

      // --- Signing in --------------------------------------------------------------------
      if (url.pathname === '/auth') {
        const q = url.searchParams;
        const redirect = q.get('redirect_uri') ?? '';
        const ok =
          q.get('client_id') === fake.clientId &&
          q.get('code_challenge_method') === 'S256' &&
          q.get('access_type') === 'offline' &&
          q.get('scope')?.includes('auth/calendar.events') &&
          /^http:\/\/127\.0\.0\.1:\d+\/oauth$/.test(redirect);
        if (!ok) return json(400, { error: 'invalid_request' });
        const code = `code-${++n}`;
        codes.set(code, { challenge: q.get('code_challenge') ?? '', redirect });
        res.writeHead(302, { location: `${redirect}?code=${code}&state=${q.get('state')}` });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        const form = new URLSearchParams(await read(req));
        if (
          form.get('client_id') !== fake.clientId ||
          form.get('client_secret') !== fake.clientSecret
        )
          return json(401, { error: 'invalid_client' });
        fake.grants.push(form.get('grant_type') ?? '');
        const token = `at-${++n}`;
        if (form.get('grant_type') === 'authorization_code') {
          const issued = codes.get(form.get('code') ?? '');
          codes.delete(form.get('code') ?? '');
          const challenge = b64url(
            createHash('sha256')
              .update(form.get('code_verifier') ?? '')
              .digest(),
          );
          if (
            !issued ||
            issued.challenge !== challenge ||
            issued.redirect !== form.get('redirect_uri')
          )
            return json(400, { error: 'invalid_grant' });
          access.add(token);
          const idToken = `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify({ email: fake.email }))}.x`;
          return json(200, {
            access_token: token,
            expires_in: fake.expiresIn,
            refresh_token: 'rt-1',
            id_token: idToken,
          });
        }
        if (form.get('grant_type') === 'refresh_token') {
          if (form.get('refresh_token') !== 'rt-1' || fake.revoked.includes('rt-1'))
            return json(400, { error: 'invalid_grant' });
          access.add(token);
          return json(200, { access_token: token, expires_in: fake.expiresIn });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/revoke' && req.method === 'POST') {
        fake.revoked.push(new URLSearchParams(await read(req)).get('token') ?? '');
        access.clear();
        return json(200, {});
      }

      // --- The API -----------------------------------------------------------------------
      if (!url.pathname.startsWith('/calendar/v3/')) return json(404, { error: 'not found' });
      fake.requests.push(`${req.method} ${url.pathname}${url.search}`);
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (!access.has(token)) return apiError(401, 'authError', 'Invalid Credentials');
      const failure = fake.failures.shift();
      if (failure) {
        res.writeHead(failure.status, {
          'content-type': 'application/json',
          ...(failure.retryAfter && { 'retry-after': failure.retryAfter }),
        });
        return res.end(
          JSON.stringify({
            error: {
              code: failure.status,
              message: 'fake failure',
              errors: [{ reason: failure.reason ?? 'backendError' }],
            },
          }),
        );
      }
      const path = url.pathname.slice('/calendar/v3'.length);

      if (path === '/users/me/calendarList' && req.method === 'GET') {
        return json(200, { items: [...fake.calendars.values()].map((c) => c.entry) });
      }

      const events = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
      if (!events) return apiError(404, 'notFound');
      const calendar = fake.calendars.get(decodeURIComponent(events[1]!));
      if (!calendar) return apiError(404, 'notFound', 'Not Found');
      const eventId = events[2] && decodeURIComponent(events[2]);

      if (!eventId && req.method === 'GET') {
        const q = url.searchParams;
        let since = 0;
        const syncToken = q.get('syncToken');
        if (syncToken) {
          const [g, s] = syncToken.split(':').map(Number);
          if (g !== generation)
            return apiError(410, 'fullSyncRequired', 'Sync token is no longer valid');
          since = s!;
        }
        const timeMin = q.get('timeMin') ? Date.parse(q.get('timeMin')!) : -Infinity;
        const all = [...calendar.events.values()]
          .filter((s) =>
            syncToken
              ? s.seq > since
              : (s.event.status !== 'cancelled' || !!s.event.recurringEventId) &&
                endOf(s.event) > timeMin,
          )
          .sort((a, b) => a.seq - b.seq)
          .map((s) => s.event);
        const offset = Number(q.get('pageToken') ?? 0);
        const size = Math.min(fake.pageSize, Number(q.get('maxResults') ?? 250));
        const items = all.slice(offset, offset + size);
        const more = offset + size < all.length;
        return json(200, {
          items,
          ...(more
            ? { nextPageToken: String(offset + size) }
            : { nextSyncToken: `${generation}:${seq}` }),
        });
      }

      if (!eventId && req.method === 'POST') {
        const body = JSON.parse(await read(req)) as GoogleEvent;
        const created = fake.put(calendar.entry.id, { ...body, id: `ev${++n}` });
        return json(200, created);
      }

      let found = eventId ? calendar.events.get(eventId) : undefined;
      // An occurrence of a series, by Google's id for it (`<series>_<start>`), not changed yet.
      const occurrence = !found && eventId && /^(.+)_(\d{8})(T\d{6}Z)?$/.exec(eventId);
      const master = occurrence ? calendar.events.get(occurrence[1]!)?.event : undefined;
      if (occurrence && master?.recurrence && master.status !== 'cancelled') {
        const d = occurrence[2]!;
        const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
        const t = occurrence[3];
        const start = t ? `${day}T${t.slice(1, 3)}:${t.slice(3, 5)}:${t.slice(5, 7)}Z` : undefined;
        const length = master.start?.dateTime
          ? Date.parse(master.end!.dateTime!) - Date.parse(master.start.dateTime)
          : 0;
        const { recurrence: _r, ...rest } = master;
        found = {
          seq: 0,
          event: {
            ...rest,
            id: eventId!,
            recurringEventId: master.id,
            originalStartTime: start
              ? { dateTime: start, timeZone: master.start?.timeZone }
              : { date: day },
            start: start ? { dateTime: start, timeZone: master.start?.timeZone } : { date: day },
            end: start
              ? {
                  dateTime: new Date(Date.parse(start) + length).toISOString(),
                  timeZone: master.start?.timeZone,
                }
              : master.end,
            etag: undefined,
          },
        };
        // Patched or deleted, it becomes an exception of the series.
        if (req.method !== 'GET') calendar.events.set(eventId!, found);
      }
      if (!found || found.event.status === 'cancelled') return apiError(404, 'notFound');
      const ifMatch = req.headers['if-match'];
      if (ifMatch && ifMatch !== found.event.etag)
        return apiError(412, 'conditionNotMet', 'Precondition Failed');
      if (req.method === 'GET') return json(200, found.event);
      if (req.method === 'PATCH') {
        const patch = JSON.parse(await read(req)) as Partial<GoogleEvent>;
        return json(
          200,
          fake.put(calendar.entry.id, { ...found.event, ...patch, id: found.event.id }),
        );
      }
      if (req.method === 'DELETE') {
        fake.remove(calendar.entry.id, found.event.id);
        res.writeHead(204);
        return res.end();
      }
      return apiError(405, 'methodNotAllowed');
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
}

/** The environment that points the app at the fake. */
export function googleEnv(fake: FakeGoogle): Record<string, string> {
  return {
    CALENDAR_GOOGLE_AUTH_URL: `${fake.origin}/auth`,
    CALENDAR_GOOGLE_TOKEN_URL: `${fake.origin}/token`,
    CALENDAR_GOOGLE_REVOKE_URL: `${fake.origin}/revoke`,
    CALENDAR_GOOGLE_API_URL: fake.origin,
    CALENDAR_GOOGLE_CLIENT_ID: fake.clientId,
    CALENDAR_GOOGLE_CLIENT_SECRET: fake.clientSecret,
  };
}
