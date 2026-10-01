import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocManager, FileStore, SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, Menu, app, nativeTheme, shell } from 'electron';
import type { ThemeSource } from '../shared/ipc';
import { registerFileScheme, registerFiles } from './files';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { resolveDataDir } from './paths';

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

const store = new SqliteStore(join(dataDir, 'workspace.db'));
const manager = new DocManager(store);
const files = new FileStore(dataDir, store);
registerFileScheme();

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

function createWindow(): BrowserWindow {
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

  if (isDev) void window.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void window.loadFile(rendererPath);
  return window;
}

// Keep the app on its own page: open web links in the default browser.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
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

registerIpc(manager, store, onRendererReady);

app.on('second-instance', () => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

app.whenReady().then(() => {
  registerFiles(files, store);
  nativeTheme.themeSource = store.getSetting<ThemeSource>('ui.theme') ?? 'system';
  Menu.setApplicationMenu(buildMenu(createWindow, isDev));
  createWindow();

  if (smokeTest) {
    smokeTimer = setTimeout(() => {
      console.error('smoke-test: timed out waiting for the UI');
      app.exit(1);
    }, 30_000);
  }
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  manager.close();
  store.close();
});
