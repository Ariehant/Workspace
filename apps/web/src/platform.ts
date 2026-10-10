/**
 * The shared UI's host in the browser: docs over the sync socket (a partial client: only
 * the docs on screen), search, files and settings over the API.
 */
import type { AccountInfo, Backlink, DocVersionInfo, Platform, ScopeInfo } from '@workspace/app';
import { parseNotification, type NotificationData, type PresenceHandlers } from '@workspace/core';
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
  // The person's scopes: the server says on connecting, and when they change.
  let scopes: ScopeInfo[] | undefined;
  const scopeListeners = new Set<(scopes: ScopeInfo[]) => void>();
  let firstScopes: (scopes: ScopeInfo[]) => void = () => {};
  const scopesKnown = new Promise<ScopeInfo[]>((resolve) => (firstScopes = resolve));
  let resolveScope: ((docId: string) => string | null) | null = null;
  // Presence: one handler per doc shown (the app keeps one awareness each).
  const presenceHandlers = new Map<string, PresenceHandlers>();
  const notificationListeners = new Set<(n: NotificationData) => void>();
  const base = `/api/workspaces/${workspace.id}`;
  // Reminders fire at 9:00 where this person is.
  void api('PATCH', '/api/auth/me', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).catch(() => {});
  const client = new PartialClient({
    deviceId: crypto.randomUUID(),
    onUpdate: (docId, update) => {
      for (const listener of listeners) listener(docId, update);
    },
    onError: (error) => console.warn('sync:', error),
    // The server refused an edit (the person may not change that page), or took a page
    // away: start again from what the server has.
    onReset: (docId) => {
      console.warn(`sync: changes to ${docId} were refused; reloading`);
      location.reload();
    },
    onRevoked: () => location.reload(),
    onAccess: (next) => {
      scopes = next as ScopeInfo[];
      firstScopes(scopes);
      for (const listener of scopeListeners) listener(scopes);
    },
    // A new doc goes to its page's scope (the app knows its trees).
    scopeOf: (docId) => resolveScope?.(docId) ?? null,
    onAwareness: (docId, update) => presenceHandlers.get(docId)?.onUpdate(update),
    onPresenceRejoin: () => {
      for (const handlers of presenceHandlers.values()) handlers.onRejoin();
    },
    onNotify: (payload) => {
      const notification = parseNotification(payload);
      if (notification) for (const listener of notificationListeners) listener(notification);
    },
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
      presence: {
        join: (docId, handlers) => {
          presenceHandlers.set(docId, handlers);
          client.presence.watch(docId);
          return {
            send: (update) => client.presence.awareness(docId, update),
            leave: () => {
              if (presenceHandlers.get(docId) !== handlers) return;
              presenceHandlers.delete(docId);
              client.presence.unwatch(docId);
            },
          };
        },
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
    // Backlinks and history from the server (Phase 5 M7).
    backlinks: async (pageId) =>
      (await api<{ backlinks: Backlink[] }>('GET', `${base}/pages/${pageId}/backlinks`)).backlinks,
    syncedPlaces: async (syncedId) =>
      (await api<{ places: number }>('GET', `${base}/synced/${syncedId}/places`)).places,
    listVersions: async (docId) =>
      (
        await api<{ versions: DocVersionInfo[] }>('GET', `${base}/docs/${docId}/versions`).catch(
          () => ({ versions: [] }),
        )
      ).versions,
    getVersion: async (id) => {
      const r = await api<{ state: string }>('GET', `${base}/versions/${id}`).catch(() => null);
      return r ? Uint8Array.from(atob(r.state), (c) => c.charCodeAt(0)) : null;
    },
    snapshot: async (docId, reason) =>
      (
        await api<{ id: number | null }>('POST', `${base}/docs/${docId}/versions`, {
          reason,
        }).catch(() => ({ id: null }))
      ).id,
    startExport: async () => false,
    cancelExport: () => {},
    onExportStatus: () => () => {},
    provideDiagrams: () => () => {},
    restoreBackup: async () => false,
    printReady: () => {},
    startImport: async () => false,
    cancelImport: () => {},
    onImportStatus: () => () => {},
    features: { export: false, import: false, backup: false },
    scopes: {
      get: () => (scopes ? Promise.resolve(scopes) : scopesKnown),
      onChange: (listener) => {
        scopeListeners.add(listener);
        return () => scopeListeners.delete(listener);
      },
      setResolver: (resolve) => {
        resolveScope = resolve;
      },
    },
    notifications: {
      onNotification: (listener) => {
        notificationListeners.add(listener);
        return () => void notificationListeners.delete(listener);
      },
    },
    team: {
      request: (method, path, body) =>
        api(
          method,
          path === 'me' || path.startsWith('me/')
            ? `/api/auth/${path}`
            : `/api/workspaces/${workspace.id}/${path}`,
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
