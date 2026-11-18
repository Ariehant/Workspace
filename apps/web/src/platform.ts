/**
 * The shared UI's host in the browser: docs over the sync socket (a partial client: only
 * the docs on screen), search, files and settings over the API.
 */
import type {
  AccountInfo,
  Backlink,
  DocVersionInfo,
  ExportRequest,
  ExportStatus,
  Platform,
  ScopeInfo,
  UnsplashPhoto,
} from '@workspace/app';
import {
  parseNotification,
  searchOptionsToParams,
  type NotificationData,
  type PresenceHandlers,
} from '@workspace/core';
import { PartialClient } from '@workspace/sync';
import { ApiError, api, type Me } from './api';
import { OfflineDocs, type OfflineStore } from './offline';

/** Settings shared by all workspaces; the rest are kept per workspace. */
const GLOBAL_SETTINGS = new Set(['ui.theme', 'ui.sidebarOpen', 'ui.sidebarWidth', 'ui.region']);

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
  /** This browser's offline copy of the workspace, and the scopes it last had. */
  offline: { store: OfflineStore | null; scopes: ScopeInfo[] | null };
}): WebHost {
  const { workspace, user } = options;
  const listeners = new Set<(docId: string, update: Uint8Array) => void>();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // The person's scopes: the server says on connecting, and when they change.
  // Offline, the ones it had last time.
  let scopes: ScopeInfo[] | undefined = options.offline.scopes ?? undefined;
  const scopeListeners = new Set<(scopes: ScopeInfo[]) => void>();
  let firstScopes: (scopes: ScopeInfo[]) => void = () => {};
  const scopesKnown = new Promise<ScopeInfo[]>((resolve) => (firstScopes = resolve));
  const offline = new OfflineDocs(
    options.offline.store,
    () => client,
    (docId, update) => {
      for (const listener of listeners) listener(docId, update);
    },
  );
  let resolveScope: ((docId: string) => string | null) | null = null;
  // Presence: one handler per doc shown (the app keeps one awareness each).
  const presenceHandlers = new Map<string, PresenceHandlers>();
  const notificationListeners = new Set<(n: NotificationData) => void>();
  const base = `/api/workspaces/${workspace.id}`;
  let unsplashOn: Promise<boolean> | undefined;

  // --- Exports: rendered by the server, downloaded here; PDFs printed by the browser.
  const exportListeners = new Set<(status: ExportStatus) => void>();
  const sendExport = (status: ExportStatus) => {
    for (const listener of exportListeners) listener(status);
  };
  let exporting: AbortController | null = null;
  let drawDiagrams: ((sources: string[]) => Promise<Record<string, string>>) | null = null;

  async function startExport(request: ExportRequest): Promise<boolean> {
    if (request.format === 'backup') return false;
    if (request.format === 'pdf') {
      // Opened straight away, while the click still counts (browsers block later pop-ups).
      // Without a page: the whole workspace.
      const params = new URLSearchParams({ print: request.pageId ?? 'all' });
      if (request.includeSubpages) params.set('subpages', '1');
      if (request.pdf) {
        params.set('size', request.pdf.pageSize);
        params.set('scale', String(request.pdf.scale));
      }
      const tab = window.open(`${location.pathname}${location.search}#${params}`, '_blank');
      if (!tab) throw new Error('Allow pop-ups for this site to save PDFs.');
      return true;
    }
    if (exporting) throw new Error('An export is already running.');
    const controller = new AbortController();
    exporting = controller;
    const body = {
      format: request.format,
      ...(request.pageId ? { pageId: request.pageId } : {}),
      ...(request.includeSubpages ? { includeSubpages: true } : {}),
    };
    void (async () => {
      try {
        sendExport({ state: 'running', done: 0, total: 0 });
        let mermaid: Record<string, string> = {};
        if (request.format === 'html' && drawDiagrams) {
          const { sources } = await api<{ sources: string[] }>(
            'POST',
            `${base}/export/diagrams`,
            body,
          );
          if (sources.length) mermaid = await drawDiagrams(sources);
        }
        const response = await fetch(`${base}/export`, {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'x-workspace-client': 'web' },
          body: JSON.stringify({ ...body, mermaid }),
        });
        if (!response.ok) {
          const data = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(data?.message ?? `The server answered ${response.status}.`);
        }
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') ?? '';
        const name = decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1] ?? '');
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name || 'Export.zip';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        sendExport({ state: 'done', path: link.download });
      } catch (error) {
        sendExport(
          controller.signal.aborted
            ? { state: 'cancelled' }
            : { state: 'failed', error: error instanceof Error ? error.message : String(error) },
        );
      } finally {
        if (exporting === controller) exporting = null;
      }
    })();
    return true;
  }
  // Reminders fire at 9:00 where this person is.
  void api('PATCH', '/api/auth/me', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).catch(() => {});
  const client = new PartialClient({
    deviceId: crypto.randomUUID(),
    onUpdate: (docId, update) => offline.received(docId, update),
    onPending: (items) => offline.pending(items),
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
      void options.offline.store?.put('scopes', scopes).catch(() => {});
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
  // Started (and stopped) by the component that shows it. Edits kept from before go first.
  void offline.restore();

  const settings = new Map(Object.entries(options.settings));
  const keyOf = (key: string) => (GLOBAL_SETTINGS.has(key) ? key : `${workspace.id}:${key}`);
  const fileUrl = (id: string) => `/api/workspaces/${workspace.id}/files/${id}`;

  const platform: Platform = {
    transport: {
      open: (docId) => offline.open(docId),
      push: (docId, update) => offline.push(docId, update),
      close: (docId) => offline.close(docId),
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
    about: {
      appVersion: async () => __WORKSPACE_VERSION__,
      serverVersion: async () =>
        (await api<{ version?: string }>('GET', '/api/auth/config').catch(() => null))?.version ??
        null,
      // The server's source (a modified server offers its own, as the AGPL asks).
      sourceUrl: async () =>
        (await api<{ source?: string }>('GET', '/api/auth/config').catch(() => null))?.source ??
        null,
    },
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
    search: async (query, options = {}) => {
      const params = new URLSearchParams({ q: query.slice(0, 200) });
      searchOptionsToParams(options, params);
      return (
        await api<{ results: Awaited<ReturnType<Platform['search']>> }>(
          'GET',
          `/api/workspaces/${workspace.id}/search?${params.toString()}`,
        )
      ).results;
    },
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
    startExport: (request) => startExport(request),
    cancelExport: () => exporting?.abort(),
    onExportStatus: (listener) => {
      exportListeners.add(listener);
      return () => exportListeners.delete(listener);
    },
    provideDiagrams: (render) => {
      drawDiagrams = render;
      return () => {
        if (drawDiagrams === render) drawDiagrams = null;
      };
    },
    // Unsplash covers, where the server has a key.
    unsplash: {
      enabled: () =>
        (unsplashOn ??= api<{ unsplash?: boolean }>('GET', '/api/auth/config').then(
          (config) => config.unsplash === true,
          () => false,
        )),
      search: async (query) =>
        (
          await api<{ photos: UnsplashPhoto[] }>(
            'GET',
            `/api/unsplash/photos?query=${encodeURIComponent(query)}`,
          )
        ).photos,
      picked: async (photo) => {
        await api('POST', '/api/unsplash/picked', { downloadLocation: photo.downloadLocation });
      },
    },
    restoreBackup: async () => false,
    // The print view (a tab of its own) has rendered: the browser's print, which saves PDFs.
    printReady: () => {
      // The size and scale picked in the export dialog.
      const params = new URLSearchParams(location.hash.slice(1));
      const scale = Number(params.get('scale')) || 1;
      const style = document.createElement('style');
      style.textContent = `@page { size: ${params.get('size') === 'Letter' ? 'letter' : 'A4'}; }${
        scale !== 1 ? ` html { zoom: ${Math.min(2, Math.max(0.1, scale))}; }` : ''
      }`;
      document.head.append(style);
      window.addEventListener('afterprint', () => window.close(), { once: true });
      window.print();
    },
    startImport: async () => false,
    cancelImport: () => {},
    onImportStatus: () => () => {},
    features: { export: true, import: false, backup: false },
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
