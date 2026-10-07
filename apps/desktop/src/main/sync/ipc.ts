import { BrowserWindow, ipcMain } from 'electron';
import { IPC, type SyncEnable, type SyncInfo, type SyncSignIn } from '../../shared/ipc';
import type { SyncService } from './service';

const isString = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;

export function broadcastSync(info: SyncInfo) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.syncChanged, info);
  }
}

/** Settings → Sync, over IPC (inputs checked: they come from the renderer). */
export function registerSyncIpc(sync: SyncService) {
  ipcMain.handle(IPC.syncStatus, () => sync.info());
  ipcMain.handle(IPC.syncServerInfo, (_e, url: unknown) =>
    isString(url, 500) ? sync.serverInfo(url) : { error: 'Invalid address' },
  );
  ipcMain.handle(IPC.syncSignIn, (_e, request: unknown) => {
    const r = request as SyncSignIn | null;
    const ok =
      r &&
      isString(r.server, 500) &&
      (r.kind === 'password'
        ? isString(r.email, 254) && isString(r.password)
        : r.kind === 'signup'
          ? isString(r.email, 254) &&
            isString(r.name, 100) &&
            isString(r.password) &&
            (r.invite === undefined || isString(r.invite, 200))
          : r.kind === 'sso' &&
            isString(r.provider, 32) &&
            (r.invite === undefined || isString(r.invite, 200)));
    return ok ? sync.signIn(r) : { error: 'Invalid request' };
  });
  ipcMain.handle(IPC.syncWorkspaces, () => sync.workspaces());
  ipcMain.handle(IPC.syncEnable, (_e, request: unknown) => {
    const r = request as SyncEnable | null;
    const ok =
      r &&
      ((r.mode === 'upload' && isString(r.name, 100)) ||
        ((r.mode === 'merge' || r.mode === 'replace') && isString(r.workspaceId, 64)));
    return ok ? sync.enable(r) : { error: 'Invalid request' };
  });
  ipcMain.handle(IPC.syncDisable, () => sync.disable());
  ipcMain.on(IPC.syncRetry, () => sync.retryNow());
}
