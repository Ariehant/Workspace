/** The window's only way to the main process: a small, typed API (no Node, no tokens). */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AppState,
  type CalendarDraft,
  type CalendarPatch,
  type ConnectSession,
  type DatabaseChoice,
  type Result,
  type SchemaChoice,
  type Settings,
} from '../shared/ipc';
import type { CalEvent, Calendar } from '../shared/types';

const call = <T>(channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>;

const api = {
  state: () => call<AppState>(IPC.state),
  events: (from: string, to: string) => call<CalEvent[]>(IPC.events, from, to),
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
