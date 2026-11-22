/**
 * The window's requests, checked and passed to the service. Every handler answers a `Result`,
 * so a failure reaches the window as a message to show (never a token: errors don't carry one).
 */
import { ipcMain, nativeTheme } from 'electron';
import {
  IPC,
  type CalendarDraft,
  type CalendarPatch,
  type Result,
  type Settings,
} from '../shared/ipc';
import { isDay } from '../shared/dates';
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

export function applyTheme(settings: Settings) {
  nativeTheme.themeSource = settings.theme;
}

export function registerIpc(service: CalendarService, hooks: { syncNow: () => void }) {
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
      const next = service.setSettings(clean);
      applyTheme(next);
      return next;
    }),
  );
}
