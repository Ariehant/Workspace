/**
 * The app's main-process state, apart from Electron: the cache, one source per account, the
 * sync service, and connections being set up. IPC handlers (`ipc.ts`) call into this.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type AppState,
  type CalendarDraft,
  type CalendarPatch,
  type ConnectSession,
  type DatabaseChoice,
  type SchemaChoice,
  type Settings,
} from '../shared/ipc';
import { COLOURS, type Account, type CalEvent, type Calendar } from '../shared/types';
import type { Cache } from './cache';
import { SyncService } from './sync';
import { normaliseServer, WorkspaceClient, type ClientOptions } from './workspace/client';
import { WorkspaceEngine, type Person, type ViewInfo } from './workspace/engine';

export interface ServiceOptions {
  cache: Cache;
  seal: (token: string) => string;
  unseal: (sealed: string) => string | null;
  secureStorage: () => boolean;
  /** For tests: how clients are made (a fake fetch, limits). */
  clientOptions?: Partial<ClientOptions>;
  onChange?: () => void;
}

interface Session {
  engine: WorkspaceEngine;
  server: string;
  token: string | null;
  botId: string;
  botName: string;
  workspaceName: string;
  accountId: string | null;
}

export class CalendarService {
  readonly cache: Cache;
  readonly sync: SyncService;
  private readonly engines = new Map<string, WorkspaceEngine>();
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: ServiceOptions) {
    this.cache = options.cache;
    this.sync = new SyncService({
      cache: this.cache,
      engineFor: (account) => this.engineFor(account),
      onChange: options.onChange,
    });
  }

  private client(server: string, token: string) {
    return new WorkspaceClient({ ...this.options.clientOptions, server, token });
  }

  /** One source (and so one rate limiter) per account. */
  engineFor(account: Account): WorkspaceEngine | null {
    const cached = this.engines.get(account.id);
    if (cached) return cached;
    const sealed = this.cache.sealedToken(account.id);
    const token = sealed && this.options.unseal(sealed);
    if (!token) return null;
    const engine = new WorkspaceEngine(this.client(account.server, token));
    this.engines.set(account.id, engine);
    return engine;
  }

  settings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.cache.setting<Partial<Settings>>('settings', {}) };
  }

  setSettings(patch: Partial<Settings>): Settings {
    const next = { ...this.settings(), ...patch };
    this.cache.setSetting('settings', next);
    this.options.onChange?.();
    return next;
  }

  state(): AppState {
    return {
      accounts: this.cache.accounts(),
      calendars: this.cache.calendars(),
      status: this.sync.status,
      settings: this.settings(),
      secureStorage: this.options.secureStorage(),
    };
  }

  /** Events touching the days `from`–`to`, in visible calendars. */
  events(from: string, to: string): CalEvent[] {
    const visible = new Set(
      this.cache
        .calendars()
        .filter((c) => c.visible)
        .map((c) => c.id),
    );
    return this.cache.eventsBetween(from, to).filter((e) => visible.has(e.calendarId));
  }

  // --- Connecting ----------------------------------------------------------------------

  /** Check a server address and token (`/v1/users/me`) and start setting up calendars. */
  async connectNew(serverInput: string, token: string): Promise<ConnectSession> {
    const server = normaliseServer(serverInput);
    const trimmed = token.trim();
    const engine = new WorkspaceEngine(this.client(server, trimmed));
    const me = await engine.connect();
    return this.startSession({
      engine,
      server,
      token: trimmed,
      botId: me.botId,
      botName: me.name,
      workspaceName: me.workspaceName,
      accountId: null,
    });
  }

  /** Add calendars to an account that's already connected. */
  async connectExisting(accountId: string): Promise<ConnectSession> {
    const account = this.cache.account(accountId);
    if (!account) throw new Error('That account is gone.');
    const engine = this.engineFor(account);
    if (!engine) throw new Error("This account's token can't be read. Connect it again.");
    const me = await engine.connect();
    return this.startSession({
      engine,
      server: account.server,
      token: null,
      botId: me.botId,
      botName: me.name,
      workspaceName: me.workspaceName,
      accountId,
    });
  }

  private startSession(session: Session): ConnectSession {
    const sessionId = randomUUID();
    this.sessions.set(sessionId, session);
    return {
      sessionId,
      server: session.server,
      botName: session.botName,
      workspaceName: session.workspaceName,
    };
  }

  private session(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error('This setup has ended. Start again.');
    return session;
  }

  databases(sessionId: string): Promise<DatabaseChoice[]> {
    return this.session(sessionId).engine.listDatabases();
  }

  schema(sessionId: string, databaseId: string): Promise<SchemaChoice> {
    return this.session(sessionId).engine.schema(databaseId);
  }

  views(sessionId: string, databaseId: string): Promise<ViewInfo[]> {
    return this.session(sessionId).engine.calendarViews(databaseId);
  }

  people(sessionId: string): Promise<Person[]> {
    return this.session(sessionId).engine.people();
  }

  cancel(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  /** Save the account (if new) and its new calendars, then sync them. */
  async save(sessionId: string, drafts: CalendarDraft[]): Promise<void> {
    const session = this.session(sessionId);
    if (drafts.length === 0) throw new Error('Choose at least one database.');
    let accountId = session.accountId;
    this.cache.transaction(() => {
      if (!accountId) {
        // The same integration on the same server is one account.
        const existing = this.cache
          .accounts()
          .find((a) => a.server === session.server && a.botId === session.botId);
        if (existing) {
          accountId = existing.id;
        } else {
          accountId = randomUUID();
          const host = new URL(session.server).host;
          this.cache.addAccount(
            {
              id: accountId,
              kind: 'workspace',
              name: session.workspaceName ? `${session.workspaceName} · ${host}` : host,
              server: session.server,
              botId: session.botId,
              error: null,
            },
            this.options.seal(session.token!),
          );
          this.engines.set(accountId, session.engine);
        }
      }
      const used = this.cache.calendars().length;
      drafts.forEach((draft, i) => {
        this.cache.addCalendar({
          ...draft,
          id: randomUUID(),
          accountId: accountId!,
          name: draft.name.trim() || 'Untitled',
          colour: COLOURS.includes(draft.colour as never)
            ? draft.colour
            : COLOURS[(used + i) % COLOURS.length]!,
          visible: true,
          status: 'ok',
          statusMessage: null,
        });
      });
    });
    this.sessions.delete(sessionId);
    this.options.onChange?.();
    await this.sync.syncAll();
  }

  updateCalendar(id: string, patch: CalendarPatch): Calendar {
    const calendar = this.cache.calendar(id);
    if (!calendar) throw new Error('That calendar is gone.');
    const next: Calendar = {
      ...calendar,
      ...(patch.name !== undefined && { name: patch.name.trim() || calendar.name }),
      ...(patch.colour !== undefined &&
        COLOURS.includes(patch.colour as never) && { colour: patch.colour }),
      ...(patch.visible !== undefined && { visible: !!patch.visible }),
    };
    this.cache.updateCalendar(next);
    this.options.onChange?.();
    return next;
  }

  removeCalendar(id: string) {
    this.cache.removeCalendar(id);
    this.options.onChange?.();
  }

  removeAccount(id: string) {
    this.cache.removeAccount(id);
    this.engines.delete(id);
    this.options.onChange?.();
  }
}
