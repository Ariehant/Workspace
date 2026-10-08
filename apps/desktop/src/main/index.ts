import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINK_SCHEME, WORKSPACE_DOC_ID, parsePageUrl } from '@workspace/core';
import {
  DocManager,
  FileStore,
  SqliteStore,
  readBackupManifest,
  restoreBackup,
} from '@workspace/storage-local';
import { unzipSync } from 'fflate';
import { BrowserWindow, Menu, app, nativeTheme, powerMonitor, shell } from 'electron';
import type { ThemeSource } from '../shared/ipc';
import { asideDir, registerExport } from './export';
import { registerFileScheme, registerFiles } from './files';
import { registerImport } from './import';
import { registerIpc } from './ipc';
import { openPage } from './reminders';
import { ReminderScheduler } from './reminders';
import { buildMenu } from './menu';
import { resolveDataDir } from './paths';
import { broadcastSync, registerSyncIpc } from './sync/ipc';
import { SyncService, type CarrySettings } from './sync/service';

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
/** `--smoke-test`: start, wait for the UI to render, then exit 0 (or 1 on timeout). */
const smokeTest = process.argv.includes('--smoke-test');

if (smokeTest) {
  // Fail fast instead of showing an error dialog nobody can dismiss.
  process.on('uncaughtException', (error) => {
    console.error('smoke-test: uncaught exception', error);
    app.exit(1);
  });
}

const dataDir = resolveDataDir();
mkdirSync(dataDir, { recursive: true });
if (process.env.WORKSPACE_DATA_DIR) {
  // Keep Chromium's profile (and the single-instance lock) with the custom data dir.
  app.setPath('userData', join(dataDir, 'chromium'));
}

// One process owns the database; a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const dbPath = join(dataDir, 'workspace.db');
const store = new SqliteStore(dbPath);
const reminders = new ReminderScheduler(store);
// Tests shorten the page-history session so versions appear within a test.
const versionInterval = Number(process.env.WORKSPACE_VERSION_INTERVAL_MS);
const manager = new DocManager(store, {
  onRemindersChanged: () => reminders.check(),
  versionIntervalMs:
    Number.isFinite(versionInterval) && versionInterval > 0 ? versionInterval : undefined,
});
const files = new FileStore(dataDir, store);
registerFileScheme();
const sync = new SyncService({
  store,
  manager,
  files,
  broadcast: broadcastSync,
  openExternal: (url) =>
    // Tests: play the browser's part (follow the sign-in redirects) without a browser.
    process.env.WORKSPACE_E2E && process.env.WORKSPACE_E2E_FOLLOW_LINKS
      ? fetch(url).then((response) => void response.body?.cancel())
      : shell.openExternal(url),
  replaceWorkspace: (settings) => replaceWorkspace(settings),
});

interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const preloadPath = fileURLToPath(new URL('../preload/index.cjs', import.meta.url));
const rendererPath = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff';
}

/** Open a window; with `pageId` it starts on that page (passed in the URL hash). */
function createWindow(pageId?: string): BrowserWindow {
  const saved = store.getSetting<WindowBounds>('window.bounds');
  const hasOtherWindows = BrowserWindow.getAllWindows().length > 0;
  const window = new BrowserWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 820,
    // Cascade new windows instead of stacking them exactly.
    ...(saved?.x !== undefined && !hasOtherWindows ? { x: saved.x, y: saved.y } : {}),
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: app.getName(),
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  if (saved?.maximized && !hasOtherWindows) window.maximize();
  window.once('ready-to-show', () => window.show());

  const saveBounds = () => {
    if (window.isDestroyed()) return;
    store.setSetting('window.bounds', {
      ...window.getNormalBounds(),
      maximized: window.isMaximized(),
    });
  };
  window.on('close', saveBounds);

  loadRenderer(window, pageId ? `page=${encodeURIComponent(pageId)}` : '');
  return window;
}

