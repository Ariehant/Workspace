import type { DocManager, SqliteStore } from '@workspace/storage-local';
import { BrowserWindow, ipcMain, nativeTheme, type WebContents } from 'electron';
import { IPC, type ThemeSource } from '../shared/ipc';

const isDocId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
const isSettingKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.-]{1,64}$/.test(value);
const THEMES: readonly ThemeSource[] = ['system', 'light', 'dark'];

/**
 * Connects renderer windows to the DocManager. Tracks which docs each window has
 * open so updates are only sent where needed and are released when a window closes.
 */
export function registerIpc(manager: DocManager, store: SqliteStore, onReady: () => void): void {
  const openDocs = new Map<number, Map<string, number>>();

  const track = (sender: WebContents, docId: string) => {
    let docs = openDocs.get(sender.id);
    if (!docs) {
      docs = new Map();
      openDocs.set(sender.id, docs);
      const id = sender.id;
      sender.once('destroyed', () => {
        // Stop routing to this window first: releasing can flush the index, which
        // emits updates that must not be sent to the destroyed WebContents.
        const released = openDocs.get(id) ?? new Map<string, number>();
        openDocs.delete(id);
        for (const [doc, count] of released) {
          for (let i = 0; i < count; i++) manager.release(doc);
        }
      });
    }
    docs.set(docId, (docs.get(docId) ?? 0) + 1);
  };

  const untrack = (sender: WebContents, docId: string): boolean => {
    const docs = openDocs.get(sender.id);
    const count = docs?.get(docId);
    if (!docs || !count) return false;
    if (count === 1) docs.delete(docId);
    else docs.set(docId, count - 1);
    return true;
  };

  ipcMain.handle(IPC.docOpen, (event, docId: unknown) => {
    if (!isDocId(docId)) throw new Error('Invalid document id');
    track(event.sender, docId);
    return manager.open(docId);
  });

  ipcMain.on(IPC.docPush, (event, docId: unknown, update: unknown) => {
    if (!isDocId(docId) || !(update instanceof Uint8Array)) return;
    manager.applyUpdate(docId, update, event.sender.id);
  });

  ipcMain.on(IPC.docClose, (event, docId: unknown) => {
    if (isDocId(docId) && untrack(event.sender, docId)) manager.release(docId);
  });

  manager.onUpdate((docId, update, origin) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      const contents = window.webContents;
      if (contents.id !== origin && openDocs.get(contents.id)?.has(docId)) {
        contents.send(IPC.docUpdate, docId, update);
      }
    }
  });

  ipcMain.handle(IPC.settingsGet, (_event, key: unknown) => {
    if (!isSettingKey(key)) throw new Error('Invalid setting key');
    return store.getSetting(key);
  });

  ipcMain.on(IPC.settingsSet, (_event, key: unknown, value: unknown) => {
    if (isSettingKey(key)) store.setSetting(key, value ?? null);
  });

  ipcMain.handle(IPC.search, (_event, query: unknown) =>
    typeof query === 'string' ? store.search(query.slice(0, 200)) : [],
  );

  ipcMain.on(IPC.themeSet, (_event, theme: unknown) => {
    if (THEMES.includes(theme as ThemeSource)) nativeTheme.themeSource = theme as ThemeSource;
  });

  ipcMain.on(IPC.ready, () => onReady());
}
