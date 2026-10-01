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
  themeSet: 'theme:set',
  /** main -> renderer: a menu command. */
  command: 'app:command',
  ready: 'app:ready',
} as const;

export type ThemeSource = 'system' | 'light' | 'dark';
