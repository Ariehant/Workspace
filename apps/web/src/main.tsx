import { App, type ScopeInfo } from '@workspace/app';
import '@workspace/editor/editor.css';
import type { SyncStatus } from '@workspace/sync';
import { CloudOff, Loader2 } from 'lucide-react';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError, api, me, type InviteInfo, type Me, type RemoteWorkspace } from './api';
import { OfflineStore } from './offline';
import { createWebPlatform } from './platform';
import {
  Card,
  InviteScreen,
  ShareLinkScreen,
  SignIn,
  WorkspacePicker,
  type ShareLinkInfo,
} from './shell';
import './web.css';

const LAST_WORKSPACE = 'workspace.last';

/** `/w/<id>` → the workspace id. */
const workspaceFromPath = () => /^\/w\/([0-9a-f-]{36})\/?$/i.exec(location.pathname)?.[1] ?? null;
/** `/s/<token>` → a page's share link token. */
const shareLinkFromPath = () => /^\/s\/([\w-]{10,64})\/?$/.exec(location.pathname)?.[1] ?? null;
/** `/invite/<token>` → the invite token. */
const inviteFromPath = () => /^\/invite\/([\w-]{1,200})\/?$/.exec(location.pathname)?.[1] ?? null;

const remember = (id: string | null) => {
  try {
    if (id) localStorage.setItem(LAST_WORKSPACE, id);
    else localStorage.removeItem(LAST_WORKSPACE);
  } catch {
    // Storage blocked: just don't remember.
  }
};
const lastWorkspace = () => {
  try {
    return localStorage.getItem(LAST_WORKSPACE);
  } catch {
    return null;
  }
};

/** What starting needs, kept for starting offline (who, which workspaces, settings). */
const BOOT = 'workspace.boot';
interface Boot {
  user: Me;
  workspaces: RemoteWorkspace[];
  settings: Record<string, unknown>;
}
const keepBoot = (boot: Boot | null) => {
  try {
    if (boot) localStorage.setItem(BOOT, JSON.stringify(boot));
    else localStorage.removeItem(BOOT);
  } catch {
    // Storage blocked: no offline start.
  }
};
const keptBoot = (): Boot | null => {
  try {
    return JSON.parse(localStorage.getItem(BOOT) ?? 'null') as Boot | null;
  } catch {
    return null;
  }
};

async function signOut() {
  await api('POST', '/api/auth/logout', {}).catch(() => {});
  remember(null);
  // Nothing of the account stays in this browser.
  keepBoot(null);
  await OfflineStore.clear();
  location.assign('/');
}

// The shell's own screens follow the system theme (the app has its own setting).
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light';

type State =
  | { screen: 'loading' }
  | { screen: 'sign-in' }
  | { screen: 'invite'; token: string; invite: InviteInfo | null; user: Me | null }
  | {
      screen: 'link';
      token: string;
      link: ShareLinkInfo | null;
      problem: string | null;
      user: Me | null;
    }
  | { screen: 'pick'; user: Me }
  | {
      screen: 'app';
      user: Me;
      workspace: RemoteWorkspace;
      settings: Record<string, unknown>;
      offline: Offline;
    }
  | { screen: 'error'; message: string };

