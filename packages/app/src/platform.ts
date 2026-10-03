import type { DocTransport } from '@workspace/core';
import type { FileRef, LinkPreview } from '@workspace/editor';
import type { ThemePreference } from '@workspace/ui';

/** Commands the host (e.g. the Electron menu) can send to the UI. */
export type AppCommand = 'new-page' | 'toggle-sidebar';

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
  /** The host asks to show a page (e.g. a reminder notification was clicked). */
  onNavigate(listener: (pageId: string) => void): () => void;
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
}
