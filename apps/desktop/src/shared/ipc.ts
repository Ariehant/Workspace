/** IPC channel names shared by the main process and the preload script. */
export const IPC = {
  docOpen: 'doc:open',
  docPush: 'doc:push',
  docClose: 'doc:close',
  /** main -> renderer: an update made elsewhere. */
  docUpdate: 'doc:update',
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
} as const;

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
