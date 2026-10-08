/**
 * Presence on the desktop: the windows showing a doc, relayed to each other and (while
 * syncing) to the server, which relays everyone else's back. The main process keeps which
 * awareness clients each window has, so a window that closes or crashes is removed for
 * the others at once (rather than after the 30-second timeout).
 */
import { MAX_AWARENESS_BYTES, decodeAwareness, encodeAwareness } from '@workspace/sync';
import { BrowserWindow, ipcMain, webContents } from 'electron';
import { IPC } from '../shared/ipc';
import type { SyncService } from './sync/service';

const isDocId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 128;

export function registerPresence(sync: SyncService) {
  /** docId -> window (webContents id) -> its clients' latest clocks */
  const rooms = new Map<string, Map<number, Map<number, number>>>();

  const sendTo = (id: number, channel: string, ...args: unknown[]) => {
    const contents = webContents.fromId(id);
    if (contents && !contents.isDestroyed()) contents.send(channel, ...args);
  };

  const toOthers = (docId: string, update: Uint8Array, except: number | null) => {
    for (const id of rooms.get(docId)?.keys() ?? []) {
      if (id !== except) sendTo(id, IPC.presenceUpdate, docId, update);
    }
  };

  const leave = (docId: string, windowId: number) => {
    const room = rooms.get(docId);
    const clients = room?.get(windowId);
    if (!room || !clients) return;
    room.delete(windowId);
    // Its clients go, for the other windows and the server.
    if (clients.size > 0) {
      const gone = encodeAwareness(
        [...clients].map(([clientID, clock]) => ({ clientID, clock, state: 'null' })),
      );
      toOthers(docId, gone, windowId);
      sync.sendPresence(docId, gone);
    }
    if (room.size === 0) {
      rooms.delete(docId);
      sync.unwatchPresence(docId);
    }
  };

  const tracked = new Set<number>();
  const track = (contents: Electron.WebContents) => {
    if (tracked.has(contents.id)) return;
    tracked.add(contents.id);
    const id = contents.id;
    contents.once('destroyed', () => {
      tracked.delete(id);
      for (const docId of [...rooms.keys()]) leave(docId, id);
    });
    contents.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => {
      // A reload: the page's presence starts over.
      if (isMainFrame && !inPlace) for (const docId of [...rooms.keys()]) leave(docId, id);
    });
  };

  ipcMain.on(IPC.presenceJoin, (event, docId: unknown) => {
    if (!isDocId(docId)) return;
    track(event.sender);
    let room = rooms.get(docId);
    if (!room) {
      rooms.set(docId, (room = new Map()));
      sync.watchPresence(docId);
    }
    if (!room.has(event.sender.id)) room.set(event.sender.id, new Map());
  });

  ipcMain.on(IPC.presenceLeave, (event, docId: unknown) => {
    if (isDocId(docId)) leave(docId, event.sender.id);
  });

  ipcMain.on(IPC.presenceSend, (event, docId: unknown, update: unknown) => {
    if (!isDocId(docId) || !(update instanceof Uint8Array)) return;
    if (update.byteLength > MAX_AWARENESS_BYTES) return;
    const clients = rooms.get(docId)?.get(event.sender.id);
    if (!clients) return;
    let entries;
    try {
      entries = decodeAwareness(update);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.state === 'null') clients.delete(e.clientID);
      else clients.set(e.clientID, e.clock);
    }
    toOthers(docId, update, event.sender.id);
    sync.sendPresence(docId, update);
  });

  // Everyone else, from the server.
  sync.presence.onAwareness = (docId, update) => toOthers(docId, update, null);
  // Reconnected: every window says again where it is.
  sync.presence.onRejoin = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC.presenceRejoin);
    }
  };
}
