import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type FileRef, type LinkPreview, type ThemeSource } from '../shared/ipc';

type Unsubscribe = () => void;

function on<Args extends unknown[]>(
  channel: string,
  listener: (...args: Args) => void,
): Unsubscribe {
  const wrapped = (_event: unknown, ...args: unknown[]) => listener(...(args as Args));
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** The only bridge between the sandboxed UI and the main process. */
const api = {
  docs: {
    open: (docId: string): Promise<Uint8Array> => ipcRenderer.invoke(IPC.docOpen, docId),
    push: (docId: string, update: Uint8Array): void => ipcRenderer.send(IPC.docPush, docId, update),
    close: (docId: string): void => ipcRenderer.send(IPC.docClose, docId),
    onUpdate: (listener: (docId: string, update: Uint8Array) => void): Unsubscribe =>
      on(IPC.docUpdate, listener),
  },
  settings: {
    get: <T>(key: string): Promise<T | undefined> => ipcRenderer.invoke(IPC.settingsGet, key),
    set: (key: string, value: unknown): void => ipcRenderer.send(IPC.settingsSet, key, value),
  },
  search: (
    query: string,
  ): Promise<{ id: string; title: string; icon: string | null; snippet: string }[]> =>
    ipcRenderer.invoke(IPC.search, query),
  files: {
    import: (bytes: Uint8Array, name: string, mime: string): Promise<FileRef> =>
      ipcRenderer.invoke(IPC.fileImport, bytes, name, mime),
    open: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.fileOpen, id),
  },
  linkPreview: (url: string): Promise<LinkPreview | null> =>
    ipcRenderer.invoke(IPC.linkPreview, url),
  setTheme: (theme: ThemeSource): void => ipcRenderer.send(IPC.themeSet, theme),
  onCommand: (listener: (command: string) => void): Unsubscribe => on(IPC.command, listener),
  ready: (): void => ipcRenderer.send(IPC.ready),
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('workspace', api);
