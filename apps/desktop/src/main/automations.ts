/**
 * Automations on this device (Phase 6 M4): for a workspace that isn't synced, the main
 * process runs the database automations (`LocalAutomations`) and a button's webhook and
 * notification steps. While the workspace syncs, the server does both.
 */
import {
  LocalAutomations,
  type DocManager,
  type LocalNotice,
  type SqliteStore,
} from '@workspace/storage-local';
import { Notification, ipcMain } from 'electron';
import { IPC } from '../shared/ipc';
import { localUserId } from './ipc';
import { openPage } from './reminders';
import type { SyncService } from './sync/service';

const id = (value: unknown) => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

/** Notifications must be referenced or they can be garbage-collected before a click. */
const live = new Set<Notification>();

/** Show an automation's (or a button's) notification. */
function show(notice: LocalNotice): void {
  if (process.env.WORKSPACE_E2E) {
    // Lets end-to-end tests observe notifications without a notification daemon.
    ((globalThis as { __notifications?: unknown[] }).__notifications ??= []).push({
      ...notice,
      kind: 'automation',
    });
  }
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title: notice.title, body: notice.body });
  live.add(notification);
  notification.on('click', () => notice.pageId && openPage(notice.pageId));
  notification.on('close', () => live.delete(notification));
  notification.show();
}

export function createAutomations(
  manager: DocManager,
  store: SqliteStore,
  sync: SyncService,
): LocalAutomations {
  const delay = Number(process.env.WORKSPACE_AUTOMATION_DELAY_MS);
  const clock = globalThis as { __automationClockOffset?: number };
  // Tests start the app some time "later" (a schedule missed while it was closed).
  clock.__automationClockOffset ??= Number(process.env.WORKSPACE_AUTOMATION_CLOCK_OFFSET_MS) || 0;
  const host = new LocalAutomations(manager, store, {
    active: () => sync.syncedUser() === null,
    userId: () => localUserId(store),
    notify: show,
    delayMs: Number.isFinite(delay) && delay >= 0 ? delay : undefined,
    // Tests move the clock forward to reach a schedule's time.
    now: process.env.WORKSPACE_E2E
      ? () => Date.now() + (clock.__automationClockOffset ?? 0)
      : undefined,
    onError: (error) => console.error('Automation failed', error),
  });
  if (process.env.WORKSPACE_E2E) {
    (globalThis as { __automationsTick?: () => void }).__automationsTick = host.tick;
  }

  ipcMain.handle(IPC.automationRuns, (_event, databaseId: unknown, automationId: unknown) =>
    id(databaseId) && id(automationId)
      ? host.runs(databaseId as string, automationId as string)
      : [],
  );
  ipcMain.handle(IPC.automationSecret, (_event, databaseId: unknown, automationId: unknown) => {
    if (!id(databaseId) || !id(automationId)) throw new Error('Invalid automation');
    return host.secret(databaseId as string, automationId as string);
  });
  ipcMain.handle(IPC.buttonSecret, () => host.buttonSecret());
  ipcMain.on(IPC.buttonWebhook, (_event, request: unknown) => {
    const r = request as { url?: unknown; headers?: unknown; body?: unknown; label?: unknown };
    if (typeof r?.url !== 'string' || !/^https?:\/\//i.test(r.url) || r.url.length > 2048) return;
    if (host.active()) {
      host.buttonWebhook(
        r.url,
        stringRecord(r.headers),
        r.body ?? null,
        typeof r.label === 'string' ? r.label : '',
      );
    }
  });
  ipcMain.on(IPC.buttonNotify, (_event, request: unknown) => {
    const r = request as { title?: unknown; body?: unknown; pageId?: unknown };
    if (!host.active() || typeof r?.title !== 'string') return;
    show({
      title: r.title.slice(0, 200),
      body: typeof r.body === 'string' ? r.body.slice(0, 2000) : '',
      pageId: id(r.pageId) ? (r.pageId as string) : null,
    });
  });
  return host;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value).slice(0, 20)) {
    if (typeof v === 'string' && /^[\w-]{1,64}$/.test(k)) out[k] = v.slice(0, 1024);
  }
  return out;
}
