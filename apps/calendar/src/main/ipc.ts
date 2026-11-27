/**
 * The window's requests, checked and passed to the service. Every handler answers a `Result`,
 * so a failure reaches the window as a message to show (never a token: errors don't carry one).
 */
import { ipcMain, nativeTheme, shell } from 'electron';
import {
  IPC,
  type CalendarDraft,
  type CalendarPatch,
  type Result,
  type Settings,
} from '../shared/ipc';
import { isDay, type EventTime } from '../shared/dates';
import { REMINDER_CHOICES } from '../shared/reminders';
import type { EditScope } from '../shared/types';
import type { CalendarService } from './service';

const isString = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => isString(v, 100) && /^[\w-]+$/.test(v);

async function result<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function check(ok: boolean): asserts ok {
  if (!ok) throw new Error('Invalid request.');
}

const isRef = (v: unknown): v is { id: string; name: string } =>
  !!v &&
  typeof v === 'object' &&
  isString((v as { id: unknown }).id, 200) &&
  isString((v as { name: unknown }).name, 500);

function isDraft(v: unknown): v is CalendarDraft {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    isId(d.databaseId) &&
    (d.viewId === null || isId(d.viewId)) &&
    isString(d.name, 200) &&
    isString(d.colour, 20) &&
    isRef(d.dateProperty) &&
    isRef(d.titleProperty) &&
    (d.people === null ||
      (isRef(d.people) && isId((d.people as unknown as { personId: unknown }).personId))) &&
    (d.colourBy === null || isRef(d.colourBy))
  );
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** A well-formed event time: days for all-day, minutes otherwise, the end not before the start. */
function isEventTime(v: unknown): v is EventTime {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  if (typeof t.allDay !== 'boolean' || typeof t.endSet !== 'boolean') return false;
  if (typeof t.start !== 'string' || typeof t.end !== 'string') return false;
  const shape = t.allDay ? DAY : TIME;
  return shape.test(t.start) && shape.test(t.end) && t.end >= t.start;
}

const isEventId = (v: unknown): v is string => isString(v, 200) && /^[\w-]+:[\w-]+$/.test(v);

const isScope = (v: unknown): v is EditScope | null | undefined =>
  v === undefined || v === null || v === 'this' || v === 'following' || v === 'all';

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function applyTheme(settings: Settings) {
  nativeTheme.themeSource = settings.theme;
}

export interface IpcHooks {
  syncNow: () => void;
  snooze: (eventId: string) => void;
  /** Settings changed: apply what lives outside the window (theme, tray, login). */
  onSettings: (settings: Settings) => void;
}

