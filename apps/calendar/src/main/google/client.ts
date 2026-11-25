/**
 * Google Calendar's API (`/calendar/v3`), with the account's access token.
 *
 * - A `401` refreshes the token and tries once more.
 * - Rate limits (`429`, or `403` with `rateLimitExceeded`) and server errors wait and try again,
 *   longer each time (or as long as `Retry-After` says).
 * - Failures become `GoogleApiError`s with a code the sync acts on and a message fit to show.
 *   Tokens never appear in an error or a log line.
 */
import type { GoogleCalendarEntry, GoogleEvent } from '../../shared/google';
import { GoogleAuthError } from './oauth';

export type GoogleErrorCode =
  /** Google couldn't be reached. */
  | 'network'
  /** The sign-in stopped working (revoked, or the client changed). */
  | 'unauthorized'
  /** A sync token Google no longer accepts: sync from scratch. */
  | 'gone'
  | 'not_found'
  | 'forbidden'
  | 'rate_limited'
  /** `412`: the event changed since it was read (v1.1 B). */
  | 'precondition_failed'
  | 'bad_request'
  | 'server';

export class GoogleApiError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TokenSource {
  accessToken(): Promise<string>;
  invalidate(token: string): void;
}

export interface GoogleClientOptions {
  tokens: TokenSource;
  /** Where `/calendar/v3` is (`https://www.googleapis.com`). */
  base: string;
  fetch?: typeof fetch;
  sleep?: Sleep;
  /** Waits after rate limits and server errors before giving up. */
  maxRetries?: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** `Retry-After` in seconds, else 1, 2, 4… seconds; at most a minute. */
function backoffMs(header: string | null, attempt: number): number {
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  return Math.min(1000 * 2 ** attempt, 60_000);
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; errors?: { reason?: string }[]; status?: string };
}

export class GoogleClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: Sleep;
  private readonly maxRetries: number;

  constructor(private readonly options: GoogleClientOptions) {
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.maxRetries = options.maxRetries ?? 4;
  }

  async request<T>(
    method: string,
    path: string,
    init: { query?: Record<string, string | undefined>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${this.options.base.replace(/\/$/, '')}/calendar/v3${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      let token: string;
      try {
        token = await this.options.tokens.accessToken();
      } catch (e) {
        if (e instanceof GoogleAuthError && e.code === 'network')
          throw new GoogleApiError('network', "Couldn't reach Google.");
        if (e instanceof GoogleAuthError) throw new GoogleApiError('unauthorized', e.message);
        throw e;
      }
      let res: Response;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
            ...(init.body !== undefined && { 'content-type': 'application/json' }),
            ...init.headers,
          },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new GoogleApiError('network', "Couldn't reach Google.");
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      const body = (await res.json().catch(() => ({}))) as GoogleErrorBody;
      const reason = body.error?.errors?.[0]?.reason ?? '';
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.options.tokens.invalidate(token);
        attempt--;
        continue;
      }
      const retryable =
        res.status === 429 ||
        (res.status === 403 && /rateLimitExceeded/i.test(reason)) ||
        res.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(backoffMs(res.headers.get('retry-after'), attempt));
        continue;
      }
      throw errorFor(res.status, reason, body.error?.message);
    }
  }
}

function errorFor(status: number, reason: string, message: string | undefined): GoogleApiError {
  const said = message ? ` (${message})` : '';
  if (status === 401)
    return new GoogleApiError('unauthorized', 'Google signed this account out. Sign in again.', status);
  if (status === 410) return new GoogleApiError('gone', 'Sync from scratch.', status);
  if (status === 404) return new GoogleApiError('not_found', 'Google has no such calendar or event.', status);
  if (status === 412)
    return new GoogleApiError('precondition_failed', 'The event changed in Google.', status);
  if (status === 429 || /rateLimitExceeded/i.test(reason))
    return new GoogleApiError('rate_limited', 'Google is limiting requests; trying again later.', status);
  if (status === 403)
    return new GoogleApiError('forbidden', `Google didn't allow this${said}.`, status);
  if (status >= 500)
    return new GoogleApiError('server', `Google had a problem (${status}); trying again later.`, status);
  return new GoogleApiError('bad_request', `Google refused the request${said}.`, status);
}

const EVENT_FIELDS =
  'id,status,etag,summary,description,location,htmlLink,hangoutLink,conferenceData(entryPoints(entryPointType,uri)),start,end,endTimeUnspecified,recurrence,recurringEventId,originalStartTime,updated';

/** The account's calendars and their events. */
export class GoogleEngine {
  constructor(private readonly client: GoogleClient) {}

  /** Every calendar in the account's list (hidden ones too: the person picks). */
  async calendars(): Promise<GoogleCalendarEntry[]> {
    const out: GoogleCalendarEntry[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.client.request<{ items?: GoogleCalendarEntry[]; nextPageToken?: string }>(
        'GET',
        '/users/me/calendarList',
        {
          query: {
            maxResults: '250',
            showHidden: 'true',
            pageToken,
            fields:
              'nextPageToken,items(id,summary,summaryOverride,backgroundColor,accessRole,timeZone,primary,hidden,selected)',
          },
        },
      );
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  /**
   * A calendar's events: every one ending after `timeMin` (a first sync), or the changes since a
   * sync token (deleted events come back `cancelled`). Series come once, not expanded.
   */
  async events(
    calendarId: string,
    from: { syncToken: string } | { timeMin: string },
  ): Promise<{ items: GoogleEvent[]; nextSyncToken: string | null }> {
    const items: GoogleEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const page = await this.client.request<{
        items?: GoogleEvent[];
        nextPageToken?: string;
        nextSyncToken?: string;
      }>('GET', `/calendars/${encodeURIComponent(calendarId)}/events`, {
        query: {
          maxResults: '2500',
          singleEvents: 'false',
          pageToken,
          fields: `nextPageToken,nextSyncToken,items(${EVENT_FIELDS})`,
          ...('syncToken' in from
            ? { syncToken: from.syncToken }
            : { timeMin: from.timeMin, showDeleted: 'false' }),
        },
      });
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  }
}
