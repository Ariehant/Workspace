/**
 * Google Drive (Phase 8 N9): pages point at Drive files picked with Google's Picker.
 *
 * - **Signing in** is an installed app's: the system browser asks the person, and Google sends
 *   the answer back to a server on 127.0.0.1 for that moment (authorization code with PKCE).
 *   The refresh token is kept encrypted by the OS where it can be, by the main process alone.
 * - **The Picker** is Google's script, so it runs in a window of its own (no preload, its own
 *   session), on a page served from 127.0.0.1 for one pick; the page posts back the ids.
 * - The app asks only for `drive.file`: Drive lets it see the files picked, nothing else.
 *
 * The OAuth client (and the Picker's API key and app id) is the owner's own Google Cloud
 * project: set in Settings → Connections, or by environment for a build that brings one.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DRIVE_FIELDS,
  driveFileFromApi,
  driveOpenUrl,
  emailFromIdToken,
  googleAuthUrl,
  isDriveFileId,
  type DriveFileRef,
  type DriveFileStatus,
  type GoogleClientConfig,
  type GoogleState,
} from '@workspace/core';
import type { SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, ipcMain, net, safeStorage, shell } from 'electron';
import { IPC, type Result } from '../shared/ipc';

/** Settings kept here only (not readable or writable through the settings IPC). */
export const GOOGLE_SETTING_PREFIX = 'google.';
const CLIENT = 'google.client';
const ACCOUNT = 'google.account';

const env = process.env;
const ENDPOINTS = {
  auth: env.WORKSPACE_GOOGLE_AUTH_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  token: env.WORKSPACE_GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  revoke: env.WORKSPACE_GOOGLE_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
  api: env.WORKSPACE_GOOGLE_API_URL ?? 'https://www.googleapis.com',
  pickerJs: env.WORKSPACE_GOOGLE_PICKER_JS ?? 'https://apis.google.com/js/api.js',
};
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

type StoredToken = { enc: 'os' | 'plain'; value: string };
interface StoredAccount {
  email: string | null;
  refresh: StoredToken;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');

function fromEnvironment(): GoogleClientConfig | null {
  const { WORKSPACE_GOOGLE_CLIENT_ID: clientId, WORKSPACE_GOOGLE_CLIENT_SECRET: secret } = env;
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: secret ?? '',
    apiKey: env.WORKSPACE_GOOGLE_API_KEY ?? '',
    appId: env.WORKSPACE_GOOGLE_APP_ID ?? '',
  };
}

function cleanConfig(raw: unknown): GoogleClientConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = (v: unknown, max = 512) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const config = {
    clientId: text(r.clientId),
    clientSecret: text(r.clientSecret),
    apiKey: text(r.apiKey),
    appId: text(r.appId, 64),
  };
  return config.clientId ? config : null;
}

/** A small page, sent with no cache and no referrer. */
function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font:16px system-ui;margin:3em;max-width:32em"><h1 style="font-size:20px">${title}</h1><p>${text}</p>`;

/** A server on 127.0.0.1 (any free port) for one exchange. */
async function loopback(handle: (req: IncomingMessage, res: ServerResponse) => void) {
  const server: Server = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > limit) throw new Error('Too large');
  }
  return body;
}

class NotConnected extends Error {}

export class GoogleDrive {
  private access: { token: string; expires: number } | null = null;
  private cancelConnect: (() => void) | null = null;

  constructor(private readonly store: SqliteStore) {}

  // --- Settings --------------------------------------------------------------------------

  private get config(): GoogleClientConfig | null {
    return fromEnvironment() ?? cleanConfig(this.store.getSetting(CLIENT));
  }

  private get account(): StoredAccount | null {
    return this.store.getSetting<StoredAccount>(ACCOUNT) ?? null;
  }

