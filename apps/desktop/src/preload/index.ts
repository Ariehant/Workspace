import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type ExportRequest,
  type ExportStatus,
  type ImportStatus,
  type FileRef,
  type LinkPreview,
  type Result,
  type SyncEnable,
  type SyncInfo,
  type SyncServerInfo,
  type SyncSignIn,
  type ThemeSource,
} from '../shared/ipc';

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
  ): Promise<
    { id: string; title: string; icon: string | null; databaseId: string | null; snippet: string }[]
  > => ipcRenderer.invoke(IPC.search, query),
  locatePage: (id: string): Promise<{ databaseId: string | null } | null> =>
    ipcRenderer.invoke(IPC.pageLocate, id),
  user: (): Promise<{ id: string; name: string }> => ipcRenderer.invoke(IPC.user),
  files: {
    import: (bytes: Uint8Array, name: string, mime: string): Promise<FileRef> =>
      ipcRenderer.invoke(IPC.fileImport, bytes, name, mime),
    open: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.fileOpen, id),
  },
  linkPreview: (url: string): Promise<LinkPreview | null> =>
    ipcRenderer.invoke(IPC.linkPreview, url),
  links: {
    backlinks: (
      pageId: string,
    ): Promise<
      {
        id: string;
        title: string;
        icon: string | null;
        databaseId: string | null;
        blockId: string | null;
        kind: string;
        snippet: string;
      }[]
    > => ipcRenderer.invoke(IPC.backlinks, pageId),
    syncedPlaces: (syncedId: string): Promise<number> =>
      ipcRenderer.invoke(IPC.syncedPlaces, syncedId),
  },
  history: {
    list: (docId: string): Promise<{ id: number; createdAt: number; reason: string }[]> =>
      ipcRenderer.invoke(IPC.historyList, docId),
    get: (id: number): Promise<Uint8Array | null> => ipcRenderer.invoke(IPC.historyGet, id),
    snapshot: (docId: string, reason: string): Promise<number | null> =>
      ipcRenderer.invoke(IPC.historySnapshot, docId, reason),
  },
  setTheme: (theme: ThemeSource): void => ipcRenderer.send(IPC.themeSet, theme),
  onCommand: (listener: (command: string) => void): Unsubscribe => on(IPC.command, listener),
  onNavigate: (listener: (pageId: string, blockId: string | null) => void): Unsubscribe =>
    on(IPC.navigate, listener),
  openWindow: (pageId: string): void => ipcRenderer.send(IPC.windowOpen, pageId),
  exports: {
    start: (request: ExportRequest): Promise<boolean> =>
      ipcRenderer.invoke(IPC.exportStart, request),
    cancel: (): void => ipcRenderer.send(IPC.exportCancel),
    onStatus: (listener: (status: ExportStatus) => void): Unsubscribe =>
      on(IPC.exportStatus, listener),
    /** Render Mermaid sources to SVG for the main process (HTML exports). */
    onMermaid: (render: (sources: string[]) => Promise<Record<string, string>>): Unsubscribe =>
      on(IPC.exportMermaid, (sources: string[]) => {
        void render(sources).then(
          (svgs) => ipcRenderer.send(IPC.exportMermaidResult, svgs),
          () => ipcRenderer.send(IPC.exportMermaidResult, {}),
        );
      }),
    restoreBackup: (): Promise<boolean> => ipcRenderer.invoke(IPC.backupRestore),
    printReady: (): void => ipcRenderer.send(IPC.printReady),
  },
  imports: {
    start: (): Promise<boolean> => ipcRenderer.invoke(IPC.importStart),
    cancel: (): void => ipcRenderer.send(IPC.importCancel),
    onStatus: (listener: (status: ImportStatus) => void): Unsubscribe =>
      on(IPC.importStatus, listener),
  },
  sync: {
    status: (): Promise<SyncInfo> => ipcRenderer.invoke(IPC.syncStatus),
    onChange: (listener: (info: SyncInfo) => void): Unsubscribe => on(IPC.syncChanged, listener),
    serverInfo: (url: string): Promise<Result<SyncServerInfo>> =>
      ipcRenderer.invoke(IPC.syncServerInfo, url),
    signIn: (request: SyncSignIn): Promise<Result> => ipcRenderer.invoke(IPC.syncSignIn, request),
    workspaces: (): Promise<Result<{ id: string; name: string; role: string }[]>> =>
      ipcRenderer.invoke(IPC.syncWorkspaces),
    enable: (request: SyncEnable): Promise<Result> => ipcRenderer.invoke(IPC.syncEnable, request),
    disable: (): Promise<Result> => ipcRenderer.invoke(IPC.syncDisable),
    retry: (): void => ipcRenderer.send(IPC.syncRetry),
  },
  ready: (): void => ipcRenderer.send(IPC.ready),
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('workspace', api);
