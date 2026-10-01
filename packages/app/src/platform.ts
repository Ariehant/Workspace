import type { DocTransport } from '@workspace/core';
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
  /** The UI has loaded the workspace and rendered. */
  ready(): void;
}
