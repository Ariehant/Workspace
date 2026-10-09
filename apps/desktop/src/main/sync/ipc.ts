import { BrowserWindow, ipcMain } from 'electron';
import {
  IPC,
  type SyncEnable,
  type SyncInfo,
  type SyncSignIn,
  type TeamRequest,
} from '../../shared/ipc';
import type { SyncService } from './service';

const isString = (v: unknown, max = 1000): v is string => typeof v === 'string' && v.length <= max;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * The team routes the renderer may call (under the synced workspace), by method. The
 * main process holds the token, so a renderer can't reach anything else with it.
 */
const TEAM_ROUTES: [RegExp, TeamRequest['method'][]][] = [
  [/^me$/, ['GET', 'PATCH']],
  [/^members$/, ['GET']],
  [new RegExp(`^members/${UUID}$`), ['PATCH', 'DELETE']],
  [/^invites$/, ['GET', 'POST']],
  [new RegExp(`^invites/${UUID}$`), ['DELETE']],
  [/^groups$/, ['GET', 'POST']],
  [new RegExp(`^groups/${UUID}$`), ['PATCH', 'DELETE']],
  [new RegExp(`^groups/${UUID}/members/${UUID}$`), ['PUT', 'DELETE']],
  // Scopes (Phase 5 M3): teamspaces, private pages, sharing and moving pages.
  [/^scopes$/, ['GET']],
  [/^teamspaces$/, ['GET', 'POST']],
  [/^private$/, ['POST']],
  [new RegExp(`^scopes/${UUID}$`), ['PATCH']],
  [new RegExp(`^scopes/${UUID}/access$`), ['PUT']],
  [new RegExp(`^scopes/${UUID}/(join|leave)$`), ['POST']],
  [new RegExp(`^pages/${UUID}/(share|move)$`), ['POST']],
  // The inbox (Phase 5 M6): notifications, and following pages.
  [/^notifications(\?filter=(all|mentions|unread|archived)(&before=\d{1,16})?)?$/, ['GET']],
  [/^notifications\/(read|archive)$/, ['POST']],
  [/^pages\/[\w-]{1,128}\/follow$/, ['GET', 'PUT']],
  // Publishing and views (Phase 5 M7).
  [/^pages\/[\w-]{1,128}\/publish$/, ['GET', 'PUT', 'DELETE']],
  [/^pages\/[\w-]{1,128}\/analytics$/, ['GET']],
  [/^pages\/[\w-]{1,128}\/views$/, ['POST']],
  // Forms (Phase 6 M2): responses, and public links.
  [/^forms\/[\w-]{1,128}\/[\w-]{1,128}\/submit$/, ['POST']],
  [/^forms\/[\w-]{1,128}\/[\w-]{1,128}\/link$/, ['GET', 'PUT', 'DELETE']],
  // Automations (Phase 6 M3): recent runs, and the webhook signing secret.
  [/^automations\/[\w-]{1,128}\/[\w-]{1,128}\/(runs|secret)$/, ['GET']],
  // Integrations (Phase 6 M5): settings, tokens.
  [/^integrations$/, ['GET', 'POST']],
  [/^integrations\/[\w-]{1,128}$/, ['PATCH', 'DELETE']],
  [/^integrations\/[\w-]{1,128}\/token$/, ['POST']],
  // A button's webhook and notification steps (Phase 6 M4).
  [/^buttons\/(webhook|notify)$/, ['POST']],
  [/^buttons\/secret$/, ['GET']],
];
const MAX_TEAM_BODY = 128 * 1024;

export function isTeamRequest(value: unknown): value is TeamRequest {
  const r = value as TeamRequest | null;
  if (!r || typeof r !== 'object' || !isString(r.path, 200) || !isString(r.method, 10))
    return false;
  const route = TEAM_ROUTES.find(([pattern]) => pattern.test(r.path));
  if (!route || !route[1].includes(r.method)) return false;
  if (r.body === undefined) return true;
  try {
    return JSON.stringify(r.body).length <= MAX_TEAM_BODY;
  } catch {
    return false;
  }
}

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
  ipcMain.handle(IPC.syncTeam, (_e, request: unknown) =>
    isTeamRequest(request) ? sync.team(request) : { error: 'Invalid request' },
  );
}