  private refreshToken(): string | null {
    const stored = this.account?.refresh;
    if (!stored) return null;
    if (stored.enc === 'plain') return stored.value;
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
    } catch {
      // The keyring changed: connect again.
      return null;
    }
  }

  private secureStorage(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
    return backend !== 'basic_text' && backend !== 'unknown';
  }

  state(): GoogleState {
    const config = this.config;
    return {
      configured: !!config,
      fromEnvironment: !!fromEnvironment(),
      clientId: config?.clientId ?? '',
      appId: config?.appId ?? '',
      hasSecret: !!config?.clientSecret,
      hasApiKey: !!config?.apiKey,
      email: this.account ? (this.account.email ?? '') : null,
      secure: this.secureStorage(),
    };
  }

  configure(raw: unknown): Result {
    if (fromEnvironment()) return { error: 'This build brings its own Google client.' };
    const next = cleanConfig(raw);
    if (!next) return { error: 'Enter the OAuth client ID.' };
    // An empty secret or key keeps the one saved (they aren't shown again).
    const before = cleanConfig(this.store.getSetting(CLIENT));
    const merged = {
      ...next,
      clientSecret: next.clientSecret || before?.clientSecret || '',
      apiKey: next.apiKey || before?.apiKey || '',
    };
    if (before?.clientId && before.clientId !== merged.clientId) this.forget();
    this.store.setSetting(CLIENT, merged);
    return { ok: true };
  }

  // --- Signing in ------------------------------------------------------------------------

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const reason = typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      throw Object.assign(new Error(reason), { code: reason });
    }
    return body;
  }

  /** Ask in the browser, then keep the refresh token. */
  async connect(): Promise<Result<{ email: string | null }>> {
    const config = this.config;
    if (!config) return { error: 'Set up the Google client first.' };
    this.cancelConnect?.();
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    let settle!: (result: { code: string } | { error: string }) => void;
    const answered = new Promise<{ code: string } | { error: string }>((r) => (settle = r));
    const { server, origin } = await loopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth') return send(res, 404, 'text/plain', 'Not found');
      if (url.searchParams.get('state') !== state) {
        return send(res, 400, 'text/html', page('Workspace', 'This sign-in link is out of date.'));
      }
      const code = url.searchParams.get('code');
      if (code) {
        send(
          res,
          200,
          'text/html',
          page('Connected', 'You can close this tab and go back to Workspace.'),
        );
        settle({ code });
      } else {
        const error = url.searchParams.get('error') ?? 'cancelled';
        send(
          res,
          200,
          'text/html',
          page('Not connected', 'Google Drive wasn’t connected. You can close this tab.'),
        );
        settle({ error: error === 'access_denied' ? 'Access wasn’t allowed.' : error });
      }
    });
    const timer = setTimeout(
      () => settle({ error: 'No answer from the browser.' }),
      CONNECT_TIMEOUT_MS,
    );
    this.cancelConnect = () => settle({ error: 'Cancelled.' });
    try {
      const redirectUri = `${origin}/oauth`;
      await shell.openExternal(
        googleAuthUrl({
          authUrl: ENDPOINTS.auth,
          clientId: config.clientId,
          redirectUri,
          state,
          codeChallenge: base64url(createHash('sha256').update(verifier).digest()),
        }),
      );
      const answer = await answered;
      if ('error' in answer) return { error: answer.error };
      const tokens = await this.post(ENDPOINTS.token, {
        grant_type: 'authorization_code',
        code: answer.code,
        client_id: config.clientId,
        ...(config.clientSecret && { client_secret: config.clientSecret }),
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const refresh = tokens.refresh_token;
      if (typeof refresh !== 'string') return { error: 'Google sent no refresh token.' };
      const email = emailFromIdToken(tokens.id_token);
      const stored: StoredToken = safeStorage.isEncryptionAvailable()
        ? { enc: 'os', value: safeStorage.encryptString(refresh).toString('base64') }
        : { enc: 'plain', value: refresh };
      this.store.setSetting(ACCOUNT, { email, refresh: stored } satisfies StoredAccount);
      this.keep(tokens);
      return { ok: { email } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Couldn’t connect.' };
    } finally {
      clearTimeout(timer);
      this.cancelConnect = null;
      server.close();
    }
  }

  private keep(tokens: Record<string, unknown>) {
    if (typeof tokens.access_token !== 'string') return;
    const seconds = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
    this.access = { token: tokens.access_token, expires: Date.now() + (seconds - 60) * 1000 };
  }

  private forget() {
    this.access = null;
    this.store.setSetting(ACCOUNT, null);
  }

  async disconnect(): Promise<void> {
    const refresh = this.refreshToken();
    this.forget();
    // Tell Google too (best effort: offline, it lapses unused).
    if (refresh) await this.post(ENDPOINTS.revoke, { token: refresh }).catch(() => {});
  }

  private refreshing: Promise<string> | null = null;

  /** A current access token (one refresh at a time: every card on a page asks at once). */
  private accessToken(): Promise<string> {
    if (this.access && this.access.expires > Date.now()) return Promise.resolve(this.access.token);
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const config = this.config;
    const refresh = this.refreshToken();
    if (!config || !refresh) throw new NotConnected();
    try {
      this.keep(
        await this.post(ENDPOINTS.token, {
          grant_type: 'refresh_token',
          refresh_token: refresh,
          client_id: config.clientId,
          ...(config.clientSecret && { client_secret: config.clientSecret }),
        }),
      );
    } catch (error) {
      // Revoked or expired: connect again.
      if ((error as { code?: string }).code === 'invalid_grant') {
        this.forget();
        throw new NotConnected();
      }
      throw error;
    }
    if (!this.access) throw new NotConnected();
    return this.access.token;
  }

  // --- Drive -----------------------------------------------------------------------------

  private async get(fileId: string, retry = true): Promise<DriveFileStatus> {
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      return error instanceof NotConnected ? { state: 'notConnected' } : { state: 'offline' };
    }
    let response: Response;
    try {
      const url = new URL(`${ENDPOINTS.api}/drive/v3/files/${encodeURIComponent(fileId)}`);
      url.searchParams.set('fields', DRIVE_FIELDS);
      url.searchParams.set('supportsAllDrives', 'true');
      response = await net.fetch(url.href, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { state: 'offline' };
    }
    if (response.status === 401 && retry) {
      this.access = null;
      return this.get(fileId, false);
    }
    if (response.status === 404) return { state: 'gone' };
    if (response.status === 403 || response.status === 401) return { state: 'noAccess' };
    if (!response.ok) return { state: 'offline' };
    const file = driveFileFromApi(await response.json().catch(() => null));
    if (!file) return { state: 'offline' };
    if (file.trashed) return { state: 'gone' };
    const { trashed: _trashed, ...ref } = file;
    return { state: 'found', file: ref };
  }

  status(fileId: unknown): Promise<DriveFileStatus> {
    return isDriveFileId(fileId) ? this.get(fileId) : Promise.resolve({ state: 'gone' });
  }

  async open(fileId: unknown): Promise<boolean> {
    if (!isDriveFileId(fileId)) return false;
    await shell.openExternal(driveOpenUrl(fileId));
    return true;
  }

  /** Google's Picker, in a window of its own; resolves the files picked (none if cancelled). */
  async pick(parent: BrowserWindow | null): Promise<Result<DriveFileRef[]>> {
    const config = this.config;
    let token: string;
    try {
      token = await this.accessToken();
    } catch (error) {
      return {
        error: error instanceof NotConnected ? 'notConnected' : 'Google Drive can’t be reached.',
      };
    }
    if (!config?.apiKey) return { error: 'Set the Picker’s API key in Settings → Connections.' };

    const nonce = base64url(randomBytes(18));
    let settle!: (ids: string[] | { error: string }) => void;
    const picked = new Promise<string[] | { error: string }>((r) => (settle = r));
    const pickerConfig = {
      token,
      apiKey: config.apiKey,
      appId: config.appId,
      pickerJs: ENDPOINTS.pickerJs,
      done: `/picked/${nonce}`,
    };
    const { server, origin } = await loopback((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && path === `/picker/${nonce}`) {
        // The settings as JSON in the page (`<` escaped so it can't end the script).
        const json = JSON.stringify(pickerConfig).replace(/</g, '\\u003c');
        return send(res, 200, 'text/html', pickerPage(json));
      }
      if (req.method === 'POST' && path === `/picked/${nonce}`) {
        void readBody(req)
          .then((body) => {
            const answer = JSON.parse(body) as { picked?: unknown; error?: unknown };
            send(res, 204, 'text/plain', '');
            if (typeof answer.error === 'string') settle({ error: answer.error.slice(0, 200) });
            else settle(Array.isArray(answer.picked) ? answer.picked.filter(isDriveFileId) : []);
          })
          .catch(() => send(res, 400, 'text/plain', 'Bad request'));
        return;
      }
      send(res, 404, 'text/plain', 'Not found');
    });

    const window = new BrowserWindow({
      parent: parent ?? undefined,
      modal: !!parent,
      width: 1051,
      height: 650,
      title: 'Link files from Google Drive',
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // Its own session: nothing of the app's, and gone when the app quits.
        partition: 'google-picker',
      },
    });
    window.on('closed', () => settle([]));
    try {
      await window.loadURL(`${origin}/picker/${nonce}`);
      const answer = await picked;
      if (!Array.isArray(answer)) return { error: answer.error };
      // What Drive says about each (the Picker's own word isn't kept).
      const files: DriveFileRef[] = [];
      for (const id of answer.slice(0, 50)) {
        const status = await this.get(id);
        if (status.state === 'found') files.push(status.file);
      }
      return { ok: files };
    } catch (error) {
      // Closed before it had loaded: cancelled.
      if (window.isDestroyed()) return { ok: [] };
      return { error: error instanceof Error ? error.message : 'The Picker couldn’t open.' };
    } finally {
      if (!window.isDestroyed()) window.close();
      server.close();
    }
  }
}

