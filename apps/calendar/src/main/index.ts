/** Workspace Calendar's main process: the window, the tray, the cache, syncing, notifications. */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeTheme, Notification, powerMonitor, shell } from 'electron';
import trayIcon from '../../resources/tray.png?asset';
import { addDays, minutesOf, today } from '../shared/dates';
import { IPC, type Settings, type ShowEvent } from '../shared/ipc';
import type { Reminder } from '../shared/reminders';
import type { Calendar } from '../shared/types';
import { HIDDEN_FLAG, setStartAtLogin } from './autostart';
import { Cache } from './cache';
import { applyTheme, registerIpc } from './ipc';
import { createLog } from './log';
import { Notifier } from './notifier';
import { Scheduler } from './scheduler';
import { seal, secureStorage, unseal } from './secrets';
import { CalendarService } from './service';
import { CalendarTray } from './tray';

const SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS) || 60_000;
/** Only in the tray (the window closed), sync less often. */
const TRAY_SYNC_INTERVAL_MS = Math.max(SYNC_INTERVAL_MS, 5 * 60_000);
const E2E = !!process.env.CALENDAR_E2E;

/** `--smoke-test`: start, open a throwaway cache and the window, then quit (packaging checks). */
const smokeTest = process.argv.includes('--smoke-test');
/** `--hidden`: started at login, in the tray only. */
const startHidden = process.argv.includes(HIDDEN_FLAG);

// A data dir given by the environment (tests) also holds Chromium's profile, so two copies
// with different data dirs don't share a single-instance lock.
const dataDir = smokeTest
  ? mkdtempSync(join(tmpdir(), 'workspace-calendar-smoke-'))
  : process.env.CALENDAR_DATA_DIR || app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
if (smokeTest || process.env.CALENDAR_DATA_DIR) app.setPath('userData', join(dataDir, 'chromium'));

// Lightness (HANDOFF.md 1, under 150 MB idle): the network service runs inside the main
// process, and unless the user turns graphics acceleration on, Chromium draws in software
// with its GPU work in the main process too. That's two processes instead of four, and about
// a third less memory; the calendar's UI doesn't need the GPU.
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
if (!readSettingEarly('hardwareAcceleration')) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
}

/** A setting read before the app is ready (switches must be set before then). */
function readSettingEarly(key: keyof Settings): unknown {
  try {
    const cache = new Cache(join(dataDir, 'calendar.db'));
    const value = cache.setting<Partial<Settings>>('settings', {})[key];
    cache.close();
    return value;
  } catch {
    return undefined;
  }
}

