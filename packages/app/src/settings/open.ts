import type { SettingsSection } from './settings-window';

/**
 * Open the Settings window at a section from anywhere (a block in a page asking for a linked
 * folder, say). The app listens while it's shown.
 */
const listeners = new Set<(section: SettingsSection) => void>();

export function openSettings(section: SettingsSection): void {
  for (const listener of listeners) listener(section);
}

export function onOpenSettings(listener: (section: SettingsSection) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