/** The Picker's page: Google's script, then the picked ids posted back. */
function pickerPage(json: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Link files from Google Drive</title>
<style>body{font:14px system-ui;margin:0;color:#555}p{margin:2em}</style></head>
<body><p id="status">Opening Google Drive…</p><script>
const config = ${json};
const done = (answer) =>
  fetch(config.done, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(answer) });
function show() {
  const p = google.picker;
  const view = new p.DocsView(p.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false);
  const builder = new p.PickerBuilder()
    .addView(view)
    .enableFeature(p.Feature.MULTISELECT_ENABLED)
    .setOAuthToken(config.token)
    .setDeveloperKey(config.apiKey)
    .setOrigin(location.origin)
    .setTitle('Link files from Google Drive')
    .setCallback((data) => {
      const action = data[p.Response.ACTION];
      if (action === p.Action.PICKED) {
        done({ picked: data[p.Response.DOCUMENTS].map((d) => d[p.Document.ID]) });
      } else if (action === p.Action.CANCEL) {
        done({ picked: [] });
      }
    });
  if (config.appId) builder.setAppId(config.appId);
  builder.build().setVisible(true);
  document.getElementById('status').textContent = '';
}
const script = document.createElement('script');
script.src = config.pickerJs;
script.onload = () => gapi.load('picker', { callback: show });
script.onerror = () => done({ error: 'The Google Picker couldn’t load (offline?).' });
document.head.append(script);
</script></body></html>`;
}

/** Handle the Google IPC. Call after ready. */
export function registerGoogle(store: SqliteStore): GoogleDrive {
  const google = new GoogleDrive(store);
  const changed = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.googleChanged);
    }
  };
  ipcMain.handle(IPC.googleState, () => google.state());
  ipcMain.handle(IPC.googleConfigure, (_event, config: unknown) => {
    const result = google.configure(config);
    changed();
    return result;
  });
  ipcMain.handle(IPC.googleConnect, async () => {
    const result = await google.connect();
    changed();
    return result;
  });
  ipcMain.handle(IPC.googleDisconnect, async () => {
    await google.disconnect();
    changed();
  });
  ipcMain.handle(IPC.drivePick, async (event) => {
    const result = await google.pick(BrowserWindow.fromWebContents(event.sender));
    // A pick that found the connection gone (revoked) shows it.
    if ('error' in result && result.error === 'notConnected') changed();
    return result;
  });
  ipcMain.handle(IPC.driveStatus, (_event, fileId: unknown) => google.status(fileId));
  ipcMain.handle(IPC.driveOpen, (_event, fileId: unknown) => google.open(fileId));
  return google;
}
