/** Workspace Calendar's main process: the window, the cache, syncing. */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, nativeTheme, powerMonitor, shell } from 'electron';
import { IPC } from '../shared/ipc';
import { Cache } from './cache';
import { applyTheme, registerIpc } from './ipc';
import { Scheduler } from './scheduler';
import { seal, secureStorage, unseal } from './secrets';
import { CalendarService } from './service';

const SYNC_INTERVAL_MS = Number(process.env.CALENDAR_SYNC_INTERVAL_MS) || 60_000;

// A data dir given by the environment (tests) also holds Chromium's profile, so two copies
// with different data dirs don't share a single-instance lock.
const dataDir = process.env.CALENDAR_DATA_DIR || app.getPath('userData');
mkdirSync(dataDir, { recursive: true });
if (process.env.CALENDAR_DATA_DIR) app.setPath('userData', join(dataDir, 'chromium'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererHtml = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

let mainWindow: BrowserWindow | null = null;
let changeQueued = false;

/** Tell the window something changed (at most once per tick). */
function broadcast() {
  if (changeQueued) return;
  changeQueued = true;
  setImmediate(() => {
    changeQueued = false;
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(IPC.changed);
  });
}

function createWindow() {
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
  window.once('ready-to-show', () => window.show());
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

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const cache = new Cache(join(dataDir, 'calendar.db'));
  const service = new CalendarService({
    cache,
    seal,
    unseal,
    secureStorage,
    onChange: broadcast,
  });
  applyTheme(service.settings());
  const scheduler = new Scheduler((full) => service.sync.syncAll({ full }), SYNC_INTERVAL_MS);
  // Asking to sync also sweeps for rows deleted in Workspace (HANDOFF.md 3.5).
  registerIpc(service, { syncNow: () => scheduler.poke(true) });

  mainWindow = createWindow();
  mainWindow.on('focus', () => scheduler.poke());
  powerMonitor.on('resume', () => scheduler.poke());
  scheduler.start();

  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    scheduler.stop();
    cache.close();
  });
});
