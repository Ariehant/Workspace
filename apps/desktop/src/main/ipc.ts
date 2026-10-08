import type { DocManager, SqliteStore } from '@workspace/storage-local';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { BrowserWindow, ipcMain, nativeTheme, type WebContents } from 'electron';
import { IPC, type ThemeSource } from '../shared/ipc';

const isDocId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128;
/** Settings the UI may read and write: not sync's (the session token is among them). */
const isSettingKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) && !value.startsWith('sync.');
const THEMES: readonly ThemeSource[] = ['system', 'light', 'dark'];

/**
 * Connects renderer windows to the DocManager. Tracks which docs each window has
 * open so updates are only sent where needed and are released when a window closes.
 */
/** Page history kept by the server (Phase 5 M7). */
export interface ServerHistory {
  versions(
    docId: string,
  ): Promise<{ id: number; createdAt: number; reason: string; authors: string[] }[]>;
  version(id: number): Promise<Uint8Array | null>;
}

export function registerIpc(
  manager: DocManager,
  store: SqliteStore,
  onReady: () => void,
  openWindow: (pageId: string) => void,
  /** The account, while this workspace syncs with a server. */
  syncedUser: () => { id: string; name: string } | null = () => null,
  /** The server's page history (while syncing): shown with this device's own versions. */
  server: ServerHistory | null = null,
): void {
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

  ipcMain.handle(IPC.pageLocate, (_event, id: unknown) =>
    isDocId(id) ? store.locatePage(id) : null,
  );

  // Backlinks: what the index knows (pages are indexed shortly after each edit).
  ipcMain.handle(IPC.backlinks, (_event, id: unknown) =>
    isDocId(id) ? store.backlinks(id, ['mention', 'link', 'pageLink', 'relation']) : [],
  );
  ipcMain.handle(IPC.syncedPlaces, (_event, id: unknown) =>
    isDocId(id) ? store.syncedPlaces(id) : 0,
  );

  // The server's versions have negative ids here (this device's are positive).
  ipcMain.handle(IPC.historyList, async (_event, docId: unknown) => {
    if (!isDocId(docId)) return [];
    const local = manager.versions(docId);
    const remote = server ? await server.versions(docId).catch(() => []) : [];
    return [
      ...local,
      ...remote.map((v) => ({
        id: -v.id,
        docId,
        createdAt: v.createdAt,
        reason: v.reason,
        authors: v.authors,
      })),
    ].sort((a, b) => b.createdAt - a.createdAt);
  });
  ipcMain.handle(IPC.historyGet, async (_event, id: unknown) => {
    if (typeof id !== 'number' || !Number.isInteger(id)) return null;
    if (id < 0) return server ? await server.version(-id).catch(() => null) : null;
    return manager.versionState(id);
  });
  ipcMain.handle(IPC.historySnapshot, (_event, docId: unknown, reason: unknown) =>
    isDocId(docId) && typeof reason === 'string' && /^[a-z-]{1,32}$/.test(reason)
      ? manager.snapshot(docId, reason)
      : null,
  );

  // While syncing, the account; otherwise the local user: an id kept for this install,
  // named after the OS account.
  ipcMain.handle(IPC.user, () => {
    const account = syncedUser();
    if (account) return account;
    let id = store.getSetting<string>('app.userId');
    if (!id) {
      id = randomUUID();
      store.setSetting('app.userId', id);
    }
    return { id, name: osUserName() };
  });

  ipcMain.on(IPC.themeSet, (_event, theme: unknown) => {
    if (THEMES.includes(theme as ThemeSource)) nativeTheme.themeSource = theme as ThemeSource;
  });

  ipcMain.on(IPC.ready, () => onReady());

  ipcMain.on(IPC.windowOpen, (_event, pageId: unknown) => {
    if (isDocId(pageId)) openWindow(pageId);
  });
}

/** The OS login name, capitalized (a stand-in until accounts exist). */
function osUserName(): string {
  try {
    const { username } = userInfo();
    return username.charAt(0).toUpperCase() + username.slice(1);
  } catch {
    return 'Me';
  }
}