if (!smokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererHtml = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

let mainWindow: BrowserWindow | null = null;
let quitting = false;

function createWindow(show = true) {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Workspace Calendar',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  if (show) window.once('ready-to-show', () => window.show());
  // The window shows only the app: links open in the browser, nothing navigates away.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(rendererHtml);
  }
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

if (smokeTest) {
  void app.whenReady().then(async () => {
    // The window's start, as a real one: the cache, the service and its IPC.
    const cache = new Cache(join(dataDir, 'calendar.db'));
    const service = new CalendarService({ cache, seal, unseal, secureStorage });
    registerIpc(service, { syncNow: () => {}, snooze: () => {}, onSettings: () => {} });
    const window = createWindow(false);
    await new Promise<void>((resolve, reject) => {
      window.webContents.once('did-finish-load', () => resolve());
      window.webContents.once('did-fail-load', (_e, code, message) =>
        reject(new Error(`The window didn't load: ${code} ${message}`)),
      );
    }).catch((error: Error) => {
      console.error(error.message);
      app.exit(1);
    });
    // The window asked for its first state through IPC, and got it.
    const answered = await window.webContents.executeJavaScript(
      `window.calendar.state().then((r) => r.ok)`,
    );
    if (!answered) {
      console.error('The window got no state from the main process.');
      app.exit(1);
    }
    service.stop();
    cache.close();
    console.log(`Workspace Calendar ${app.getVersion()}: smoke test passed`);
    app.exit(0);
  });
} else {
  void app.whenReady().then(main);
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (time: string) =>
  `${pad(Math.floor(minutesOf(time) / 60))}:${pad(minutesOf(time) % 60)}`;

function main() {
  Menu.setApplicationMenu(null);
  const log = createLog(join(dataDir, 'logs'));
  log('info', `start ${app.getVersion()} (${process.platform})${startHidden ? ', hidden' : ''}`);

  let changeQueued = false;
  /** Something shown changed: the window refetches, the tray and reminders follow. */
  const changed = () => {
    if (changeQueued) return;
    changeQueued = true;
    setImmediate(() => {
      changeQueued = false;
      for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.changed);
      tray?.update();
      notifier.check();
    });
  };

  const cache = new Cache(join(dataDir, 'calendar.db'));
  const service = new CalendarService({
    cache,
    seal,
    unseal,
    secureStorage,
    onChange: changed,
    log,
  });
  applyTheme(service.settings());
  const scheduler = new Scheduler((full) => service.syncNow(full), SYNC_INTERVAL_MS);

  /** Show the window (made again if it was closed) and, if asked, an event in it. */
  const showWindow = (show?: ShowEvent) => {
    if (!mainWindow) mainWindow = watchWindow(createWindow());
    const window = mainWindow;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (!show) return;
    const send = () => window.webContents.send(IPC.showEvent, show);
    if (window.webContents.isLoading()) window.webContents.once('did-finish-load', send);
    else send();
  };

  // Notifications (HANDOFF.md 1). Live ones are kept, or they're collected before a click.
  const live = new Set<Notification>();
  const notifications: { title: string; body: string }[] = [];
  if (E2E)
    (globalThis as { __notifications?: typeof notifications }).__notifications = notifications;
  const show = (reminder: Reminder, calendar: Calendar | undefined, snoozed: boolean) => {
    const event = reminder.event;
    const title = `${snoozed ? 'Reminder: ' : ''}${event.title || 'Untitled'}`;
    const when = event.allDay
      ? 'All day'
      : `${clock(event.start)} – ${clock(event.end)}${event.start.slice(0, 10) !== today() ? `, ${event.start.slice(0, 10)}` : ''}`;
    const body = calendar ? `${when} · ${calendar.name}` : when;
    if (E2E) notifications.push({ title, body });
    if (!Notification.isSupported()) return;
    const notification = new Notification({
      title,
      body,
      // Buttons in notifications exist on Windows (and macOS); on Linux, the panel offers snooze.
      actions: process.platform === 'linux' ? [] : [{ type: 'button', text: 'Snooze 5 minutes' }],
    });
    live.add(notification);
    notification.on('close', () => live.delete(notification));
    notification.on('click', () => {
      live.delete(notification);
      showWindow({ eventId: event.id, fromNotification: true });
    });
    notification.on('action', (_e, index) => {
      live.delete(notification);
      if (index === 0) notifier.snooze(event.id);
    });
    notification.show();
  };
  const notifier = new Notifier({ cache, show });

  // The tray (HANDOFF.md 1): next event and today's list.
  let tray: CalendarTray | null = null;
  try {
    tray = new CalendarTray({
      icon: trayIcon,
      events: () => service.events(today(), addDays(today(), 1)),
      onOpen: () => showWindow(),
      onOpenEvent: (eventId) => showWindow({ eventId, fromNotification: false }),
      onQuit: () => app.quit(),
    });
  } catch (error) {
    log('warn', `no tray icon: ${(error as Error).message}`);
  }
  const trayTimer = setInterval(() => tray?.update(), 60_000);

  const applySettings = (settings: Settings) => {
    applyTheme(settings);
    try {
      setStartAtLogin(settings.startAtLogin);
    } catch (error) {
      log('warn', `start at login: ${(error as Error).message}`);
    }
  };

  registerIpc(service, {
    // Asking to sync also sweeps for rows deleted in Workspace (HANDOFF.md 3.5).
    syncNow: () => scheduler.poke(true),
    snooze: (eventId) => notifier.snooze(eventId),
    onSettings: applySettings,
  });

  /** Closing the window keeps the app in the tray when that's set; it syncs less often then. */
  function watchWindow(window: BrowserWindow) {
    window.on('close', (event) => {
      if (quitting || !service.settings().keepInTray) return;
      event.preventDefault();
      window.hide();
      scheduler.setInterval(TRAY_SYNC_INTERVAL_MS);
    });
    window.on('show', () => scheduler.setInterval(SYNC_INTERVAL_MS));
    window.on('focus', () => scheduler.poke());
    return window;
  }

  if (startHidden) {
    scheduler.setInterval(TRAY_SYNC_INTERVAL_MS);
  } else {
    mainWindow = watchWindow(createWindow());
  }
  powerMonitor.on('resume', () => {
    scheduler.poke();
    notifier.check();
  });
  scheduler.start();
  notifier.check();

  app.on('second-instance', () => showWindow());
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!service.settings().keepInTray || quitting) app.quit();
  });
  app.on('will-quit', () => {
    quitStep('will-quit');
    clearInterval(trayTimer);
    scheduler.stop();
    notifier.stop();
    service.stop();
    tray?.destroy();
    quitStep('tray gone');
    cache.close();
    quitStep('cache closed');
    log('info', 'quit');
    endIfStuck();
  });
  app.on('quit', () => quitStep('quit'));
}

/** In end-to-end runs, each step of quitting is written out (a stuck exit says where). */
function quitStep(step: string) {
  if (E2E) console.error(`[quit] ${step}`);
}

/**
 * Everything is closed by now. Chromium has been seen not to end the process after this (in
 * the Workspace desktop app: docs/PHASE8.md, "The E2E teardown hang"). A process left like that
 * would keep the app from starting again (one instance at a time), so a watchdog ends it. It
 * runs on a thread of its own: the main thread's timers no longer run once quitting has begun.
 * A normal exit takes it along.
 */
function endIfStuck() {
  const ms = 4000;
  const watchdog = new Worker(
    `const { writeSync } = require('node:fs');
    setTimeout(() => {
      writeSync(2, "Workspace Calendar didn't exit ${ms / 1000} s after quitting; ending it.\\n");
      process.kill(process.pid, 'SIGKILL');
    }, ${ms});`,
    { eval: true },
  );
  watchdog.unref();
}
