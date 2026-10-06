import type { DocTransport, User } from '@workspace/core';
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
  | 'prev-tab';

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
  /** Import files (asks which); pages go under a new top-level page. */
  startImport(): Promise<boolean>;
  cancelImport(): void;
  onImportStatus(listener: (status: ImportStatus) => void): () => void;
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
}
