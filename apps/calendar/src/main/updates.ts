/**
 * Updates (the AppImage and the Windows installer), from the project's GitHub releases through
 * the feed in update-channel.ts (electron-updater): a new version downloads in the background,
 * Settings and the tray say so, and it's installed on restart, or when the calendar next quits.
 * The `.deb` updates through apt (the project's apt repository), so there this does nothing.
 * `CALENDAR_UPDATE_URL` points it at another feed (tests).
 */
import { app, BrowserWindow, ipcMain } from 'electron';
import electronUpdater from 'electron-updater';
import { IPC, type UpdateState } from '../shared/ipc';
import { UPDATE_FEED, updateChannel } from './update-channel';

const { autoUpdater } = electronUpdater;

/** Look for an update this long after starting, then this often. */
const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export interface UpdatesOptions {
  /** The Settings switch: look and download on their own. */
  auto: () => boolean;
  log: (level: 'info' | 'warn' | 'error', message: string) => void;
  /** The state changed (the tray shows "Restart to update"). */
  onChange?: (state: UpdateState) => void;
  /** Quit to install: the app's own quit, so it closes the cache first. */
  quitAndInstall?: () => void;
}

/** Whether this copy can update itself: an AppImage, or the installed Windows app. */
export function canUpdate(feed = process.env.CALENDAR_UPDATE_URL): boolean {
  const installed = process.platform === 'win32' ? app.isPackaged : !!process.env.APPIMAGE;
  return installed && (app.isPackaged || !!feed);
}

function configure() {
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: process.env.CALENDAR_UPDATE_URL || UPDATE_FEED,
  });
  // Release candidates follow calendar-rc, releases calendar. Setting a channel allows
  // downgrades; never go back to an older version.
  autoUpdater.channel = updateChannel(app.getVersion());
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}

export class Updates {
  private state: UpdateState;
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly options: UpdatesOptions) {
    const supported = canUpdate();
    this.state = {
      supported,
      current: app.getVersion(),
      status: 'idle',
      version: null,
      progress: null,
      error: null,
    };
    ipcMain.handle(IPC.updatesGet, () => this.state);
    ipcMain.handle(IPC.updatesCheck, () => this.check());
    ipcMain.handle(IPC.updatesInstall, () => this.install());
    if (!supported) return;

    configure();
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: null }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'downloading', version: info.version, progress: 0 }),
    );
    autoUpdater.on('download-progress', (p) => this.set({ progress: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => {
      options.log('info', `update ${info.version} downloaded`);
      this.set({ status: 'ready', version: info.version, progress: 100 });
    });
    autoUpdater.on('error', (error) => {
      options.log('warn', `update: ${error.message}`);
      this.set({ status: 'error', error: error.message });
    });
    const scheduled = () => {
      if (options.auto()) this.check();
    };
    this.timers.push(
      setTimeout(scheduled, Number(process.env.CALENDAR_UPDATE_FIRST_CHECK_MS) || FIRST_CHECK_MS),
      setInterval(scheduled, CHECK_EVERY_MS),
    );
    for (const timer of this.timers) timer.unref();
  }

  get current(): UpdateState {
    return this.state;
  }

  private set(change: Partial<UpdateState>) {
    this.state = { ...this.state, ...change };
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.updatesChanged, this.state);
    }
    this.options.onChange?.(this.state);
  }

  /** Look now (Settings' "Check now", or on schedule); what's found downloads. */
  check(): UpdateState {
    if (!this.state.supported) return this.state;
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.state;
    if (this.state.status === 'ready') return this.state;
    autoUpdater
      .checkForUpdates()
      ?.catch((error: unknown) => this.set({ status: 'error', error: String(error) }));
    return this.state;
  }

  /** Restart into the downloaded version. */
  install() {
    if (this.state.status !== 'ready') return;
    this.options.log('info', `installing update ${this.state.version}`);
    if (this.options.quitAndInstall) this.options.quitAndInstall();
    else autoUpdater.quitAndInstall();
  }

  /** Quit into the downloaded version now (the app has closed what it needs to). */
  static quitAndInstall() {
    autoUpdater.quitAndInstall();
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer);
  }
}

/**
 * `--update-check` (the release tests): look now, and if there's a newer version, download it
 * and install it at once; print the outcome and exit.
 */
export function runUpdateCheck(): void {
  if (!canUpdate()) {
    console.error('update-check: this copy does not update itself');
    app.exit(1);
    return;
  }
  configure();
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
  void autoUpdater.checkForUpdates();
}
