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
  type GoogleConnect,
  type GoogleSetup,
  type SchemaChoice,
  type Settings,
} from '../shared/ipc';
import { hexColour, type GoogleCalendarEntry } from '../shared/google';
import type { EventTime } from '../shared/dates';
import { DEFAULT_REMINDER, REMINDER_CHOICES } from '../shared/reminders';
import {
  COLOURS,
  isGoogleAccount,
  isIcsAccount,
  isWorkspaceAccount,
  type IcsCalendar,
  type CalEvent,
  type Calendar,
  type EditScope,
  type GoogleAccount,
  type WorkspaceAccount,
  type WorkspaceCalendar,
} from '../shared/types';
import { localZone, wallAt } from '../shared/zones';
import type { Cache } from './cache';
import type { Log } from './log';
import { GoogleClient, GoogleEngine } from './google/client';
import {
  clientFromEnvironment,
  googleEndpoints,
  GoogleTokens,
  revoke,
  signIn,
  type GoogleClientConfig,
  type GoogleEndpoints,
  type TokenSet,
} from './google/oauth';
import { GoogleEditTarget } from './google/edits';
import { GoogleCalendarSync } from './google/sync';
import { feedUrl, IcsCalendarSync, probeFeed } from './ics/sync';
import { Outbox, type EditTarget } from './outbox';
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
  /** Opens Google's sign-in page in the system browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Google's endpoints and client from the environment (tests point them at a fake). */
  env?: NodeJS.ProcessEnv;
  /** This machine's time zone (tests set one). */
  zone?: () => string;
  onChange?: () => void;
  log?: Log;
}

/** A Google sign-in waiting for its calendars to be chosen. */
interface GoogleSession {
  email: string;
  refreshToken: string;
  tokens: GoogleTokens;
  /** The account it's for, if already added (adding calendars, or signed in again). */
  accountId: string | null;
  entries: GoogleCalendarEntry[];
}

