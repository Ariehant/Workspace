/**
 * Sync with a server (Phase 4): the account, the chosen workspace, and a `SyncClient`
 * that replicates the local database's docs through `/api/sync/<workspace>`.
 *
 * Local changes are queued in the database's outbox by the DocManager (in the same
 * transaction as the change), so nothing is lost if the app quits offline; the
 * server's changes go through the DocManager too, so windows, search and history see
 * them like any other change. Attachments upload in the background and download when
 * a page shows one this device doesn't have.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { parseNotification, type NotificationData } from '@workspace/core';
import {
  LocalSyncStore,
  SYNC_ACCESS,
  SYNC_CURSOR,
  SYNC_ORIGIN,
  type DocManager,
  type FileStore,
  type SqliteStore,
} from '@workspace/storage-local';
import { SyncClient, type SyncStatus } from '@workspace/sync';
import { safeStorage } from 'electron';
import WebSocket from 'ws';
import type {
  Result,
  SyncEnable,
  SyncInfo,
  SyncServerInfo,
  SyncScope,
  SyncSignIn,
  TeamRequest,
} from '../../shared/ipc';
import { ApiError, ServerApi, normalizeServerUrl, type Account } from './api';
import { signInWithBrowser } from './oidc';

const CONFIG = 'sync.config';
const ACCOUNT = 'sync.account';
const TOKEN = 'sync.token';

interface SyncConfig {
  workspaceId: string;
  workspaceName: string;
  /** Identifies this database to the server (its updates aren't sent back to it). */
  deviceId: string;
}

interface StoredAccount extends Account {
  server: string;
}

type StoredToken = { enc: 'os' | 'plain'; value: string };

/** Settings carried into a fresh database when this device takes the server's workspace. */
export type CarrySettings = Record<string, unknown>;

export interface SyncDeps {
  store: SqliteStore;
  manager: DocManager;
  files: FileStore;
  broadcast: (info: SyncInfo) => void;
  openExternal: (url: string) => Promise<void>;
  /** Start over with an empty database holding these settings (then restart). */
  replaceWorkspace: (settings: CarrySettings) => void;
}

const message = (error: unknown) =>
  error instanceof ApiError || error instanceof Error ? error.message : String(error);

const deviceName = () => {
  try {
    return hostname().slice(0, 100);
  } catch {
    return 'Desktop';
  }
};

/** No word from the server for this long (it pings every 30 s): the link is dead. */
const SILENCE_MS = 75_000;
const FILE_RETRY_MS = 60_000;
/** Waits between asking for an attachment the server doesn't have yet (~30 s in all). */
const FILE_WAITS_MS = [500, 1000, 2000, 4000, 8000, 15000];

