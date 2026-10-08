import { App, type AppCommand, type Platform, type TeamMethod } from '@workspace/app';
import { parseNotification, type PresenceHandlers } from '@workspace/core';
import '@workspace/editor/editor.css';
import '@workspace/ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

const api = window.workspace;
/** Which kinds show as system notifications (the main process reads it too). */
const SYSTEM_KINDS = 'notifications.desktop';

/** Presence: one handler per doc this window shows (the app keeps one awareness each). */
const presenceHandlers = new Map<string, PresenceHandlers>();
api.presence.onUpdate((docId, update) => presenceHandlers.get(docId)?.onUpdate(update));
api.presence.onRejoin(() => {
  for (const handlers of presenceHandlers.values()) handlers.onRejoin();
});

const platform: Platform = {
  transport: {
    open: api.docs.open,
    push: api.docs.push,
    close: api.docs.close,
    subscribe: api.docs.onUpdate,
    presence: {
      join: (docId, handlers) => {
        presenceHandlers.set(docId, handlers);
        api.presence.join(docId);
        return {
          send: (update) => api.presence.send(docId, update),
          leave: () => {
            if (presenceHandlers.get(docId) === handlers) presenceHandlers.delete(docId);
            api.presence.leave(docId);
          },
        };
      },
    },
  },
  getSetting: api.settings.get,
  setSetting: api.settings.set,
  setTheme: api.setTheme,
  onCommand: (listener) => api.onCommand((command) => listener(command as AppCommand)),
  onNavigate: (listener) => api.onNavigate(listener),
  openWindow: (pageId) => api.openWindow(pageId),
  search: (query) => api.search(query),
  locatePage: (id) => api.locatePage(id),
  getUser: () => api.user(),
  ready: api.ready,
  importFile: async (file) =>
    api.files.import(new Uint8Array(await file.arrayBuffer()), file.name, file.type),
  fileUrl: (id) => `ws-file://${id}`,
  openFile: (id) => void api.files.open(id),
  linkPreview: (url) => api.linkPreview(url),
  backlinks: (id) => api.links.backlinks(id),
  syncedPlaces: (id) => api.links.syncedPlaces(id),
  listVersions: (docId) => api.history.list(docId),
  getVersion: (id) => api.history.get(id),
  snapshot: (docId, reason) => api.history.snapshot(docId, reason),
  startExport: (request) => api.exports.start(request),
  cancelExport: () => api.exports.cancel(),
  onExportStatus: (listener) => api.exports.onStatus(listener),
  provideDiagrams: (render) => api.exports.onMermaid(render),
  restoreBackup: () => api.exports.restoreBackup(),
  printReady: () => api.exports.printReady(),
  startImport: (tree) => api.imports.start(tree),
  cancelImport: () => api.imports.cancel(),
  onImportStatus: (listener) => api.imports.onStatus(listener),
  sync: api.sync,
  // The scopes come with the sync status (from the server's last `access`).
  scopes: {
    get: async () => (await api.sync.status()).scopes,
    onChange: (listener) => api.sync.onChange((info) => listener(info.scopes)),
  },
  // The server's notifications (while syncing), relayed by the main process.
  notifications: {
    onNotification: (listener) =>
      api.notifications.on((n) => {
        const parsed = parseNotification(JSON.stringify(n));
        if (parsed) listener(parsed);
      }),
    onOpen: (listener) =>
      api.notifications.onOpen((n) => {
        const parsed = parseNotification(JSON.stringify(n));
        if (parsed) listener(parsed);
      }),
    systemKinds: {
      get: async () => (await api.settings.get<Record<string, boolean>>(SYSTEM_KINDS)) ?? {},
      set: (kinds) => api.settings.set(SYSTEM_KINDS, kinds),
    },
  },
  // Works while this workspace syncs (the app only offers it then).
  team: {
    request: async <T,>(method: TeamMethod, path: string, body?: unknown): Promise<T> => {
      const result = await api.sync.team({ method, path, body });
      if ('error' in result) throw new Error(result.error);
      return result.ok as T;
    },
  },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
