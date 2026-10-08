/**
 * The shared UI's host in the browser: docs over the sync socket (a partial client: only
 * the docs on screen), search, files and settings over the API.
 */
import type { AccountInfo, Platform } from '@workspace/app';
import { PartialClient } from '@workspace/sync';
import { ApiError, api, type Me } from './api';

/** Settings shared by all workspaces; the rest are kept per workspace. */
const GLOBAL_SETTINGS = new Set(['ui.theme', 'ui.sidebarOpen', 'ui.sidebarWidth']);

const extensionFor = (name: string) => {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,10}$/.test(ext) ? `.${ext}` : '';
};

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface WebHost {
  platform: Platform;
  client: PartialClient;
}

export function createWebPlatform(options: {
  workspace: { id: string; name: string };
  user: Me;
  settings: Record<string, unknown>;
  account: Omit<AccountInfo, 'name' | 'email' | 'workspace'>;
}): WebHost {
  const { workspace, user } = options;
  const listeners = new Set<(docId: string, update: Uint8Array) => void>();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new PartialClient({
    deviceId: crypto.randomUUID(),
    onUpdate: (docId, update) => {
      for (const listener of listeners) listener(docId, update);
    },
    onError: (error) => console.warn('sync:', error),
    connect: (handlers) => {
      // The session cookie authenticates the socket (same origin).
      const ws = new WebSocket(`${protocol}//${location.host}/api/sync/${workspace.id}`);
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (event) => handlers.onMessage(new Uint8Array(event.data as ArrayBuffer));
      ws.onclose = (event) => handlers.onClose(event.code, event.reason);
      return {
        send: (data) => ws.send(data as Uint8Array<ArrayBuffer>),
        close: () => ws.close(),
      };
    },
  });
  // Started (and stopped) by the component that shows it.

  const settings = new Map(Object.entries(options.settings));
  const keyOf = (key: string) => (GLOBAL_SETTINGS.has(key) ? key : `${workspace.id}:${key}`);
  const fileUrl = (id: string) => `/api/workspaces/${workspace.id}/files/${id}`;

  const platform: Platform = {
    transport: {
      open: (docId) => client.open(docId),
      push: (docId, update) => client.push(docId, update),
      close: (docId) => client.close(docId),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    getSetting: async <T>(key: string) => settings.get(keyOf(key)) as T | undefined,
    setSetting: (key, value) => {
      const stored = keyOf(key);
      if (value === undefined || value === null) settings.delete(stored);
      else settings.set(stored, value);
      void api('PUT', `/api/settings/${encodeURIComponent(stored)}`, {
        value: value ?? null,
      }).catch((error: unknown) => console.warn('setting not saved:', error));
    },
    setTheme: () => {},
    onCommand: () => () => {},
    // Links to pages (#page=…) in this tab.
    onNavigate: (listener) => {
      const onHash = () => {
        const params = new URLSearchParams(location.hash.slice(1));
        const page = params.get('page');
        if (page) listener(page, params.get('block'));
      };
      window.addEventListener('hashchange', onHash);
      return () => window.removeEventListener('hashchange', onHash);
    },
    openWindow: (pageId) => {
      window.open(`/w/${workspace.id}#page=${encodeURIComponent(pageId)}`, '_blank', 'noopener');
    },
    search: async (query) =>
      (
        await api<{ results: Awaited<ReturnType<Platform['search']>> }>(
          'GET',
          `/api/workspaces/${workspace.id}/search?q=${encodeURIComponent(query.slice(0, 200))}`,
        )
      ).results,
    locatePage: async (id) => {
      try {
        return await api<{ databaseId: string | null }>(
          'GET',
          `/api/workspaces/${workspace.id}/pages/${encodeURIComponent(id)}/location`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
    getUser: async () => ({ id: user.id, name: user.name }),
    ready: () => {},
    importFile: async (file) => {
      const bytes = await file.arrayBuffer();
      const id = `${await sha256(bytes)}${extensionFor(file.name)}`;
      const response = await fetch(fileUrl(id), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'content-type': 'application/octet-stream',
          'x-workspace-client': 'web',
          'x-file-name': encodeURIComponent(file.name),
          'x-file-mime': file.type || 'application/octet-stream',
        },
        body: bytes,
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? `Upload failed (${response.status})`);
      }
      return {
        id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
      };
    },
    fileUrl,
    openFile: (id) => window.open(fileUrl(id), '_blank', 'noopener'),
    // Fetching other sites is the desktop's job (a server doing it would be an SSRF risk).
    linkPreview: async () => null,
    backlinks: async () => [],
    syncedPlaces: async () => 0,
    listVersions: async () => [],
    getVersion: async () => null,
    snapshot: async () => null,
    startExport: async () => false,
    cancelExport: () => {},
    onExportStatus: () => () => {},
    provideDiagrams: () => () => {},
    restoreBackup: async () => false,
    printReady: () => {},
    startImport: async () => false,
    cancelImport: () => {},
    onImportStatus: () => () => {},
    features: { export: false, import: false, backup: false, history: false, backlinks: false },
    team: {
      request: (method, path, body) =>
        api(
          method,
          path === 'me' ? '/api/auth/me' : `/api/workspaces/${workspace.id}/${path}`,
          body,
        ),
    },
    account: {
      name: user.name,
      email: user.email,
      workspace: workspace.name,
      ...options.account,
    },
  };
  return { platform, client };
}