export class SyncService {
  private client: SyncClient | null = null;
  /** Docs the windows show (presence), kept across reconnects and new clients. */
  private readonly presenceDocs = new Set<string>();
  /** Where others' presence goes (the windows); see `presence.ts`. */
  readonly presence: {
    onAwareness?: (docId: string, update: Uint8Array) => void;
    onRejoin?: () => void;
  } = {};
  /** Where the server's notifications go (the windows and the system); see `notifications.ts`. */
  onNotification?: (notification: NotificationData) => void;
  /** The time zone was sent this run (the server computes reminders in it). */
  private zoneSent = false;
  private api: ServerApi | null = null;
  private socket: WebSocket | null = null;
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private status: SyncStatus = { state: 'stopped' };
  private lastSyncedAt: number | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private uploading = false;
  private fileTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly downloads = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: SyncDeps) {
    deps.manager.onUpdate((_docId, _update, origin) => {
      if (origin === SYNC_ORIGIN || !this.client) return;
      this.client.flush();
      this.emitSoon();
    });
  }

  // --- Stored state ------------------------------------------------------------------

  private get config(): SyncConfig | null {
    return this.deps.store.getSetting<SyncConfig>(CONFIG) ?? null;
  }

  private get account(): StoredAccount | null {
    return this.deps.store.getSetting<StoredAccount>(ACCOUNT) ?? null;
  }

  private get token(): string | null {
    const stored = this.deps.store.getSetting<StoredToken>(TOKEN);
    if (!stored) return null;
    if (stored.enc === 'plain') return stored.value;
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
    } catch {
      // The keyring changed (another login, a reinstall): sign in again.
      return null;
    }
  }

  private saveToken(token: string) {
    const value: StoredToken = safeStorage.isEncryptionAvailable()
      ? { enc: 'os', value: safeStorage.encryptString(token).toString('base64') }
      : { enc: 'plain', value: token };
    this.deps.store.setSetting(TOKEN, value);
  }

  private secureStorage(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false;
    // On Linux without a keyring, Electron "encrypts" with a fixed key.
    const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : 'os';
    return backend !== 'basic_text' && backend !== 'unknown';
  }

  // --- The account while syncing ---------------------------------------------------------

  /**
   * Who is using the app while a workspace syncs: the account (its id is the person's id
   * in the workspace's members doc, person properties and "created by").
   */
  syncedUser(): { id: string; name: string } | null {
    const account = this.account;
    return this.config && account ? { id: account.id, name: account.name } : null;
  }

  /** Tell the server where this person is: their reminders fire at 9:00 there. */
  private async sendTimeZone() {
    if (this.zoneSent) return;
    this.zoneSent = true;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const result = await this.team({ method: 'PATCH', path: 'me', body: { timeZone } });
    if ('error' in result) this.zoneSent = false;
  }

  /** A team API call (members, invites, groups, `me`) for the renderer, with our token. */
  async team(request: TeamRequest): Promise<Result<unknown>> {
    const config = this.config;
    const account = this.account;
    const token = this.token;
    if (!config || !account || !token) return { error: 'Sync this workspace with a server first.' };
    const path =
      request.path === 'me' || request.path.startsWith('me/')
        ? `/api/auth/${request.path}`
        : `/api/workspaces/${config.workspaceId}/${request.path}`;
    try {
      const ok = await new ServerApi(account.server, token).call<unknown>(
        request.method,
        path,
        request.body,
      );
      // A new name shows in the sync status (and as this person, see `syncedUser`).
      const user = (ok as { user?: { name?: unknown } } | undefined)?.user;
      if (request.path === 'me' && request.method === 'PATCH' && typeof user?.name === 'string') {
        this.deps.store.setSetting(ACCOUNT, {
          ...account,
          name: user.name,
        } satisfies StoredAccount);
        this.emit();
      }
      return { ok };
    } catch (error) {
      return { error: message(error) };
    }
  }

  // --- Status ------------------------------------------------------------------------

  info(): SyncInfo {
    const { store } = this.deps;
    const config = this.config;
    const account = this.account;
    const s = this.status;
    const state: SyncInfo['state'] = !config ? 'off' : !this.token ? 'unauthorized' : s.state;
    const pending = config ? store.outboxCount() : 0;
    if (state === 'live' && pending === 0) this.lastSyncedAt = Date.now();
    return {
      mode: config && account ? 'on' : account ? 'account' : 'off',
      server: account?.server ?? null,
      account: account ? { email: account.email, name: account.name } : null,
      workspace: config ? { id: config.workspaceId, name: config.workspaceName } : null,
      state,
      reason:
        s.state === 'offline' || s.state === 'unauthorized' || s.state === 'error'
          ? s.reason
          : config && !this.token
            ? 'Sign in again to keep syncing.'
            : null,
      retryAt: s.state === 'offline' ? s.retryAt : null,
      pending,
      files: config ? store.unsyncedFileCount() : 0,
      lastSyncedAt: this.lastSyncedAt,
      secureStorage: this.secureStorage(),
      scopes: config ? (store.getSetting<SyncScope[]>(SYNC_ACCESS) ?? null) : null,
    };
  }

  private emit() {
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.deps.broadcast(this.info());
  }

  /** Coalesce bursts (typing) into one status update. */
  private emitSoon() {
    this.emitTimer ??= setTimeout(() => this.emit(), 300);
  }

  // --- Lifecycle ---------------------------------------------------------------------

  /** At startup: resume syncing if a workspace is set up. */
  start() {
    if (this.config) {
      this.deps.manager.setOutbox(true);
      this.connect();
    }
    this.emit();
  }

  stop() {
    this.client?.stop();
    this.client = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = null;
    this.status = { state: 'stopped' };
  }

  retryNow() {
    this.client?.retryNow();
  }

  private connect() {
    const config = this.config;
    const account = this.account;
    const token = this.token;
    this.stop();
    if (!config || !account || !token) return;
    const api = new ServerApi(account.server, token);
    this.api = api;
    const local = new LocalSyncStore(this.deps.store, this.deps.manager);
    const client = new SyncClient({
      store: {
        cursor: () => local.cursor(),
        pending: (limit) => local.pending(limit),
        acknowledge: (ids) => {
          local.acknowledge(ids);
          // "Syncing N changes" counts down as the server stores them.
          this.emitSoon();
        },
        applyRemote: (items, cursor) => local.applyRemote(items, cursor),
        // Access (Phase 5): refused changes, docs gained and lost, the scopes held.
        denied: (items) => local.denied(items),
        reset: (docId, state) => local.reset(docId, state),
        applyBackfill: (items) => local.applyBackfill(items),
        revoke: (docIds, scopes) => {
          local.revoke(docIds, scopes);
          if (scopes.length > 0) this.emit();
        },
        setAccess: (scopes) => {
          local.setAccess(scopes);
          // The sidebar's sections follow.
          this.emit();
        },
        knownScopes: () => local.knownScopes(),
        scopeOf: (docId) => local.scopeOf(docId),
      },
      deviceId: config.deviceId,
      connect: (handlers) => {
        const ws = new WebSocket(api.syncUrl(config.workspaceId), {
          headers: { authorization: `Bearer ${token}` },
          maxPayload: 512 * 1024 * 1024,
          handshakeTimeout: 15_000,
        });
        ws.binaryType = 'nodebuffer';
        this.socket = ws;
        this.lastHeard = Date.now();
        const heard = () => (this.lastHeard = Date.now());
        ws.on('open', () => {
          heard();
          handlers.onOpen();
        });
        ws.on('ping', heard);
        ws.on('message', (data) => {
          heard();
          handlers.onMessage(data as Buffer);
        });
        ws.on('close', (code, reason) => {
          if (this.socket === ws) this.socket = null;
          handlers.onClose(code, reason.toString());
        });
        ws.on('error', () => {});
        return { send: (data) => ws.send(data), close: () => ws.close() };
      },
      onServerBehind: () => {
        // The server lost data (restored from an older backup): give it all of ours.
        this.deps.manager.queueFullState();
        this.deps.store.clearSyncedFiles();
        this.client?.flush();
      },
      onError: (error) => console.warn('sync:', message(error)),
      // Presence: others on the docs this device's windows show.
      onAwareness: (docId, update) => this.presence.onAwareness?.(docId, update),
      onPresenceRejoin: () => this.presence.onRejoin?.(),
      onNotify: (payload) => {
        const notification = parseNotification(payload);
        if (notification) this.onNotification?.(notification);
      },
    });
    for (const docId of this.presenceDocs) client.presence.watch(docId);
    client.onStatus((status) => {
      this.status = status;
      if (status.state === 'live') {
        void this.uploadFiles();
        void this.sendTimeZone();
      }
      this.emit();
    });
    this.client = client;
    client.start();
    // A laptop that slept or a dead NAT entry: the socket looks open but nothing arrives.
    this.watchdog = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN && Date.now() - this.lastHeard > SILENCE_MS) {
        this.socket.terminate();
      }
    }, 15_000);
  }

  // --- Presence ----------------------------------------------------------------------

  watchPresence(docId: string): void {
    this.presenceDocs.add(docId);
    this.client?.presence.watch(docId);
  }

  unwatchPresence(docId: string): void {
    this.presenceDocs.delete(docId);
    this.client?.presence.unwatch(docId);
  }

  sendPresence(docId: string, update: Uint8Array): void {
    this.client?.presence.awareness(docId, update);
  }

  // --- Setup flows (from Settings → Sync) ----------------------------------------------

  async serverInfo(input: string): Promise<Result<SyncServerInfo>> {
    try {
      const server = normalizeServerUrl(input);
      const info = await new ServerApi(server).info();
      return { ok: { server, ...info } };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async signIn(request: SyncSignIn): Promise<Result> {
    try {
      const server = normalizeServerUrl(request.server);
      const api = new ServerApi(server);
      const device = deviceName();
      const { user, token } =
        request.kind === 'password'
          ? await api.login(request.email, request.password, device)
          : request.kind === 'signup'
            ? await api.signup(
                {
                  email: request.email,
                  name: request.name,
                  password: request.password,
                  invite: request.invite || undefined,
                },
                device,
              )
            : await signInWithBrowser(
                api,
                request.provider,
                device,
                this.deps.openExternal,
                request.invite,
              );
      const previous = this.account;
      // Another server (or another account) means another workspace: start over.
      if (this.config && (previous?.server !== server || previous?.id !== user.id)) {
        this.forgetWorkspace();
      }
      this.deps.store.setSetting(ACCOUNT, { ...user, server } satisfies StoredAccount);
      this.saveToken(token);
      if (this.config) this.connect();
      this.emit();
      return { ok: true };
    } catch (error) {
      return { error: message(error) };
    }
  }

  async workspaces(): Promise<Result<{ id: string; name: string; role: string }[]>> {
    const account = this.account;
    const token = this.token;
    if (!account || !token) return { error: 'Sign in first.' };
    try {
      return { ok: await new ServerApi(account.server, token).workspaces() };
    } catch (error) {
      return { error: message(error) };
    }
  }

  /**
   * Start syncing: upload this workspace to a new server workspace, merge it into an
   * existing one, or replace it with an existing one (this device's data is set aside).
   */
  async enable(request: SyncEnable): Promise<Result> {
    const account = this.account;
    const token = this.token;
    if (!account || !token) return { error: 'Sign in first.' };
    const api = new ServerApi(account.server, token);
    try {
      let workspace: { id: string; name: string };
      if (request.mode === 'upload') {
        workspace = await api.createWorkspace(request.name.trim() || 'Workspace');
      } else {
        const found = (await api.workspaces()).find((w) => w.id === request.workspaceId);
        if (!found) return { error: 'That workspace isn’t available to this account.' };
        workspace = found;
      }
      const config: SyncConfig = {
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        deviceId: randomUUID(),
      };
      if (request.mode === 'replace') {
        this.stop();
        const { store } = this.deps;
        this.deps.replaceWorkspace({
          [CONFIG]: config,
          [ACCOUNT]: store.getSetting(ACCOUNT),
          [TOKEN]: store.getSetting(TOKEN),
          'ui.theme': store.getSetting('ui.theme') ?? null,
          'window.bounds': store.getSetting('window.bounds') ?? null,
          // The server's pages arrive by sync: no "Getting started" page.
          'app.onboarded': true,
        });
        return { ok: true };
      }
      const { store, manager } = this.deps;
      store.outboxClear();
      store.clearSyncedFiles();
      store.setSetting(SYNC_CURSOR, 0);
      store.setSetting(CONFIG, config);
      manager.setOutbox(true);
      // Everything this device has goes up (merging with what the server has).
      manager.queueFullState();
      this.connect();
      this.emit();
      return { ok: true };
    } catch (error) {
      return { error: message(error) };
    }
  }

  /** Stop syncing and sign out; the pages stay on this device. */
  async disable(): Promise<Result> {
    const account = this.account;
    const token = this.token;
    this.stop();
    this.forgetWorkspace();
    if (account && token) {
      // End the session on the server too (best effort: we may be offline).
      await new ServerApi(account.server, token).logout().catch(() => {});
    }
    this.deps.store.deleteSetting(ACCOUNT);
    this.deps.store.deleteSetting(TOKEN);
    this.emit();
    return { ok: true };
  }

  private forgetWorkspace() {
    const { store, manager } = this.deps;
    this.stop();
    manager.setOutbox(false);
    store.outboxClear();
    store.clearSyncedFiles();
    store.deleteSetting(CONFIG);
    store.deleteSetting(SYNC_CURSOR);
  }

  // --- Attachments ---------------------------------------------------------------------

  /** A new attachment was stored: upload it when connected. */
  fileAdded() {
    if (this.status.state === 'live') void this.uploadFiles();
    this.emitSoon();
  }

  private async uploadFiles(): Promise<void> {
    const config = this.config;
    const api = this.api;
    if (this.uploading || !config || !api) return;
    this.uploading = true;
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = null;
    try {
      for (const file of this.deps.store.unsyncedFiles()) {
        const path = this.deps.files.resolve(file.id);
        if (!path) continue;
        try {
          if (!(await api.hasFile(config.workspaceId, file.id))) {
            await api.putFile(config.workspaceId, file, path);
          }
        } catch (error) {
          // Too large for this server: it never will be; don't retry forever.
          if (!(error instanceof ApiError && error.status === 413)) throw error;
          console.warn(`sync: ${file.name} is too large for the server`);
        }
        this.deps.store.markFileSynced(file.id);
        this.emitSoon();
      }
    } catch (error) {
      console.warn('sync: file upload paused:', message(error));
      this.fileTimer = setTimeout(() => void this.uploadFiles(), FILE_RETRY_MS);
    } finally {
      this.uploading = false;
    }
  }

  /** Fetch an attachment this device doesn't have (made on another device). */
  fetchFile(id: string): Promise<boolean> {
    const config = this.config;
    const api = this.api;
    if (!config || !api) return Promise.resolve(false);
    let pending = this.downloads.get(id);
    if (!pending) {
      pending = (async () => {
        // A page can arrive before its attachment does (the other device uploads it
        // right after the edit): give the upload a little while.
        for (const wait of FILE_WAITS_MS) {
          const file = await api.getFile(config.workspaceId, id);
          if (file) {
            const ok = this.deps.files.importAs(id, file.bytes, file.name, file.mime);
            if (ok) this.deps.store.markFileSynced(id);
            return ok;
          }
          await new Promise((resolve) => setTimeout(resolve, wait));
        }
        return false;
      })()
        .catch(() => false)
        .finally(() => this.downloads.delete(id));
      this.downloads.set(id, pending);
    }
    return pending;
  }
}