/** Where the app should be: signed out, choosing a workspace, or in one. */
async function resolveState(): Promise<State> {
  try {
    const user = await me();
    const linkToken = shareLinkFromPath();
    if (linkToken) {
      const found = await api<ShareLinkInfo>(
        'GET',
        `/api/links/${encodeURIComponent(linkToken)}`,
      ).then(
        (link) => ({ link, problem: null }),
        (error: unknown) => {
          if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
            return { link: null, problem: error.message };
          }
          throw error;
        },
      );
      return { screen: 'link', token: linkToken, user, ...found };
    }
    const token = inviteFromPath();
    if (token) {
      const invite = await api<{ invite: InviteInfo }>(
        'GET',
        `/api/invites/${encodeURIComponent(token)}`,
      ).then(
        (r) => r.invite,
        (error: unknown) => {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        },
      );
      return { screen: 'invite', token, invite, user };
    }
    if (!user) return { screen: 'sign-in' };
    const wanted = workspaceFromPath();
    const choose = new URLSearchParams(location.search).has('choose');
    const id = wanted ?? (choose ? null : lastWorkspace());
    if (!id) return { screen: 'pick', user };
    const { workspaces } = await api<{ workspaces: RemoteWorkspace[] }>('GET', '/api/workspaces');
    const workspace = workspaces.find((w) => w.id === id);
    if (!workspace) {
      remember(null);
      history.replaceState(null, '', '/');
      return { screen: 'pick', user };
    }
    remember(workspace.id);
    if (!wanted) history.replaceState(null, '', `/w/${workspace.id}${location.hash}`);
    const { settings } = await api<{ settings: Record<string, unknown> }>('GET', '/api/settings');
    keepBoot({ user, workspaces, settings });
    return { screen: 'app', user, workspace, settings, offline: await openOffline(workspace.id) };
  } catch (error) {
    // No server: the workspace as it was last seen here, if it was.
    if (error instanceof ApiError && error.status === 0) {
      const boot = keptBoot();
      const id = workspaceFromPath() ?? lastWorkspace();
      const workspace = boot?.workspaces.find((w) => w.id === id);
      if (boot && workspace) {
        if (!workspaceFromPath())
          history.replaceState(null, '', `/w/${workspace.id}${location.hash}`);
        return {
          screen: 'app',
          user: boot.user,
          workspace,
          settings: boot.settings,
          offline: await openOffline(workspace.id),
        };
      }
    }
    return { screen: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

type Offline = { store: OfflineStore | null; scopes: ScopeInfo[] | null };

async function openOffline(workspaceId: string): Promise<Offline> {
  const store = await OfflineStore.open(workspaceId);
  const scopes = (await store?.get<ScopeInfo[]>('scopes').catch(() => null)) ?? null;
  return { store, scopes };
}

function Root() {
  const [state, setState] = useState<State>({ screen: 'loading' });

  useEffect(() => {
    void resolveState().then(setState);
  }, []);

  switch (state.screen) {
    case 'loading':
      return (
        <div className="flex min-h-screen items-center justify-center bg-surface">
          <Loader2 className="animate-spin text-muted" />
        </div>
      );
    case 'sign-in':
      return <SignIn onSignedIn={() => void resolveState().then(setState)} />;
    case 'invite':
      return (
        <InviteScreen
          token={state.token}
          invite={state.invite}
          user={state.user}
          onSignedIn={() => void resolveState().then(setState)}
          onSignOut={() => {
            void api('POST', '/api/auth/logout', {})
              .catch(() => {})
              .then(() => resolveState().then(setState));
          }}
        />
      );
    case 'link':
      return (
        <ShareLinkScreen
          token={state.token}
          link={state.link}
          problem={state.problem}
          user={state.user}
        />
      );
    case 'pick':
      return (
        <WorkspacePicker
          email={state.user.email}
          onSignOut={() => void signOut()}
          onOpen={(w) => {
            remember(w.id);
            location.assign(`/w/${w.id}`);
          }}
        />
      );
    case 'error':
      return (
        <Card title="Something went wrong">
          <p className="text-sm text-danger">{state.message}</p>
        </Card>
      );
    case 'app':
      return (
        <Workspace
          user={state.user}
          workspace={state.workspace}
          settings={state.settings}
          offline={state.offline}
        />
      );
  }
}

function Workspace({
  user,
  workspace,
  settings,
  offline: kept,
}: {
  user: Me;
  workspace: RemoteWorkspace;
  settings: Record<string, unknown>;
  offline: Offline;
}) {
  const host = useMemo(
    () =>
      createWebPlatform({
        workspace,
        user,
        settings,
        account: {
          switchWorkspace: () => location.assign('/?choose'),
          signOut: () => void signOut(),
        },
        offline: kept,
      }),
    [workspace, user, settings, kept],
  );
  const [status, setStatus] = useState<{ sync: SyncStatus; unsent: number }>({
    sync: host.client.state,
    unsent: 0,
  });
  useEffect(() => {
    const off = host.client.onStatus((sync, unsent) => setStatus({ sync, unsent }));
    host.client.start();
    return () => {
      off();
      host.client.stop();
    };
  }, [host]);
  useEffect(() => {
    document.title = `${workspace.name} · Workspace`;
    // Edits not yet on the server are kept in this browser; where it can't keep them (no
    // IndexedDB), they live only in this tab: warn before it's closed.
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!kept.store && host.client.unsent > 0) event.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [host, workspace.name, kept.store]);
  useEffect(() => {
    if (status.sync.state === 'unauthorized') location.assign('/');
  }, [status.sync.state]);

  const offline = status.sync.state === 'offline' || status.sync.state === 'error';
  return (
    <>
      <App platform={host.platform} />
      {offline && (
        <div
          role="status"
          data-testid="offline-banner"
          className="fixed right-4 bottom-4 z-50 flex items-center gap-2 rounded-lg bg-menu px-3 py-2 text-sm text-fg shadow-menu"
        >
          <CloudOff size={14} className="text-warning" />
          <span>
            {status.sync.state === 'error'
              ? status.sync.reason
              : status.unsent > 0
                ? kept.store
                  ? `Offline · ${status.unsent} change${status.unsent === 1 ? '' : 's'} kept here, sent when you’re back.`
                  : `Offline · ${status.unsent} unsaved change${status.unsent === 1 ? '' : 's'}. Keep this tab open.`
                : 'Offline · reconnecting…'}
          </span>
          {status.sync.state === 'offline' && (
            <button
              type="button"
              className="rounded px-2 py-0.5 text-xs hover:bg-hover"
              onClick={() => host.client.retryNow()}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </>
  );
}

// Keeps the app's own files, so it opens offline (production builds; dev serves them live).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