export function registerIpc(service: CalendarService, hooks: IpcHooks) {
  ipcMain.handle(IPC.state, () => result(() => service.state()));
  ipcMain.handle(IPC.events, (_e, from: unknown, to: unknown) =>
    result(() => {
      check(isString(from, 10) && isString(to, 10) && isDay(from) && isDay(to));
      return service.events(from, to);
    }),
  );
  ipcMain.handle(IPC.syncNow, () =>
    result(() => {
      hooks.syncNow();
    }),
  );

  ipcMain.handle(IPC.connectCheck, (_e, server: unknown, token: unknown) =>
    result(() => {
      check(
        isString(server, 500) &&
          isString(token, 500) &&
          server.trim() !== '' &&
          token.trim() !== '',
      );
      return service.connectNew(server, token);
    }),
  );
  ipcMain.handle(IPC.connectAccount, (_e, accountId: unknown) =>
    result(() => {
      check(isId(accountId));
      return service.connectExisting(accountId);
    }),
  );
  ipcMain.handle(IPC.connectDatabases, (_e, sessionId: unknown) =>
    result(() => {
      check(isId(sessionId));
      return service.databases(sessionId);
    }),
  );
  ipcMain.handle(IPC.connectSchema, (_e, sessionId: unknown, databaseId: unknown) =>
    result(() => {
      check(isId(sessionId) && isId(databaseId));
      return service.schema(sessionId, databaseId);
    }),
  );
  ipcMain.handle(IPC.connectViews, (_e, sessionId: unknown, databaseId: unknown) =>
    result(() => {
      check(isId(sessionId) && isId(databaseId));
      return service.views(sessionId, databaseId);
    }),
  );
  ipcMain.handle(IPC.connectPeople, (_e, sessionId: unknown) =>
    result(() => {
      check(isId(sessionId));
      return service.people(sessionId);
    }),
  );
  ipcMain.handle(IPC.connectSave, (_e, sessionId: unknown, drafts: unknown) =>
    result(() => {
      check(
        isId(sessionId) && Array.isArray(drafts) && drafts.length <= 50 && drafts.every(isDraft),
      );
      return service.save(sessionId, drafts);
    }),
  );
  ipcMain.handle(IPC.connectCancel, (_e, sessionId: unknown) =>
    result(() => {
      check(isId(sessionId));
      service.cancel(sessionId);
    }),
  );

  ipcMain.handle(IPC.googleSetClient, (_e, clientId: unknown, clientSecret: unknown) =>
    result(() => {
      check(isString(clientId, 300) && isString(clientSecret, 300));
      return service.setGoogleClient(clientId, clientSecret);
    }),
  );
  ipcMain.handle(IPC.googleUseBuiltIn, () => result(() => service.useBuiltInGoogleClient()));
  ipcMain.handle(IPC.googleSignIn, () => result(() => service.googleSignIn()));
  ipcMain.handle(IPC.googleAccount, (_e, accountId: unknown) =>
    result(() => {
      check(isId(accountId));
      return service.googleAccount(accountId);
    }),
  );
  ipcMain.handle(IPC.googleSave, (_e, sessionId: unknown, googleIds: unknown) =>
    result(() => {
      check(
        isId(sessionId) &&
          Array.isArray(googleIds) &&
          googleIds.length <= 100 &&
          googleIds.every((id) => isString(id, 300)),
      );
      return service.googleSave(sessionId, googleIds as string[]);
    }),
  );
  ipcMain.handle(IPC.googleCancel, (_e, sessionId: unknown) =>
    result(() => {
      check(sessionId === undefined || sessionId === null || isId(sessionId));
      service.cancelGoogle(sessionId ?? undefined);
    }),
  );

  ipcMain.handle(IPC.caldavConnect, (_e, server: unknown, username: unknown, password: unknown) =>
    result(() => {
      check(
        isString(server, 500) &&
          isString(username, 300) &&
          isString(password, 500) &&
          server.trim() !== '' &&
          username.trim() !== '' &&
          password !== '',
      );
      return service.caldavConnect(server, username, password);
    }),
  );
  ipcMain.handle(IPC.caldavAccount, (_e, accountId: unknown) =>
    result(() => {
      check(isId(accountId));
      return service.caldavAccount(accountId);
    }),
  );
  ipcMain.handle(IPC.caldavSave, (_e, sessionId: unknown, urls: unknown) =>
    result(() => {
      check(
        isId(sessionId) &&
          Array.isArray(urls) &&
          urls.length <= 100 &&
          urls.every((u) => isString(u, 2000)),
      );
      return service.caldavSave(sessionId, urls as string[]);
    }),
  );
  ipcMain.handle(IPC.caldavCancel, (_e, sessionId: unknown) =>
    result(() => {
      check(isId(sessionId));
      service.cancelCalDav(sessionId);
    }),
  );
  ipcMain.handle(IPC.icsSubscribe, (_e, url: unknown, name: unknown) =>
    result(() => {
      check(isString(url, 2000) && url.trim() !== '' && (name === null || isString(name, 200)));
      return service.subscribe(url, name ?? undefined);
    }),
  );

  ipcMain.handle(IPC.calendarUpdate, (_e, id: unknown, patch: unknown) =>
    result(() => {
      check(isId(id) && !!patch && typeof patch === 'object');
      const p = patch as Record<string, unknown>;
      const clean: CalendarPatch = {};
      if (p.name !== undefined) {
        check(isString(p.name, 200));
        clean.name = p.name;
      }
      if (p.colour !== undefined) {
        check(isString(p.colour, 20));
        clean.colour = p.colour;
      }
      if (p.visible !== undefined) {
        check(typeof p.visible === 'boolean');
        clean.visible = p.visible;
      }
      if (p.reminder !== undefined) {
        check((REMINDER_CHOICES as readonly unknown[]).includes(p.reminder));
        clean.reminder = p.reminder as number | null;
      }
      return service.updateCalendar(id, clean);
    }),
  );
  ipcMain.handle(IPC.calendarRemove, (_e, id: unknown) =>
    result(() => {
      check(isId(id));
      service.removeCalendar(id);
    }),
  );
  ipcMain.handle(IPC.accountRemove, (_e, id: unknown) =>
    result(() => {
      check(isId(id));
      service.removeAccount(id);
    }),
  );
  ipcMain.handle(IPC.eventCreate, (_e, calendarId: unknown, title: unknown, time: unknown) =>
    result(() => {
      check(isId(calendarId) && isString(title, 2000) && isEventTime(time));
      return service.createEvent(calendarId, title, time);
    }),
  );
  ipcMain.handle(IPC.eventUpdate, (_e, id: unknown, change: unknown, scope: unknown) =>
    result(() => {
      check(isEventId(id) && !!change && typeof change === 'object' && isScope(scope));
      const c = change as Record<string, unknown>;
      check(c.title === undefined || isString(c.title, 2000));
      check(c.time === undefined || isEventTime(c.time));
      return service.updateEvent(
        id,
        {
          ...(c.title !== undefined && { title: c.title as string }),
          ...(c.time !== undefined && { time: c.time as EventTime }),
        },
        scope ?? undefined,
      );
    }),
  );
  ipcMain.handle(IPC.eventDelete, (_e, id: unknown, scope: unknown) =>
    result(() => {
      check(isEventId(id) && isScope(scope));
      service.deleteEvent(id, scope ?? undefined);
    }),
  );
  ipcMain.handle(IPC.eventUndoDelete, (_e, id: unknown) =>
    result(() => {
      check(isEventId(id));
      return service.undoDelete(id);
    }),
  );
  ipcMain.handle(IPC.eventDismissConflict, (_e, id: unknown) =>
    result(() => {
      check(isEventId(id));
      service.dismissConflict(id);
    }),
  );
  ipcMain.handle(IPC.eventGet, (_e, id: unknown) =>
    result(() => {
      check(isEventId(id));
      return service.event(id);
    }),
  );
  ipcMain.handle(IPC.snooze, (_e, id: unknown) =>
    result(() => {
      check(isEventId(id));
      hooks.snooze(id);
    }),
  );
  ipcMain.handle(IPC.search, (_e, query: unknown) =>
    result(() => {
      check(isString(query, 200));
      return service.search(query);
    }),
  );
  ipcMain.handle(IPC.openLink, (_e, url: unknown) =>
    result(async () => {
      // Only pages on a connected Workspace server, in the system's browser.
      check(isString(url, 2000) && service.isAccountLink(url));
      await shell.openExternal(url);
    }),
  );
  ipcMain.handle(IPC.settingsSet, (_e, patch: unknown) =>
    result(() => {
      check(!!patch && typeof patch === 'object');
      const p = patch as Record<string, unknown>;
      const clean: Partial<Settings> = {};
      if (p.theme !== undefined) {
        check(p.theme === 'system' || p.theme === 'light' || p.theme === 'dark');
        clean.theme = p.theme;
      }
      if (p.weekStartsOn !== undefined) {
        check(p.weekStartsOn === 0 || p.weekStartsOn === 1 || p.weekStartsOn === 6);
        clean.weekStartsOn = p.weekStartsOn;
      }
      if (p.secondZone !== undefined) {
        check(p.secondZone === null || (isString(p.secondZone, 64) && isTimeZone(p.secondZone)));
        clean.secondZone = p.secondZone;
      }
      for (const key of [
        'keepInTray',
        'startAtLogin',
        'hardwareAcceleration',
        'autoUpdate',
      ] as const) {
        if (p[key] !== undefined) {
          check(typeof p[key] === 'boolean');
          clean[key] = p[key] as boolean;
        }
      }
      const next = service.setSettings(clean);
      hooks.onSettings(next);
      return next;
    }),
  );
}
