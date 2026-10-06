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
} as const;

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
