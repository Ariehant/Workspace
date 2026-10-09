/**
 * Notifications on the desktop (Phase 5 M6): the server's, as they arrive, go to every
 * window (the inbox) and, when no window has focus, to the system (libnotify on Ubuntu),
 * for the kinds the person wants. A reminder this device already showed (from its own
 * copy of the page) isn't shown twice.
 */
import { getPage, type NotificationData, type NotificationKind } from '@workspace/core';
import type { DocManager, SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, Notification } from 'electron';
import { IPC } from '../shared/ipc';
import type { ReminderScheduler } from './reminders';
import type { SyncService } from './sync/service';

/** Which kinds show as system notifications (a missing kind: yes). */
export const DESKTOP_NOTIFICATIONS = 'notifications.desktop';

const VERBS: Record<NotificationKind, string> = {
  mention: 'mentioned you',
  comment: 'commented',
  reply: 'replied',
  reminder: 'Reminder',
  access: 'shared with you',
  form: 'responded to',
  automation: 'Automation',
};

/** No window of the app has focus (tests can say so: windows under Xvfb never lose it). */
const away = () =>
  (globalThis as { __e2eAway?: boolean }).__e2eAway === true ||
  BrowserWindow.getFocusedWindow() === null;

export function registerNotifications(
  sync: SyncService,
  store: SqliteStore,
  manager: DocManager,
  reminders: ReminderScheduler,
) {
  /** Notifications must be referenced or they can be garbage-collected before a click. */
  const live = new Set<Notification>();
  /** Reminders shown from the server before this device had them (it won't show them). */
  const fromServer = new Set<string>();
  reminders.shownElsewhere = (r) => fromServer.has(`${r.pageId}/${r.blockId}/${r.fireAt}`);

  const toWindows = (channel: string, n: NotificationData) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) window.webContents.send(channel, n);
    }
  };

  /** A reminder this device fired from its own copy (or fires now, then not again). */
  const shownHere = (n: NotificationData): boolean => {
    if (n.kind !== 'reminder' || !n.key) return false;
    const parts = n.key.split('/');
    const fireAt = Number(parts.pop());
    const pageId = parts.shift();
    const blockId = parts.join('/');
    if (!pageId || !blockId || !Number.isFinite(fireAt)) return false;
    const reminder = { pageId, blockId, fireAt };
    const fired = store.reminderFired(reminder);
    if (!fired) {
      // Shown now: this device's own copy (now, or once the page is indexed) stays quiet.
      if (fired === false) store.markReminderFired(reminder);
      fromServer.add(n.key);
    }
    return fired === true;
  };

  sync.onNotification = (n) => {
    toWindows(IPC.notification, n);
    const kinds =
      store.getSetting<Partial<Record<NotificationKind, boolean>>>(DESKTOP_NOTIFICATIONS);
    if (!away() || kinds?.[n.kind] === false || shownHere(n)) return;
    const actor = n.actorId ? (manager.userNames().get(n.actorId) ?? 'Someone') : null;
    // The title here now (the server's may lag behind a page just made).
    const local = n.pageId ? getPage(manager.forest, n.pageId)?.title : undefined;
    const page = local || n.title || 'Untitled';
    const title =
      n.kind === 'reminder'
        ? `⏰ ${page}`
        : n.kind === 'access'
          ? `${actor} ${VERBS.access}`
          : n.kind === 'form'
            ? `${actor ?? 'Someone'} ${VERBS.form} ${page}`
            : n.kind === 'automation'
              ? `${VERBS.automation}: ${n.title}`
              : `${actor} ${VERBS[n.kind]} in ${page}`;
    const body = n.text || page;
    if (process.env.WORKSPACE_E2E) {
      // Lets end-to-end tests observe notifications without a notification daemon.
      ((globalThis as { __notifications?: unknown[] }).__notifications ??= []).push({
        title,
        body,
        pageId: n.pageId,
        kind: n.kind,
      });
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    live.add(notification);
    notification.on('click', () => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return;
      if (window.isMinimized()) window.restore();
      window.focus();
      window.webContents.send(IPC.notificationOpen, n);
    });
    notification.on('close', () => live.delete(notification));
    notification.show();
  };
}
