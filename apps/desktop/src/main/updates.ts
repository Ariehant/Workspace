import type { SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, app, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateState } from '../shared/ipc';

const { autoUpdater } = electronUpdater;

/** Look for an update at start (after a short wait) and then this often. */
const FIRST_CHECK_MS = 15_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const AUTO_SETTING = 'updates.auto';

/**
 * Updates for the AppImage, from the project's GitHub releases (electron-updater): it
 * downloads a new release in the background, says so, and swaps it in on restart. The
 * `.deb`, Snap and Flatpak update through apt and their stores, so there this does nothing.
 * `WORKSPACE_UPDATE_URL` points it at another feed (tests).
 */
export function registerUpdates(store: SqliteStore): void {
  const feed = process.env.WORKSPACE_UPDATE_URL;
  const supported = Boolean(process.env.APPIMAGE) && (app.isPackaged || Boolean(feed));
  let state: UpdateState = {
    supported,
    current: app.getVersion(),
    auto: store.getSetting<boolean>(AUTO_SETTING) ?? true,
    status: 'idle',
    version: null,
    progress: null,
    error: null,
  };
  const set = (change: Partial<UpdateState>) => {
    state = { ...state, ...change };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.updateChanged, state);
    }
  };
  const check = () => {
    if (!supported || state.status === 'checking' || state.status === 'downloading') return;
    autoUpdater
      .checkForUpdates()
      ?.catch((error: unknown) => set({ status: 'error', error: String(error) }));
  };

  ipcMain.handle(IPC.updateGet, () => state);
  ipcMain.on(IPC.updateCheck, () => check());
  ipcMain.on(IPC.updateInstall, () => {
    if (state.status === 'ready') autoUpdater.quitAndInstall();
  });
  ipcMain.on(IPC.updateSetAuto, (_event, on: unknown) => {
    if (typeof on !== 'boolean') return;
    store.setSetting(AUTO_SETTING, on);
    set({ auto: on });
  });

  if (!supported) return;
  if (feed) autoUpdater.setFeedURL({ provider: 'generic', url: feed });
  autoUpdater.logger = null;
  // Without automatic updates, a check (from About) still downloads what it finds.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('update-available', (info) =>
    set({ status: 'downloading', version: info.version, progress: 0 }),
  );
  autoUpdater.on('download-progress', (p) => set({ progress: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) =>
    set({ status: 'ready', version: info.version, progress: 100 }),
  );
  autoUpdater.on('error', (error) => set({ status: 'error', error: error.message }));

  // `--update-check` (the release tests): check now, install what's found on quit, and
  // exit; the outcome is printed.
  if (process.argv.includes('--update-check')) {
    autoUpdater.on('update-not-available', () => {
      console.log('update-check: none');
      app.exit(0);
    });
    autoUpdater.on('update-downloaded', (info) => {
      console.log(`update-check: downloaded ${info.version}`);
      autoUpdater.quitAndInstall(true, false);
    });
    autoUpdater.on('error', (error) => {
      console.error(`update-check: ${error.message}`);
      app.exit(1);
    });
    void app.whenReady().then(check);
    return;
  }

  const scheduled = () => {
    if (state.auto) check();
  };
  setTimeout(scheduled, Number(process.env.WORKSPACE_UPDATE_FIRST_CHECK_MS) || FIRST_CHECK_MS);
  setInterval(scheduled, CHECK_EVERY_MS).unref();
}
