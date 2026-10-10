import type { DocTransport, NotificationData, NotificationKind, User } from '@workspace/core';
import type { FileRef, LinkPreview } from '@workspace/editor';
import type { ThemePreference } from '@workspace/ui';

/** Commands the host (e.g. the Electron menu) can send to the UI. */
export type AppCommand =
  | 'new-page'
  | 'toggle-sidebar'
  | 'quick-find'
  | 'go-back'
  | 'go-forward'
  | 'new-tab'
  | 'close-tab'
  | 'next-tab'
  | 'prev-tab'
  | 'sync-settings';

export interface SearchHit {
  id: string;
  title: string;
  icon: string | null;
  /** For a database row, its database; `null` for pages. */
  databaseId: string | null;
  /** Matching excerpt with hits wrapped in `[` `]`. */
  snippet: string;
}

/**
 * Everything the shared UI needs from its host. The Electron preload implements it
 * over IPC; the web app will implement it over the sync server.
 */
export interface Platform {
  transport: DocTransport;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting(key: string, value: unknown): void;
  /** Lets the host match native chrome (title bar, menus) to the app theme. */
  setTheme(theme: ThemePreference): void;
  onCommand(listener: (command: AppCommand) => void): () => void;
  /** The host asks to show a page, optionally scrolled to a block (links, notifications). */
  onNavigate(listener: (pageId: string, blockId: string | null) => void): () => void;
  /** Open a page in a new window. */
  openWindow(pageId: string): void;
  /** Full-text search over page titles and content. */
  search(query: string): Promise<SearchHit[]>;
  /**
   * Where a page lives, from the index: `databaseId` null for a workspace page, the
   * database for a row; `null` when unknown.
   */
  locatePage(id: string): Promise<{ databaseId: string | null } | null>;
  /** The person using the app (the local user until accounts exist). */
  getUser(): Promise<User>;
  /** The UI has loaded the workspace and rendered. */
  ready(): void;
  /** Store a file in the workspace's attachments. */
  importFile(file: File): Promise<FileRef>;
  /** URL the UI can load a stored file from. */
  fileUrl(id: string): string;
  /** Open a stored file with the system's default app. */
  openFile(id: string): void;
  /** Title, description and image for a web bookmark. */
  linkPreview(url: string): Promise<LinkPreview | null>;
  /** Pages and rows that link to a page (mentions, links, link-to-page, relations). */
  backlinks(pageId: string): Promise<Backlink[]>;
  /** How many pages show a synced block. */
  syncedPlaces(syncedId: string): Promise<number>;
  /** Page history: saved versions of a doc, newest first. */
  listVersions(docId: string): Promise<DocVersionInfo[]>;
  /** The saved Yjs state of a version. */
  getVersion(id: number): Promise<Uint8Array | null>;
  /** Save the current state of a doc as a version (before a restore, a template…). */
  snapshot(docId: string, reason: string): Promise<number | null>;
  /** Export pages or the workspace; asks where to save. Resolves false if cancelled. */
  startExport(request: ExportRequest): Promise<boolean>;
  cancelExport(): void;
  onExportStatus(listener: (status: ExportStatus) => void): () => void;
  /** Render Mermaid diagrams to SVG when an export asks (source → SVG). */
  provideDiagrams(render: (sources: string[]) => Promise<Record<string, string>>): () => void;
  /** Replace the workspace with a backup (asks for the file and confirms first). */
  restoreBackup(): Promise<boolean>;
  /** A print view has finished rendering. */
  printReady(): void;
  /**
   * Import files (asks which); pages go under a new top-level page, in page tree `tree`
   * (a section of a server workspace; default: the workspace doc).
   */
  startImport(tree?: string): Promise<boolean>;
  cancelImport(): void;
  onImportStatus(listener: (status: ImportStatus) => void): () => void;
  /** Sync with a server (the desktop; the web app is always on its server). */
  sync?: SyncPlatform;
  /** What this host can do; a missing feature means yes (the desktop has them all). */
  features?: Partial<Record<Feature, boolean>>;
  /** The signed-in account (the web app), shown in the workspace menu. */
  account?: AccountInfo;
  /**
   * The workspace's server: members, invites, groups and the account's profile. The
   * web app always has one; the desktop while it syncs a workspace.
   */
  team?: TeamPlatform;
  /** The scopes the person can read (a server workspace); see `ScopesPlatform`. */
  scopes?: ScopesPlatform;
  /** Notifications from the server as they arrive (a server workspace; the inbox). */
  notifications?: NotificationsPlatform;
  /**
   * Automations and button steps the host runs itself, for a workspace that isn't on a
   * server (the desktop). With a server (`team`), the server runs them instead.
   */
  automations?: LocalAutomationsPlatform;
}

/** An automation's run, as its run log shows it. */
export interface AutomationRun {
  id: string;
  at: number;
  rowId: string | null;
  status: 'done' | 'failed' | 'pending';
  error: string | null;
  result: unknown;
}