const GOOGLE_CLIENT = 'google.client';
const ZONE = 'zone';

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
  readonly outbox: Outbox;
  private readonly engines = new Map<string, WorkspaceEngine>();
  private readonly sessions = new Map<string, Session>();
  private readonly googleSyncs = new Map<
    string,
    { sync: GoogleCalendarSync; edits: GoogleEditTarget }
  >();
  private readonly googleSessions = new Map<string, GoogleSession>();
  private googleSigningIn: AbortController | null = null;
  /** Feeds subscribed to by URL: one reader for them all. */
  private readonly ics: IcsCalendarSync;
  private readonly endpoints: GoogleEndpoints;
  private readonly zone: () => string;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: ServiceOptions) {
    this.cache = options.cache;
    this.endpoints = googleEndpoints(options.env);
    this.zone = options.zone ?? localZone;
    this.ics = new IcsCalendarSync({
      cache: this.cache,
      fetch: options.clientOptions?.fetch,
      zone: this.zone,
    });
    this.relocalize();
    this.sync = new SyncService({
      cache: this.cache,
      engineFor: (account) => this.engineFor(account),
      sourceFor: (account) =>
        isGoogleAccount(account) ? (this.googleFor(account)?.sync ?? null) : this.ics,
      onChange: options.onChange,
      log: options.log,
    });
    this.outbox = new Outbox({
      cache: this.cache,
      engineFor: (calendar) => {
        const account = this.cache.account(calendar.accountId);
        if (!account) return null;
        if (isGoogleAccount(account)) return this.googleFor(account)?.edits ?? null;
        if (!isWorkspaceAccount(account)) return null; // Read-only (ICS).
        const engine = this.engineFor(account);
        return engine && workspaceTarget(engine);
      },
      onChange: options.onChange,
      onDue: (at) => this.scheduleFlush(at),
      onRefused: (calendarId) => {
        options.log?.('warn', `outbox: an edit to calendar ${calendarId} was refused and dropped`);
        // Read it again from the source, so it shows what the source has.
        this.cache.setSyncState(calendarId, { sweptAt: null });
        this.cache.setCursor(calendarId, null);
        void this.sync.syncAll();
      },
      onSeriesChanged: () => void this.sync.syncAll(),
    });
  }

  /** Send waiting edits, then read changes (so a sync reads back what was just sent). */
  async syncNow(full = false) {
    await this.outbox.flush();
    await this.sync.syncAll({ full });
  }

  private scheduleFlush(at: number | null) {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (at === null) return;
    this.flushTimer = setTimeout(() => void this.outbox.flush(), Math.max(0, at - Date.now()) + 50);
    this.flushTimer.unref?.();
  }

  stop() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private client(server: string, token: string) {
    return new WorkspaceClient({ ...this.options.clientOptions, server, token });
  }

  /** One source (and so one rate limiter) per account. */
  engineFor(account: WorkspaceAccount): WorkspaceEngine | null {
    const cached = this.engines.get(account.id);
    if (cached) return cached;
    const sealed = this.cache.sealedToken(account.id);
    const token = sealed && this.options.unseal(sealed);
    if (!token) return null;
    const engine = new WorkspaceEngine(this.client(account.server, token));
    this.engines.set(account.id, engine);
    return engine;
  }

  /**
   * After the time zone changed (since the last run, or while running): events at real instants
   * show at the new clock times. Google's are also worked out again at the next sync.
   */
  relocalize() {
    const zone = this.zone();
    if (this.cache.setting<string | null>(ZONE, null) === zone) return;
    this.cache.relocalize((instant) => wallAt(instant, zone));
    this.cache.setSetting(ZONE, zone);
    this.options.onChange?.();
  }

  // --- Google --------------------------------------------------------------------------

  private googleConfig(): GoogleClientConfig | null {
    const fromEnv = clientFromEnvironment(this.options.env);
    if (fromEnv) return fromEnv;
    const saved = this.cache.setting<Partial<GoogleClientConfig> | null>(GOOGLE_CLIENT, null);
    return saved?.clientId
      ? { clientId: saved.clientId, clientSecret: saved.clientSecret ?? '' }
      : null;
  }

  googleSetup(): GoogleSetup {
    const config = this.googleConfig();
    return {
      configured: !!config,
      fromEnvironment: !!clientFromEnvironment(this.options.env),
      clientId: config?.clientId ?? '',
      hasSecret: !!config?.clientSecret,
    };
  }

  /** Save the OAuth client; an empty secret keeps the one saved (it isn't shown again). */
  setGoogleClient(clientId: string, clientSecret: string): GoogleSetup {
    if (clientFromEnvironment(this.options.env))
      throw new Error('This build brings its own Google client.');
    const id = clientId.trim();
    if (!/^[\w.-]+$/.test(id)) throw new Error('Enter the OAuth client ID.');
    const before = this.cache.setting<Partial<GoogleClientConfig> | null>(GOOGLE_CLIENT, null);
    this.cache.setSetting(GOOGLE_CLIENT, {
      clientId: id,
      clientSecret:
        clientSecret.trim() || (before?.clientId === id ? before.clientSecret : '') || '',
    });
    this.options.onChange?.();
    return this.googleSetup();
  }

  private googleTokens(refreshToken: string, initial: TokenSet | null = null) {
    return new GoogleTokens({
      config: () => this.googleConfig(),
      endpoints: this.endpoints,
      refreshToken,
      initial,
      fetch: this.options.clientOptions?.fetch,
    });
  }

  private googleEngine(tokens: GoogleTokens) {
    return new GoogleEngine(
      new GoogleClient({
        tokens,
        base: this.endpoints.api,
        fetch: this.options.clientOptions?.fetch,
        sleep: this.options.clientOptions?.sleep,
      }),
    );
  }

  /**
   * One sync and edit target (sharing one token) per Google account; null if its sign-in can't
   * be read.
   */
  googleFor(account: GoogleAccount): { sync: GoogleCalendarSync; edits: GoogleEditTarget } | null {
    const cached = this.googleSyncs.get(account.id);
    if (cached) return cached;
    const sealed = this.cache.sealedToken(account.id);
    const refreshToken = sealed && this.options.unseal(sealed);
    if (!refreshToken) return null;
    const engine = this.googleEngine(this.googleTokens(refreshToken));
    const source = {
      sync: new GoogleCalendarSync({ cache: this.cache, engine, zone: this.zone }),
      edits: new GoogleEditTarget(engine, this.zone),
    };
    this.googleSyncs.set(account.id, source);
    return source;
  }

  private startGoogleSession(session: GoogleSession): GoogleConnect {
    const sessionId = randomUUID();
    this.googleSessions.set(sessionId, session);
    const added = new Set(
      this.cache
        .calendars()
        .filter((c) => c.kind === 'google' && c.accountId === session.accountId)
        .map((c) => (c.kind === 'google' ? c.googleId : '')),
    );
    return {
      sessionId,
      email: session.email,
      calendars: session.entries
        .map((e) => ({
          googleId: e.id,
          name: e.summaryOverride || e.summary || e.id,
          colour: hexColour(e.backgroundColor),
          accessRole: e.accessRole ?? 'reader',
          primary: !!e.primary,
          added: added.has(e.id),
        }))
        // The account's own calendar first, then as Google lists them.
        .sort((a, b) => Number(b.primary) - Number(a.primary)),
    };
  }

  /** Sign in with Google in the browser, then list the account's calendars. */
  async googleSignIn(): Promise<GoogleConnect> {
    const config = this.googleConfig();
    if (!config) throw new Error('Set up the Google client in Settings first.');
    this.googleSigningIn?.abort();
    const controller = new AbortController();
    this.googleSigningIn = controller;
    try {
      const signedIn = await signIn({
        config,
        endpoints: this.endpoints,
        open: this.options.openBrowser ?? (() => Promise.reject(new Error('No browser.'))),
        fetch: this.options.clientOptions?.fetch,
        signal: controller.signal,
      });
      const tokens = this.googleTokens(signedIn.refreshToken, signedIn);
      const entries = await this.googleEngine(tokens).calendars();
      const email = signedIn.email ?? entries.find((e) => e.primary)?.id ?? 'Google';
      const existing = this.cache
        .accounts()
        .find((a): a is GoogleAccount => isGoogleAccount(a) && a.email === email);
      return this.startGoogleSession({
        email,
        refreshToken: signedIn.refreshToken,
        tokens,
        accountId: existing?.id ?? null,
        entries,
      });
    } finally {
      if (this.googleSigningIn === controller) this.googleSigningIn = null;
    }
  }

  cancelGoogle(sessionId?: string) {
    if (sessionId) this.googleSessions.delete(sessionId);
    else this.googleSigningIn?.abort();
  }

  /** An added Google account's calendars, to add more of them. */
  async googleAccount(accountId: string): Promise<GoogleConnect> {
    const account = this.cache.account(accountId);
    if (!account || !isGoogleAccount(account)) throw new Error('That account is gone.');
    const sealed = this.cache.sealedToken(accountId);
    const refreshToken = sealed && this.options.unseal(sealed);
    if (!refreshToken) throw new Error("This account's sign-in can't be read. Sign in again.");
    const tokens = this.googleTokens(refreshToken);
    const entries = await this.googleEngine(tokens).calendars();
    return this.startGoogleSession({
      email: account.email,
      refreshToken,
      tokens,
      accountId,
      entries,
    });
  }

  /** Save the account (new, or signed in again) and the chosen calendars, then sync. */
  async googleSave(sessionId: string, googleIds: string[]): Promise<void> {
    const session = this.googleSessions.get(sessionId);
    if (!session) throw new Error('This setup has ended. Start again.');
    const chosen = session.entries.filter((e) => googleIds.includes(e.id));
    let accountId = session.accountId;
    this.cache.transaction(() => {
      if (!accountId) {
        accountId = randomUUID();
        this.cache.addAccount(
          { id: accountId, kind: 'google', name: session.email, email: session.email, error: null },
          this.options.seal(session.refreshToken),
        );
      } else {
        // Signed in again: the new refresh token, and no error.
        this.cache.setSealedToken(accountId, this.options.seal(session.refreshToken));
        const account = this.cache.account(accountId);
        if (account) this.cache.updateAccount({ ...account, error: null });
        this.googleSyncs.delete(accountId);
      }
      const have = new Set(
        this.cache
          .calendars()
          .filter((c) => c.accountId === accountId)
          .map((c) => (c.kind === 'google' ? c.googleId : '')),
      );
      for (const entry of chosen) {
        if (have.has(entry.id)) continue;
        this.cache.addCalendar({
          id: randomUUID(),
          kind: 'google',
          accountId: accountId!,
          googleId: entry.id,
          accessRole: entry.accessRole ?? 'reader',
          timeZone: entry.timeZone ?? this.zone(),
          name: entry.summaryOverride || entry.summary || entry.id,
          colour: hexColour(entry.backgroundColor) ?? 'blue',
          visible: true,
          reminder: DEFAULT_REMINDER,
          status: 'ok',
          statusMessage: null,
        });
      }
    });
    this.googleSessions.delete(sessionId);
    this.options.onChange?.();
    await this.sync.syncAll();
  }

  // --- Subscriptions (ICS) ------------------------------------------------------------

  /**
   * Subscribe to an iCalendar feed: it's read once (to check it's a calendar, and for its name
   * and zone), then added under the Subscriptions account, and synced.
   */
  async subscribe(input: string, name?: string): Promise<Calendar> {
    let url: string;
    try {
      url = feedUrl(input);
    } catch (error) {
      throw new Error(
        error instanceof TypeError ? "That isn't a web address." : (error as Error).message,
        { cause: error },
      );
    }
    if (this.cache.calendars().some((c) => c.kind === 'ics' && c.url === url))
      throw new Error("You're already subscribed to this feed.");
    const feed = await probeFeed(url, this.options.clientOptions?.fetch);
    const calendar = this.cache.transaction(() => {
      let account = this.cache.accounts().find(isIcsAccount);
      if (!account) {
        account = { id: randomUUID(), kind: 'ics', name: 'Subscriptions', error: null };
        this.cache.addAccount(account, this.options.seal(''));
      }
      const used = this.cache.calendars().length;
      const added: IcsCalendar = {
        id: randomUUID(),
        kind: 'ics',
        accountId: account.id,
        url,
        accessRole: 'reader',
        timeZone: feed.timeZone ?? this.zone(),
        name: name?.trim() || feed.name || new URL(url).host,
        colour: COLOURS[used % COLOURS.length]!,
        visible: true,
        // Feeds are often holidays or schedules: no reminders unless asked for.
        reminder: null,
        status: 'ok',
        statusMessage: null,
      };
      this.cache.addCalendar(added);
      return added;
    });
    this.options.onChange?.();
    await this.sync.syncAll();
    return this.cache.calendar(calendar.id) ?? calendar;
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
      status: {
        ...this.sync.status,
        pending: this.outbox.status().pending,
        editError: this.outbox.error,
      },
      settings: this.settings(),
      secureStorage: this.options.secureStorage(),
      google: this.googleSetup(),
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

  /** Events whose title has `query` (case-insensitive), in visible calendars, soonest first. */
  search(query: string): CalEvent[] {
    const visible = new Set(
      this.cache
        .calendars()
        .filter((c) => c.visible)
        .map((c) => c.id),
    );
    return this.cache.search(query).filter((e) => visible.has(e.calendarId));
  }

  event(id: string): CalEvent | null {
    return this.cache.event(id);
  }

  // --- Editing -------------------------------------------------------------------------

  createEvent(calendarId: string, title: string, time: EventTime): CalEvent {
    return this.outbox.create(calendarId, title, time);
  }

  updateEvent(
    eventId: string,
    change: { title?: string; time?: EventTime },
    scope?: EditScope,
  ): CalEvent {
    return this.outbox.update(eventId, change, scope);
  }

  deleteEvent(eventId: string, scope?: EditScope) {
    this.outbox.remove(eventId, scope);
  }

  undoDelete(eventId: string): CalEvent | null {
    return this.outbox.undoRemove(eventId);
  }

  dismissConflict(eventId: string) {
    this.outbox.dismissConflict(eventId);
  }

  /** Whether a link is a page on one of the connected servers (the only links opened). */
  isAccountLink(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const accounts = this.cache.accounts();
    if (
      parsed.protocol === 'https:' &&
      accounts.some(isGoogleAccount) &&
      GOOGLE_LINK_ORIGINS.includes(parsed.origin)
    )
      return true;
    return accounts.some((a) => {
      if (!isWorkspaceAccount(a)) return false;
      const server = new URL(a.server);
      return parsed.origin === server.origin && parsed.pathname.startsWith(server.pathname);
    });
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
    if (!isWorkspaceAccount(account)) throw new Error('This account adds calendars another way.');
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
          .find(
            (a) =>
              isWorkspaceAccount(a) && a.server === session.server && a.botId === session.botId,
          );
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
          reminder: isReminder(draft.reminder) ? draft.reminder : DEFAULT_REMINDER,
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
        (COLOURS.includes(patch.colour as never) || hexColour(patch.colour)) && {
          colour: hexColour(patch.colour) ?? patch.colour,
        }),
      ...(patch.visible !== undefined && { visible: !!patch.visible }),
      ...(patch.reminder !== undefined &&
        isReminder(patch.reminder) && { reminder: patch.reminder }),
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
    const account = this.cache.account(id);
    const sealed = account && isGoogleAccount(account) ? this.cache.sealedToken(id) : null;
    this.cache.removeAccount(id);
    this.engines.delete(id);
    this.googleSyncs.delete(id);
    this.options.onChange?.();
    // Tell Google to forget the sign-in (best effort).
    const refreshToken = sealed && this.options.unseal(sealed);
    if (refreshToken) void revoke(this.endpoints, refreshToken, this.options.clientOptions?.fetch);
  }
}

const isReminder = (v: unknown): v is number | null =>
  (REMINDER_CHOICES as readonly unknown[]).includes(v);

/** Links opened for Google accounts: events in Google Calendar, and Meet calls. */
const GOOGLE_LINK_ORIGINS = [
  'https://www.google.com',
  'https://calendar.google.com',
  'https://meet.google.com',
];

/** The outbox's edits, sent to a Workspace server. */
const workspaceTarget = (engine: WorkspaceEngine): EditTarget => ({
  create: (calendar, title, time) => engine.create(calendar as WorkspaceCalendar, title, time),
  update: (calendar, sourceId, change) =>
    engine.update(calendar as WorkspaceCalendar, sourceId, change),
  trash: (_calendar, sourceId) => engine.trash(sourceId),
  // (Workspace has no recurring rows: the context isn't needed.)
});
