import type { Reminder, SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, Notification } from 'electron';
import { IPC } from '../shared/ipc';

/** Re-check at least this often, so clock changes and sleep/resume are picked up. */
const MAX_WAIT_MS = 60_000;

/**
 * Shows desktop notifications for due `@remind` mentions. Reminders that came due
 * while the app was closed fire on the next start.
 */
export class ReminderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Notifications must be referenced or they can be garbage-collected before a click. */
  private readonly live = new Set<Notification>();
  /** Reminders already shown another way (the server's copy): not shown again. */
  shownElsewhere: (reminder: Reminder) => boolean = () => false;

  constructor(private readonly store: SqliteStore) {}

  /** Fire anything due now, then sleep until the next reminder. */
  check = (): void => {
    clearTimeout(this.timer);
    for (const reminder of this.store.dueReminders(Date.now())) {
      this.store.markReminderFired(reminder);
      if (!this.shownElsewhere(reminder)) this.notify(reminder);
    }
    const next = this.store.nextReminderAt();
    const wait =
      next === null ? MAX_WAIT_MS : Math.max(0, Math.min(next - Date.now(), MAX_WAIT_MS));
    this.timer = setTimeout(this.check, wait);
  };

  stop(): void {
    clearTimeout(this.timer);
  }

  private notify(reminder: Reminder): void {
    const title = reminder.pageTitle || 'Untitled';
    const body = reminder.text || 'Reminder';
    if (process.env.WORKSPACE_E2E) {
      // Lets end-to-end tests observe notifications without a notification daemon.
      ((globalThis as { __notifications?: unknown[] }).__notifications ??= []).push({
        title,
        body,
        pageId: reminder.pageId,
      });
    }
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title: `⏰ ${title}`, body });
    this.live.add(notification);
    notification.on('click', () => openPage(reminder.pageId));
    notification.on('close', () => this.live.delete(notification));
    notification.show();
  }
}

/** Bring a window forward (the focused one, else the first) and show the page in it. */
export function openPage(
  pageId: string,
  blockId: string | null = null,
  target?: BrowserWindow,
): void {
  const window = target ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
  window.webContents.send(IPC.navigate, pageId, blockId);
}
