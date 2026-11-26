/** The window's only way to the main process: a small, typed API (no Node, no tokens). */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppState,
  type CalDavConnect,
  type CalendarDraft,
  type CalendarPatch,
  type ConnectSession,
  type DatabaseChoice,
  type GoogleConnect,
  type GoogleSetup,
  type Result,
  type SchemaChoice,
  type Settings,
  type ShowEvent,
} from '../shared/ipc';
import type { EventTime } from '../shared/dates';
import type { CalEvent, Calendar, EditScope } from '../shared/types';

const call = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;

const api = {
  state: () => call<AppState>(IPC.state),
  syncNow: () => call<void>(IPC.syncNow),
  connect: {
    check: (server: string, token: string) => call<ConnectSession>(IPC.connectCheck, server, token),
    account: (accountId: string) => call<ConnectSession>(IPC.connectAccount, accountId),
    databases: (sessionId: string) => call<DatabaseChoice[]>(IPC.connectDatabases, sessionId),
    schema: (sessionId: string, databaseId: string) =>
      call<SchemaChoice>(IPC.connectSchema, sessionId, databaseId),
    views: (sessionId: string, databaseId: string) =>
      call<{ id: string; name: string }[]>(IPC.connectViews, sessionId, databaseId),
    people: (sessionId: string) =>
      call<{ id: string; name: string }[]>(IPC.connectPeople, sessionId),
    save: (sessionId: string, drafts: CalendarDraft[]) =>
      call<void>(IPC.connectSave, sessionId, drafts),
    cancel: (sessionId: string) => call<void>(IPC.connectCancel, sessionId),
  },
  google: {
    setClient: (clientId: string, clientSecret: string) =>
      call<GoogleSetup>(IPC.googleSetClient, clientId, clientSecret),
    /** Stop using the person's own client and go back to the app's. */
    useBuiltIn: () => call<GoogleSetup>(IPC.googleUseBuiltIn),
    signIn: () => call<GoogleConnect>(IPC.googleSignIn),
    account: (accountId: string) => call<GoogleConnect>(IPC.googleAccount, accountId),
    save: (sessionId: string, googleIds: string[]) =>
      call<void>(IPC.googleSave, sessionId, googleIds),
    /** Cancels a sign-in waiting for the browser, or a setup (with its id). */
    cancel: (sessionId?: string) => call<void>(IPC.googleCancel, sessionId ?? null),
  },
  caldav: {
    connect: (server: string, username: string, password: string) =>
      call<CalDavConnect>(IPC.caldavConnect, server, username, password),
    account: (accountId: string) => call<CalDavConnect>(IPC.caldavAccount, accountId),
    save: (sessionId: string, urls: string[]) => call<void>(IPC.caldavSave, sessionId, urls),
    cancel: (sessionId: string) => call<void>(IPC.caldavCancel, sessionId),
  },
  ics: {
    subscribe: (url: string, name?: string) => call<Calendar>(IPC.icsSubscribe, url, name ?? null),
  },
  calendars: {
    update: (id: string, patch: CalendarPatch) => call<Calendar>(IPC.calendarUpdate, id, patch),
    remove: (id: string) => call<void>(IPC.calendarRemove, id),
  },
  accounts: {
    remove: (id: string) => call<void>(IPC.accountRemove, id),
  },
  settings: {
    set: (patch: Partial<Settings>) => call<Settings>(IPC.settingsSet, patch),
  },
  events: {
    range: (from: string, to: string) => call<CalEvent[]>(IPC.events, from, to),
    create: (calendarId: string, title: string, time: EventTime) =>
      call<CalEvent>(IPC.eventCreate, calendarId, title, time),
    update: (id: string, change: { title?: string; time?: EventTime }, scope?: EditScope) =>
      call<CalEvent>(IPC.eventUpdate, id, change, scope ?? null),
    remove: (id: string, scope?: EditScope) => call<void>(IPC.eventDelete, id, scope ?? null),
    undoRemove: (id: string) => call<CalEvent | null>(IPC.eventUndoDelete, id),
    dismissConflict: (id: string) => call<void>(IPC.eventDismissConflict, id),
    search: (query: string) => call<CalEvent[]>(IPC.search, query),
    get: (id: string) => call<CalEvent | null>(IPC.eventGet, id),
    snooze: (id: string) => call<void>(IPC.snooze, id),
  },
  openLink: (url: string) => call<void>(IPC.openLink, url),
  /** The main process asks to show an event (a notification or the tray was clicked). */
  onShowEvent: (listener: (show: ShowEvent) => void) => {
    const handler = (_e: unknown, show: ShowEvent) => listener(show);
    ipcRenderer.on(IPC.showEvent, handler);
    return () => {
      ipcRenderer.off(IPC.showEvent, handler);
    };
  },
  /** Something shown changed; returns a function that stops listening. */
  onChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on(IPC.changed, handler);
    return () => {
      ipcRenderer.off(IPC.changed, handler);
    };
  },
};

export type CalendarApi = typeof api;

contextBridge.exposeInMainWorld('calendar', api);
