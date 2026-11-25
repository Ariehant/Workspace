/**
 * Signing in to Google, as an installed app (HANDOFF.md 4): the system browser asks the person,
 * and Google sends the answer to a server on 127.0.0.1 for that moment (an authorization code
 * with PKCE). The refresh token is then kept sealed by the caller (secrets.ts); access tokens
 * live in memory and are refreshed shortly before they expire, or after a `401`.
 *
 * The OAuth client is the owner's own Google Cloud project's ("Desktop app" type): set in
 * Settings, or by environment. Endpoints can be moved by environment for tests (a fake Google).
 *
 * No Electron here, so tests drive it with a fake browser.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface GoogleClientConfig {
  clientId: string;
  /** Google's desktop clients have one, though it isn't secret in an installed app. */
  clientSecret: string;
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  /** Where `/calendar/v3` is. */
  api: string;
}

export function googleEndpoints(env: NodeJS.ProcessEnv = process.env): GoogleEndpoints {
  return {
    auth: env.CALENDAR_GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    token: env.CALENDAR_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    revoke: env.CALENDAR_GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
    api: env.CALENDAR_GOOGLE_API_URL ?? 'https://www.googleapis.com',
  };
}

/** The client given by environment (a build or a test that brings one), if any. */
export function clientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): GoogleClientConfig | null {
  const clientId = env.CALENDAR_GOOGLE_CLIENT_ID?.trim();
  return clientId
    ? { clientId, clientSecret: env.CALENDAR_GOOGLE_CLIENT_SECRET?.trim() ?? '' }
    : null;
}

/** Who the person is, their calendars, and their events (read and, from v1.1 B, written). */
export const CALENDAR_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class GoogleAuthError extends Error {
  constructor(
    /** `invalid_grant` (signed out elsewhere, or revoked), `network`, or Google's code. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export interface TokenSet {
  accessToken: string;
  /** When the access token stops working (ms, this machine's clock). */
  expiresAt: number;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

/** The email in an ID token from Google's token endpoint (over TLS: read, not verified). */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: unknown;
    };
    return typeof json.email === 'string' ? json.email : null;
  } catch {
    return null;
  }
}

/** POST a form to the token endpoint; Google's `error` becomes the error's code. */
async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GoogleAuthError('network', "Couldn't reach Google.");
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof body.error === 'string' ? body.error : `http_${response.status}`;
    throw new GoogleAuthError(
      code,
      code === 'invalid_grant'
        ? 'Google signed this account out. Sign in again.'
        : code === 'invalid_client'
          ? 'Google doesn’t know this OAuth client. Check it in Settings.'
          : `Google refused the sign-in (${code}).`,
    );
  }
  return body;
}

const tokensFrom = (body: Record<string, unknown>, now: number): TokenSet => {
  if (typeof body.access_token !== 'string')
    throw new GoogleAuthError('bad_response', 'Google sent no access token.');
  const seconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;
  return { accessToken: body.access_token, expiresAt: now + seconds * 1000 };
};

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:3em;max-width:32em"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;

function send(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

export interface SignInOptions {
  config: GoogleClientConfig;
  endpoints: GoogleEndpoints;
  /** Opens the URL in the system browser. */
  open: (url: string) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  /** Aborting it cancels the sign-in (another one started, or the dialog closed). */
  signal?: AbortSignal;
}

export interface SignedIn extends TokenSet {
  refreshToken: string;
  email: string | null;
}

/** Ask in the browser; resolves with the tokens, or fails with a message fit to show. */
export async function signIn(options: SignInOptions): Promise<SignedIn> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  let settle!: (answer: { code: string } | { error: GoogleAuthError }) => void;
  const answered = new Promise<{ code: string } | { error: GoogleAuthError }>((r) => (settle = r));

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/oauth') return send(res, 404, page('Not found', ''));
    if (url.searchParams.get('state') !== state)
      return send(res, 400, page('Workspace Calendar', 'This sign-in link is out of date.'));
    const code = url.searchParams.get('code');
    if (code) {
      send(
        res,
        200,
        page('Signed in', 'You can close this tab and go back to Workspace Calendar.'),
      );
      settle({ code });
    } else {
      const error = url.searchParams.get('error') ?? 'cancelled';
      send(
        res,
        200,
        page('Not signed in', 'Google Calendar wasn’t connected. You can close this tab.'),
      );
      settle({
        error: new GoogleAuthError(
          error,
          error === 'access_denied' ? 'Access wasn’t allowed.' : `Google said: ${error}.`,
        ),
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth`;
  const timer = setTimeout(
    () => settle({ error: new GoogleAuthError('timeout', 'No answer from the browser.') }),
    options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
  );
  const onAbort = () => settle({ error: new GoogleAuthError('cancelled', 'Sign-in cancelled.') });
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const url = new URL(options.endpoints.auth);
    url.search = new URLSearchParams({
      client_id: options.config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPES.join(' '),
      state,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      // A refresh token, so it stays signed in.
      access_type: 'offline',
      prompt: 'consent',
    }).toString();
    await options.open(url.href);
    const answer = await answered;
    if ('error' in answer) throw answer.error;
    const body = await postForm(
      options.endpoints.token,
      {
        grant_type: 'authorization_code',
        code: answer.code,
        client_id: options.config.clientId,
        ...(options.config.clientSecret && { client_secret: options.config.clientSecret }),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      fetchImpl,
    );
    if (typeof body.refresh_token !== 'string')
      throw new GoogleAuthError('bad_response', 'Google sent no refresh token.');
    return {
      ...tokensFrom(body, now()),
      refreshToken: body.refresh_token,
      email: emailFromIdToken(body.id_token),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    server.close();
  }
}

/** Refreshes 2 minutes early, so a request doesn't leave with a token about to lapse. */
const EARLY_MS = 2 * 60_000;

/** An account's access tokens, from its refresh token. */
export class GoogleTokens {
  private current: TokenSet | null;
  private refreshing: Promise<string> | null = null;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly options: {
      config: () => GoogleClientConfig | null;
      endpoints: GoogleEndpoints;
      refreshToken: string;
      initial?: TokenSet | null;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.current = options.initial ?? null;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** A working access token (one refresh at a time). */
  accessToken(): Promise<string> {
    if (this.current && this.current.expiresAt - EARLY_MS > this.now())
      return Promise.resolve(this.current.accessToken);
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  /** Google refused the token (`401`): the next request refreshes it. */
  invalidate(token: string) {
    if (this.current?.accessToken === token) this.current = null;
  }

  private async refresh(): Promise<string> {
    const config = this.options.config();
    if (!config) throw new GoogleAuthError('no_client', 'Set up the Google client in Settings.');
    const body = await postForm(
      this.options.endpoints.token,
      {
        grant_type: 'refresh_token',
        refresh_token: this.options.refreshToken,
        client_id: config.clientId,
        ...(config.clientSecret && { client_secret: config.clientSecret }),
      },
      this.fetch,
    );
    this.current = tokensFrom(body, this.now());
    return this.current.accessToken;
  }
}

/** Tell Google to forget a refresh token (best effort: offline, it lapses unused). */
export async function revoke(
  endpoints: GoogleEndpoints,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await postForm(endpoints.revoke, { token: refreshToken }, fetchImpl).catch(() => {});
}