export interface LocalAutomationsPlatform {
  /** An automation's recent runs, newest first. */
  runs(databaseId: string, automationId: string): Promise<AutomationRun[]>;
  /** The secret an automation's webhooks are signed with. */
  secret(databaseId: string, automationId: string): Promise<string>;
  /** The secret button webhooks are signed with. */
  buttonSecret(): Promise<string>;
  /** A button's "Send webhook" step. */
  buttonWebhook(request: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    label: string;
  }): void;
  /** A button's "Send notification" step (shown on this device). */
  buttonNotify(request: { title: string; body: string; pageId: string | null }): void;
}

/** The server's notifications, live (the list itself is the team API's). */
export interface NotificationsPlatform {
  onNotification(listener: (notification: NotificationData) => void): () => void;
  /** A system notification was clicked: show what it's about. */
  onOpen?(listener: (notification: NotificationData) => void): () => void;
  /** Which kinds show as system notifications (the desktop; a missing kind: yes). */
  systemKinds?: {
    get(): Promise<Partial<Record<NotificationKind, boolean>>>;
    set(kinds: Partial<Record<NotificationKind, boolean>>): void;
  };
}

/**
 * A scope the person can read, as the server last said: a teamspace, someone's private
 * pages, or a page shared on its own. Its pages are in its tree doc.
 */
export interface ScopeInfo {
  id: string;
  kind: 'teamspace' | 'private' | 'shared';
  name: string;
  treeDoc: string;
  /** The scope it inherits access from ('' if none). */
  parent: string;
  role: 'full' | 'edit' | 'content' | 'comment' | 'view';
}

export interface ScopesPlatform {
  /**
   * The scopes, or `null` when the workspace isn't on a server (or the server hasn't
   * said yet): then its one tree, the workspace doc, is all the user's.
   */
  get(): Promise<ScopeInfo[] | null>;
  onChange(listener: (scopes: ScopeInfo[] | null) => void): () => void;
  /**
   * Hosts that place new docs themselves (the web app) ask the app which scope a doc
   * belongs in: its page's tree's. The desktop works it out from its own copy.
   */
  setResolver?(resolve: ((docId: string) => string | null) | null): void;
}

export type TeamMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface TeamPlatform {
  /**
   * Call the server: `path` is under the workspace (`members`, `invites/<id>`,
   * `groups/<id>/members/<user>`…), or `me` (and `me/…`) for the account. Rejects with the server's
   * message.
   */
  request<T>(method: TeamMethod, path: string, body?: unknown): Promise<T>;
}

/** Features some hosts don't have (the web app hides them rather than break). */
export type Feature = 'export' | 'import' | 'backup' | 'history' | 'backlinks';

export const can = (platform: Platform, feature: Feature): boolean =>
  platform.features?.[feature] !== false;

export interface AccountInfo {
  name: string;
  email: string;
  /** The workspace this window shows. */
  workspace: string;
  switchWorkspace(): void;
  signOut(): void;
}

/** Where this device's sync stands. */
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
  retryAt: number | null;
  /** Local changes the server hasn't stored yet. */
  pending: number;
  /** Attachments waiting to upload. */
  files: number;
  lastSyncedAt: number | null;
  /** The session token is encrypted with the system keyring. */
  secureStorage: boolean;
  /** The scopes the person can read (`null` until the server has said, or not syncing). */
  scopes: ScopeInfo[] | null;
}

export interface SyncServerInfo {
  server: string;
  signup: 'open' | 'invite' | 'disabled';
  needsSetup: boolean;
  providers: { id: string; name: string }[];
}

export type SyncResult<T = true> = { ok: T } | { error: string };

export interface SyncPlatform {
  status(): Promise<SyncInfo>;
  onChange(listener: (info: SyncInfo) => void): () => void;
  /** Check a server address and what sign-in it offers. */
  serverInfo(url: string): Promise<SyncResult<SyncServerInfo>>;
  signIn(
    request:
      | { kind: 'password'; server: string; email: string; password: string }
      | {
          kind: 'signup';
          server: string;
          email: string;
          name: string;
          password: string;
          invite?: string;
        }
      | { kind: 'sso'; server: string; provider: string; invite?: string },
  ): Promise<SyncResult>;
  workspaces(): Promise<SyncResult<{ id: string; name: string; role: string }[]>>;
  enable(
    request:
      | { mode: 'upload'; name: string }
      | { mode: 'merge'; workspaceId: string }
      | { mode: 'replace'; workspaceId: string },
  ): Promise<SyncResult>;
  /** Stop syncing and sign out (the pages stay on this device). */
  disable(): Promise<SyncResult>;
  retry(): void;
}

export interface ImportReport {
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
  | { state: 'done'; report: ImportReport }
  | { state: 'cancelled' }
  | { state: 'failed'; error: string };

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

export interface Backlink {
  id: string;
  title: string;
  icon: string | null;
  databaseId: string | null;
  /** The block the link is in. */
  blockId: string | null;
  kind: string;
  snippet: string;
}

export interface DocVersionInfo {
  id: number;
  createdAt: number;
  reason: string;
  /** Kept by the server (Phase 5 M7): who changed the page since the one before. */
  authors?: string[];
}
