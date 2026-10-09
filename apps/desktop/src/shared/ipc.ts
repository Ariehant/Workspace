/** IPC channel names shared by the main process and the preload script. */
export const IPC = {
  docOpen: 'doc:open',
  docPush: 'doc:push',
  docClose: 'doc:close',
  /** main -> renderer: an update made elsewhere. */
  docUpdate: 'doc:update',
  presenceJoin: 'presence:join',
  presenceLeave: 'presence:leave',
  presenceSend: 'presence:send',
  /** main -> renderer: others' presence on a doc. */
  presenceUpdate: 'presence:update',
  /** main -> renderer: sync reconnected; announce again. */
  presenceRejoin: 'presence:rejoin',
  /** main -> renderer: a notification from the server. */
  notification: 'notification:new',
  /** main -> renderer: a system notification was clicked (open what it's about). */
  notificationOpen: 'notification:open',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  search: 'search:query',
  pageLocate: 'page:locate',
  user: 'app:user',
  themeSet: 'theme:set',
  windowOpen: 'window:open',
  fileImport: 'file:import',
  fileOpen: 'file:open',
  linkPreview: 'link:preview',
  backlinks: 'links:backlinks',
  syncedPlaces: 'links:synced',
  historyList: 'history:list',
  historyGet: 'history:get',
  historySnapshot: 'history:snapshot',
  /** main -> renderer: a menu command. */
  command: 'app:command',
  /** main -> renderer: show this page (and block), e.g. from a link or notification. */
  navigate: 'app:navigate',
  ready: 'app:ready',
  exportStart: 'export:start',
  exportCancel: 'export:cancel',
  /** main -> renderer: how an export is going. */
  exportStatus: 'export:status',
  /** main -> renderer: render these Mermaid diagrams to SVG (for HTML exports). */
  exportMermaid: 'export:mermaid',
  exportMermaidResult: 'export:mermaid-result',
  backupRestore: 'backup:restore',
  importStart: 'import:start',
  importCancel: 'import:cancel',
  /** main -> renderer: how an import is going, and its report. */
  importStatus: 'import:status',
  /** print window -> main: the page is rendered, print it. */
  printReady: 'print:ready',
  syncStatus: 'sync:status',
  /** main -> renderer: the sync status changed. */
  syncChanged: 'sync:changed',
  syncServerInfo: 'sync:server-info',
  syncSignIn: 'sync:sign-in',
  syncWorkspaces: 'sync:workspaces',
  syncEnable: 'sync:enable',
  syncDisable: 'sync:disable',
  syncRetry: 'sync:retry',
  /** Members, invites, groups and the profile, on the synced workspace's server. */
  syncTeam: 'sync:team',
  /** Automations this device runs (a workspace that isn't synced): an automation's runs. */
  automationRuns: 'automations:runs',
  automationSecret: 'automations:secret',
  buttonSecret: 'buttons:secret',
  /** A button's "Send webhook" step, sent from the main process. */
  buttonWebhook: 'buttons:webhook',
  /** A button's "Send notification" step, shown on this device. */
  buttonNotify: 'buttons:notify',
} as const;

export type TeamMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** A team API call from the renderer: `path` under the workspace, or `me`. */
export interface TeamRequest {
  method: TeamMethod;
  path: string;
  body?: unknown;
}

/** Where this device's sync stands (shown in the sidebar and Settings → Sync). */
export interface SyncInfo {
  /** off: not set up; account: signed in, no workspace chosen yet; on: syncing a workspace. */
  mode: 'off' | 'account' | 'on';
  server: string | null;
  account: { email: string; name: string } | null;
  workspace: { id: string; name: string } | null;
  state:
    | 'off'
    | 'stopped'
    | 'connecting'
    | 'catching-up'
    | 'live'
    | 'offline'
    | 'unauthorized'
    | 'error';
  reason: string | null;
  /** When the next reconnect happens (offline). */
  retryAt: number | null;
  /** Local changes the server hasn't stored yet. */
  pending: number;
  /** Attachments waiting to upload. */
  files: number;
  lastSyncedAt: number | null;
  /** The session token is encrypted with the system keyring. */
  secureStorage: boolean;
  /** The scopes the person can read (`null` until the server has said, or not syncing). */
  scopes: SyncScope[] | null;
}

/** A scope the person can read (teamspace, private pages, shared page), with their role. */
export interface SyncScope {
  id: string;
  kind: 'teamspace' | 'private' | 'shared';
  name: string;
  treeDoc: string;
  parent: string;
  role: 'full' | 'edit' | 'content' | 'comment' | 'view';
}

export interface SyncServerInfo {
  server: string;
  signup: 'open' | 'invite' | 'disabled';
  needsSetup: boolean;
  providers: { id: string; name: string }[];
}

export type SyncSignIn =
  | { kind: 'password'; server: string; email: string; password: string }
  | {
      kind: 'signup';
      server: string;
      email: string;
      name: string;
      password: string;
      invite?: string;
    }
  | { kind: 'sso'; server: string; provider: string; invite?: string };

export type SyncEnable =
  | { mode: 'upload'; name: string }
  | { mode: 'merge'; workspaceId: string }
  | { mode: 'replace'; workspaceId: string };

/** IPC results that can fail with a message for the user. */
export type Result<T = true> = { ok: T } | { error: string };

export type ExportFormat = 'markdown' | 'html' | 'pdf' | 'backup';

export interface ExportRequest {
  format: ExportFormat;
  /** The page to export; without it, the whole workspace. */
  pageId?: string;
  includeSubpages?: boolean;
  pdf?: { pageSize: 'A4' | 'Letter'; scale: number };
}

export type ExportStatus =
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; path: string }
  | { state: 'cancelled' }
  | { state: 'failed'; error: string };

export type ThemeSource = 'system' | 'light' | 'dark';

/** An attachment stored in the workspace (see FileStore). */
export interface FileRef {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
  image: string | null;
  icon: string | null;
  siteName: string | null;
}

export interface ImportReportInfo {
  /** The page holding the import. */
  rootId: string;
  pages: number;
  databases: number;
  rows: number;
  files: number;
  warnings: string[];
}

export type ImportStatus =
  | { state: 'running'; done: number; total: number }
  | { state: 'done'; report: ImportReportInfo }
  | { state: 'cancelled' }
  | { state: 'failed'; error: string };
