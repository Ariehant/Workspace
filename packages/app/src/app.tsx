import {
  DocClient,
  WORKSPACE_DOC_ID,
  buildPageTree,
  createPage,
  getAncestorIds,
  getPage,
  listPages,
  movePage,
  trashPage,
  type PageId,
  type PageTreeNode,
} from '@workspace/core';
import { useAppliedTheme, type ThemePreference } from '@workspace/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { AppContext } from './context';
import { useDoc, useDocVersion } from './hooks';
import { PageView } from './page-view';
import type { Platform } from './platform';
import { Sidebar } from './sidebar';
import { MoveDialog } from './move-dialog';
import { duplicatePage } from './page-actions';
import { createWelcomePage } from './welcome';

const SETTING = {
  theme: 'ui.theme',
  lastPage: 'ui.lastPageId',
  expanded: 'ui.expanded',
  sidebarOpen: 'ui.sidebarOpen',
  onboarded: 'app.onboarded',
} as const;

interface Settings {
  theme: ThemePreference;
  lastPage: PageId | null;
  expanded: PageId[];
  sidebarOpen: boolean;
  onboarded: boolean;
}

async function loadSettings(platform: Platform): Promise<Settings> {
  const [theme, lastPage, expanded, sidebarOpen, onboarded] = await Promise.all([
    platform.getSetting<ThemePreference>(SETTING.theme),
    platform.getSetting<PageId>(SETTING.lastPage),
    platform.getSetting<PageId[]>(SETTING.expanded),
    platform.getSetting<boolean>(SETTING.sidebarOpen),
    platform.getSetting<boolean>(SETTING.onboarded),
  ]);
  return {
    theme: theme ?? 'system',
    lastPage: lastPage ?? null,
    expanded: expanded ?? [],
    sidebarOpen: sidebarOpen ?? true,
    onboarded: onboarded ?? false,
  };
}

export function App({ platform }: { platform: Platform }) {
  const client = useMemo(() => new DocClient(platform.transport), [platform]);
  useEffect(() => () => client.destroy(), [client]);
  const workspace = useDoc(client, WORKSPACE_DOC_ID);
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    loadSettings(platform).then(setSettings, (error: unknown) => {
      console.error('Failed to load settings', error);
    });
  }, [platform]);

  if (!workspace || !settings) return null;
  return (
    <AppContext.Provider value={{ platform, client, workspace }}>
      <Shell platform={platform} client={client} workspace={workspace} initial={settings} />
    </AppContext.Provider>
  );
}

interface ShellProps {
  platform: Platform;
  client: DocClient;
  workspace: Y.Doc;
  initial: Settings;
}

function firstPage(tree: PageTreeNode[]): PageId | null {
  return tree[0]?.page.id ?? null;
}

function Shell({ platform, client, workspace, initial }: ShellProps) {
  const version = useDocVersion(workspace);
  // `version` changes whenever the workspace doc does, which is what invalidates the tree.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tree = useMemo(() => buildPageTree(listPages(workspace)), [workspace, version]);

  const [theme, setTheme] = useState(initial.theme);
  const [selected, setSelected] = useState<PageId | null>(initial.lastPage);
  const [expanded, setExpanded] = useState<ReadonlySet<PageId>>(() => new Set(initial.expanded));
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen);
  useAppliedTheme(theme);

  // Fall back to the first page when the remembered one no longer exists.
  const currentPageId = selected && getPage(workspace, selected) ? selected : firstPage(tree);

  useEffect(() => platform.setTheme(theme), [platform, theme]);
  useEffect(() => platform.setSetting(SETTING.lastPage, currentPageId), [platform, currentPageId]);
  useEffect(() => platform.setSetting(SETTING.expanded, [...expanded]), [platform, expanded]);
  useEffect(() => platform.setSetting(SETTING.sidebarOpen, sidebarOpen), [platform, sidebarOpen]);

  const onboarding = useRef(false);
  useEffect(() => {
    if (initial.onboarded || onboarding.current || listPages(workspace).length > 0) {
      platform.ready();
      return;
    }
    onboarding.current = true;
    createWelcomePage(client, workspace)
      .then((id) => {
        platform.setSetting(SETTING.onboarded, true);
        setSelected(id);
      })
      .catch((error: unknown) => console.error('Failed to create welcome page', error))
      .finally(() => platform.ready());
  }, [client, platform, workspace, initial.onboarded]);

  const navigate = useCallback(
    (id: PageId) => {
      setSelected(id);
      // Reveal the page in the sidebar.
      const ancestors = getAncestorIds(workspace, id);
      if (ancestors.length > 0) setExpanded((prev) => new Set([...prev, ...ancestors]));
    },
    [workspace],
  );

  const create = useCallback(
    (parentId: PageId | null) => {
      const id = createPage(workspace, { parentId });
      navigate(id);
    },
    [workspace, navigate],
  );

  const toggle = useCallback((id: PageId) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const trash = useCallback((id: PageId) => trashPage(workspace, id), [workspace]);

  const duplicate = useCallback(
    (id: PageId) => {
      duplicatePage(client, workspace, id).then(navigate, (error: unknown) =>
        console.error('Failed to duplicate page', error),
      );
    },
    [client, workspace, navigate],
  );

  const [moving, setMoving] = useState<PageId | null>(null);

  const changeTheme = useCallback(
    (next: ThemePreference) => {
      setTheme(next);
      platform.setSetting(SETTING.theme, next);
    },
    [platform],
  );

  // Shortcuts that work in the desktop and web builds alike.
  useEffect(() => {
    const run = (command: 'new-page' | 'toggle-sidebar') => {
      if (command === 'new-page') create(null);
      else setSidebarOpen((open) => !open);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      if (event.key === 'n') run('new-page');
      else if (event.key === '\\') run('toggle-sidebar');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    const unsubscribe = platform.onCommand(run);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      unsubscribe();
    };
  }, [platform, create]);

  useEffect(
    () => platform.onNavigate((id) => getPage(workspace, id) && navigate(id)),
    [platform, workspace, navigate],
  );

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <Sidebar
          tree={tree}
          currentPageId={currentPageId}
          expanded={expanded}
          theme={theme}
          onSelect={navigate}
          onToggle={toggle}
          onCreate={create}
          onTrash={trash}
          onDuplicate={duplicate}
          onMove={setMoving}
          fileUrl={platform.fileUrl}
          onThemeChange={changeTheme}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      {currentPageId ? (
        <PageView
          pageId={currentPageId}
          sidebarOpen={sidebarOpen}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNavigate={navigate}
          onDuplicate={duplicate}
          onMove={setMoving}
          onTrash={trash}
        />
      ) : (
        <EmptyState onCreate={() => create(null)} />
      )}
      {moving && getPage(workspace, moving) && (
        <MoveDialog
          workspace={workspace}
          pageId={moving}
          fileUrl={platform.fileUrl}
          onMove={(parentId) => {
            movePage(workspace, moving, { parentId });
            navigate(moving);
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate(): void }) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 text-muted">
      <p>No pages yet.</p>
      <button
        type="button"
        onClick={onCreate}
        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
      >
        Create a page
      </button>
    </main>
  );
}
