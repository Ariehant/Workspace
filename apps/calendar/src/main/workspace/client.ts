/**
 * A small client for a Workspace server's `/v1` API (Notion's shape).
 *
 * It keeps under the server's limit with a token bucket (3 requests a second, bursts of 30,
 * per integration), waits for `Retry-After` on a `429`, and turns failures into
 * `WorkspaceApiError`s with a message fit to show the user. The token never leaves this module
 * in an error or a log line.
 */

export const NOTION_VERSION = '2022-06-28';

/** Codes from the server (Notion's), plus `network` and `not_workspace` from here. */
export type ApiErrorCode =
  | 'unauthorized'
  | 'restricted_resource'
  | 'object_not_found'
  | 'validation_error'
  | 'invalid_request'
  | 'invalid_json'
  | 'rate_limited'
  | 'conflict_error'
  | 'internal_server_error'
  | 'service_unavailable'
  | 'network'
  | 'not_workspace'
  | (string & {});

export class WorkspaceApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }
}

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Requests a second on average, with bursts: `take()` waits until a request may go. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Wait for a token (callers are served in order). */
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const now = this.now();
        this.tokens = Math.min(
          this.burst,
          this.tokens + ((now - this.last) / 1000) * this.perSecond,
        );
        this.last = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.sleep(Math.ceil(((1 - this.tokens) / this.perSecond) * 1000));
      }
    });
    this.queue = turn.catch(() => {});
    return turn;
  }

  /** After a `429`: the server's bucket is empty, so ours should be too. */
  drain(): void {
    this.tokens = 0;
    this.last = this.now();
  }
}

export interface ClientOptions {
  /** e.g. `https://notes.example.com` */
  server: string;
  token: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: Sleep;
  perSecond?: number;
  burst?: number;
  /** How many times to wait and retry after a `429` (then fail with `rate_limited`). */
  maxRetries?: number;
  /** Per request, in ms. */
  timeoutMs?: number;
}

export interface ListResponse<T> {
  object: 'list';
  results: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface ApiResponse<T> {
  body: T;
  /** The server's clock when it answered (its `Date` header), in ms, or null. */
  serverTime: number | null;
}

/** A server address as the user typed it: a scheme added if missing, no trailing slash. */
export function normaliseServer(input: string): string {
  let s = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  const url = new URL(s);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new WorkspaceApiError('invalid_request', 'The address should start with https://.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export class WorkspaceClient {
  readonly server: string;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: Sleep;
  private readonly bucket: TokenBucket;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions) {
    this.server = normaliseServer(options.server);
    this.token = options.token;
    this.fetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? realSleep;
    this.bucket = new TokenBucket(
      options.perSecond ?? 3,
      options.burst ?? 30,
      options.now ?? Date.now,
      this.sleep,
    );
    this.maxRetries = options.maxRetries ?? 5;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      await this.bucket.take();
      let res: Response;
      try {
        res = await this.fetch(`${this.server}/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            'notion-version': NOTION_VERSION,
            accept: 'application/json',
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        throw new WorkspaceApiError('network', `Can't reach ${hostOf(this.server)}.`);
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        this.bucket.drain();
        await this.sleep(retryAfterMs(res.headers.get('retry-after')));
        continue;
      }
      const date = Date.parse(res.headers.get('date') ?? '');
      const serverTime = Number.isNaN(date) ? null : date;
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = undefined;
      }
      if (res.ok && json && typeof json === 'object') return { body: json as T, serverTime };
      throw errorFrom(res.status, json, this.server);
    }
  }

  /** Every page of a paginated list (a POST body gets `start_cursor`, a GET a query). */
  async all<T>(method: 'GET' | 'POST', path: string, body: Record<string, unknown> = {}) {
    const results: T[] = [];
    let serverTime: number | null = null;
    let cursor: string | null = null;
    do {
      const page: ApiResponse<ListResponse<T>> =
        method === 'POST'
          ? await this.request('POST', path, {
              ...body,
              page_size: 100,
              ...(cursor && { start_cursor: cursor }),
            })
          : await this.request(
              'GET',
              `${path}${path.includes('?') ? '&' : '?'}page_size=100${
                cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''
              }`,
            );
      // The server's time when the first page was read: changes after it show next time.
      serverTime ??= page.serverTime;
      results.push(...page.body.results);
      cursor = page.body.has_more ? page.body.next_cursor : null;
    } while (cursor);
    return { results, serverTime };
  }
}

const hostOf = (server: string) => {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
};

/** `Retry-After` in seconds (or an HTTP date); 1 s when missing, at most a minute. */
function retryAfterMs(header: string | null): number {
  if (!header) return 1000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000));
  const at = Date.parse(header);
  return Number.isNaN(at) ? 1000 : Math.min(60_000, Math.max(0, at - Date.now()));
}

function errorFrom(status: number, json: unknown, server: string): WorkspaceApiError {
  const error =
    json && typeof json === 'object' && (json as { object?: unknown }).object === 'error'
      ? (json as { code?: string; message?: string })
      : null;
  if (!error) {
    return new WorkspaceApiError(
      'not_workspace',
      `${hostOf(server)} doesn't look like a Workspace server (no API answered at /v1).`,
      status,
    );
  }
  const code = error.code ?? 'internal_server_error';
  const message =
    code === 'unauthorized'
      ? 'The token was not accepted. Copy it again from Members → Integrations in Workspace.'
      : code === 'rate_limited'
        ? 'Workspace is busy (rate limited). The calendar will try again shortly.'
        : (error.message ?? `The server answered ${status}.`);
  return new WorkspaceApiError(code, message, status);
}