function loadRenderer(window: BrowserWindow, hash: string): void {
  if (isDev) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL!}${hash ? `#${hash}` : ''}`);
  else void window.loadFile(rendererPath, hash ? { hash } : undefined);
}

/** A hidden window that renders a page for printing to PDF. */
function createPrintWindow(hash: string): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  loadRenderer(window, hash);
  return window;
}

let restoring = false;

/**
 * Replace the workspace with a backup: close everything, move the current database and
 * files aside (into the data dir), restore into the now-empty workspace, rebuild the
 * search index, and restart. If anything fails, the old workspace is put back.
 */
function restoreWorkspace(path: string): void {
  const entries = new Map(Object.entries(unzipSync(readFileSync(path))));
  readBackupManifest(entries); // a readable error before anything is touched
  restoring = true;
  reminders.stop();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  manager.close();
  store.close();
  const aside = asideDir(dataDir);
  mkdirSync(aside, { recursive: true });
  const moved = ['workspace.db', 'workspace.db-wal', 'workspace.db-shm', 'files'].filter((name) =>
    existsSync(join(dataDir, name)),
  );
  for (const name of moved) renameSync(join(dataDir, name), join(aside, name));
  try {
    const fresh = new SqliteStore(dbPath);
    const freshFiles = new FileStore(dataDir, fresh);
    restoreBackup(entries, fresh, freshFiles.dir);
    const indexer = new DocManager(fresh);
    indexer.reindexAll();
    indexer.close();
    fresh.close();
  } catch (error) {
    console.error('Restore failed; putting the workspace back', error);
    for (const name of ['workspace.db', 'workspace.db-wal', 'workspace.db-shm', 'files']) {
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
    for (const name of moved) renameSync(join(aside, name), join(dataDir, name));
  }
  // Tests launch the app again themselves.
  if (!process.env.WORKSPACE_E2E) app.relaunch();
  app.exit(0);
}

/**
 * Take a server's workspace instead of this device's: like a restore, the current
 * database and files are moved aside (kept in the data dir), and the app restarts on
 * an empty database that holds only the sync settings; the pages then arrive by sync.
 */
function replaceWorkspace(settings: CarrySettings): void {
  restoring = true;
  reminders.stop();
  sync.stop();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  manager.close();
  store.close();
  const aside = asideDir(dataDir);
  mkdirSync(aside, { recursive: true });
  for (const name of ['workspace.db', 'workspace.db-wal', 'workspace.db-shm', 'files']) {
    if (existsSync(join(dataDir, name))) renameSync(join(dataDir, name), join(aside, name));
  }
  const fresh = new SqliteStore(dbPath);
  for (const [key, value] of Object.entries(settings)) {
    if (value !== null && value !== undefined) fresh.setSetting(key, value);
  }
  fresh.close();
  if (!process.env.WORKSPACE_E2E) app.relaunch();
  app.exit(0);
}

/**
 * Sync replaced a doc with the server's copy, or took it away (access changed): what the
 * windows show of it is out of date, so they load again. The page tree (the workspace
 * doc) is held for the app's whole life: then the app restarts.
 */
let reloadTimer: ReturnType<typeof setTimeout> | null = null;
manager.onReset((docId) => {
  if (docId === WORKSPACE_DOC_ID) {
    restartApp();
    return;
  }
  reloadTimer ??= setTimeout(() => {
    reloadTimer = null;
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.reload();
    }
  }, 300);
});

function restartApp(): void {
  if (restoring) return;
  restoring = true;
  reminders.stop();
  sync.stop();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  manager.close();
  store.close();
  // Tests launch the app again themselves.
  if (!process.env.WORKSPACE_E2E) app.relaunch();
  app.exit(0);
}

/** Show the page a `workspace://` link points to; `false` if it isn't one. */
function openLink(url: string, target?: BrowserWindow): boolean {
  const link = parsePageUrl(url);
  if (!link) return false;
  openPage(link.pageId, link.blockId, target);
  return true;
}

// Keep the app on its own page: workspace:// links open inside it, web links in the
// default browser.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (openLink(url, BrowserWindow.fromWebContents(contents) ?? undefined))
      return { action: 'deny' };
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url !== contents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
});

let smokeTimer: ReturnType<typeof setTimeout> | undefined;
function onRendererReady(): void {
  if (!smokeTest) return;
  clearTimeout(smokeTimer);
  console.log('smoke-test: ok');
  app.quit();
}

registerIpc(
  manager,
  store,
  onRendererReady,
  (pageId) => createWindow(pageId),
  () => sync.syncedUser(),
);
registerExport({
  manager,
  dbPath,
  filesDir: files.dir,
  createPrintWindow,
  restore: restoreWorkspace,
});
registerImport({ manager, dbPath, dataDir, onFiles: () => sync.fileAdded() });
registerSyncIpc(sync);

// A second launch (e.g. the desktop opening a workspace:// link) hands over to us.
app.on('second-instance', (_event, argv) => {
  const link = argv.find((arg) => arg.toLowerCase().startsWith(`${LINK_SCHEME}://`));
  if (link && openLink(link)) return;
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(() => {
  registerFiles(files, store, {
    fetchMissing: (id) => sync.fetchFile(id),
    onImported: () => sync.fileAdded(),
  });
  sync.start();
  // Back from sleep: reconnect now rather than at the next backoff step.
  powerMonitor.on('resume', () => sync.retryNow());
  if (!smokeTest) reminders.check();
  nativeTheme.themeSource = store.getSetting<ThemeSource>('ui.theme') ?? 'system';
  Menu.setApplicationMenu(buildMenu(() => createWindow(), isDev));
  // Handle workspace:// links system-wide (the .deb also registers the MIME type).
  if (app.isPackaged) app.setAsDefaultProtocolClient(LINK_SCHEME);
  const startLink = process.argv.map(parsePageUrl).find((link) => link !== null);
  createWindow(startLink?.pageId);

  if (smokeTest) {
    smokeTimer = setTimeout(() => {
      console.error('smoke-test: timed out waiting for the UI');
      app.exit(1);
    }, 30_000);
  }
});

app.on('window-all-closed', () => {
  if (!restoring) app.quit();
});

app.on('will-quit', () => {
  reminders.stop();
  sync.stop();
  manager.close();
  store.close();
});
