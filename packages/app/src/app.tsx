import {
  DocClient,
  WORKSPACE_DOC_ID,
  buildPageTree,
  EMPTY_HISTORY,
  TRASH_RETENTION_MS,
  createPage,
  emptyTrashBefore,
  getAncestorIds,
  getPage,
  listPages,
  movePage,
  pushHistory,
  resolveDrop,
  stepHistory,
  trashPage,
  type DropZone,
  type NavHistory,
  type PageId,
  type PageTreeNode,
} from '@workspace/core';
import { useAppliedTheme, type ThemePreference } from '@workspace/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { AppContext } from './context';
import { useDoc, useDocVersion } from './hooks';
import { PageView } from './page-view';
import type { AppCommand, Platform } from './platform';
import { QuickFind } from './quick-find';
import { SIDEBAR_WIDTH, Sidebar } from './sidebar';
import { MoveDialog } from './move-dialog';
import { duplicatePage } from './page-actions';
import { createWelcomePage } from './welcome';

const SETTING = {
  theme: 'ui.theme',
  lastPage: 'ui.lastPageId',
  expanded: 'ui.expanded',
  sidebarOpen: 'ui.sidebarOpen',
  sidebarWidth: 'ui.sidebarWidth',
  favorites: 'ui.favorites',
  recent: 'ui.recent',
  onboarded: 'app.onboarded',
} as const;

interface Settings {
  theme: ThemePreference;
  lastPage: PageId | null;
  expanded: PageId[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  favorites: PageId[];
  recent: PageId[];
  onboarded: boolean;
}

async function loadSettings(platform: Platform): Promise<Settings> {
  const get = <T,>(key: string) => platform.getSetting<T>(key);
  const [theme, lastPage, expanded, sidebarOpen, sidebarWidth, favorites, recent, onboarded] =
    await Promise.all([
      get<ThemePreference>(SETTING.theme),
      get<PageId>(SETTING.lastPage),
      get<PageId[]>(SETTING.expanded),
      get<boolean>(SETTING.sidebarOpen),
      get<number>(SETTING.sidebarWidth),
      get<PageId[]>(SETTING.favorites),
      get<PageId[]>(SETTING.recent),
      get<boolean>(SETTING.onboarded),
    ]);
  return {
    theme: theme ?? 'system',
    lastPage: lastPage ?? null,
    expanded: expanded ?? [],
    sidebarOpen: sidebarOpen ?? true,
    sidebarWidth: sidebarWidth ?? SIDEBAR_WIDTH.default,
    favorites: favorites ?? [],
    recent: recent ?? [],
    onboarded: onboarded ?? false,
  };
}

const MAX_RECENT = 20;

/** Page a window was opened on (`#page=<id>`), e.g. by "Open in new window". */
function pageFromLocation(): PageId | null {
  return new URLSearchParams(window.location.hash.slice(1)).get('page');
}

/** A block to scroll to once its page is showing. `nonce` repeats the same request. */
export interface BlockTarget {
  pageId: PageId;
  blockId: string;
  nonce: number;
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
  const exists = useCallback((id: PageId) => getPage(workspace, id) !== null, [workspace]);

  const [theme, setTheme] = useState(initial.theme);
  const [history, setHistory] = useState<NavHistory>(() => {
    const start = pageFromLocation() ?? initial.lastPage;
    return start ? pushHistory(EMPTY_HISTORY, start) : EMPTY_HISTORY;
  });
  const [recent, setRecent] = useState<PageId[]>(initial.recent);
  const [favorites, setFavorites] = useState<PageId[]>(initial.favorites);
  const [expanded, setExpanded] = useState<ReadonlySet<PageId>>(() => new Set(initial.expanded));
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth);
  const [finding, setFinding] = useState(false);
  const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
  useAppliedTheme(theme);

  // Fall back to the first page when the remembered one no longer exists.
  const selected = history.entries[history.index] ?? null;
  const currentPageId = selected && exists(selected) ? selected : firstPage(tree);

  useEffect(() => platform.setTheme(theme), [platform, theme]);
  useEffect(() => platform.setSetting(SETTING.lastPage, currentPageId), [platform, currentPageId]);
  useEffect(() => platform.setSetting(SETTING.expanded, [...expanded]), [platform, expanded]);
  useEffect(() => platform.setSetting(SETTING.sidebarOpen, sidebarOpen), [platform, sidebarOpen]);
  useEffect(() => platform.setSetting(SETTING.favorites, favorites), [platform, favorites]);
  useEffect(() => platform.setSetting(SETTING.recent, recent), [platform, recent]);
  useEffect(() => {
    // Resizing changes the width on every pointer move; save once it settles.
    const timer = setTimeout(() => platform.setSetting(SETTING.sidebarWidth, sidebarWidth), 300);
    return () => clearTimeout(timer);
  }, [platform, sidebarWidth]);

  // Pages left in the trash for 30 days are deleted for good.
  useEffect(() => {
    emptyTrashBefore(workspace, Date.now() - TRASH_RETENTION_MS);
  }, [workspace]);

  /** Show a page: the sidebar reveals it and it goes to the top of the recents. */
  const show = useCallback(
    (id: PageId) => {
      const ancestors = getAncestorIds(workspace, id);
      if (ancestors.length > 0) setExpanded((prev) => new Set([...prev, ...ancestors]));
      setRecent((prev) => [id, ...prev.filter((r) => r !== id)].slice(0, MAX_RECENT));
    },
    [workspace],
  );

  const navigate = useCallback(
    (id: PageId) => {
      setHistory((prev) => pushHistory(prev, id));
      show(id);
    },
    [show],
  );

  const go = useCallback(
    (direction: -1 | 1) => {
      const next = stepHistory(history, direction, exists);
      if (!next) return;
      setHistory(next);
      show(next.entries[next.index]!);
    },
    [history, exists, show],
  );

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
        navigate(id);
      })
      .catch((error: unknown) => console.error('Failed to create welcome page', error))
      .finally(() => platform.ready());
  }, [client, platform, workspace, initial.onboarded, navigate]);

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

  const drop = useCallback(
    (id: PageId, targetId: PageId | null, zone: DropZone) => {
      const target = targetId ? resolveDrop(workspace, id, targetId, zone) : { parentId: null };
      if (!target) return;
      movePage(workspace, id, target);
      if (target.parentId) setExpanded((prev) => new Set([...prev, target.parentId!]));
    },
    [workspace],
  );

  const toggleFavorite = useCallback((id: PageId) => {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]));
  }, []);

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
    const run = (command: AppCommand) => {
      if (command === 'new-page') create(null);
      else if (command === 'toggle-sidebar') setSidebarOpen((open) => !open);
      else if (command === 'quick-find') setFinding(true);
      else go(command === 'go-back' ? -1 : 1);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === 'ArrowLeft') run('go-back');
        else if (event.key === 'ArrowRight') run('go-forward');
        else return;
        event.preventDefault();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'n') run('new-page');
      else if (key === '\\') run('toggle-sidebar');
      else if (key === 'k' || key === 'p') run('quick-find');
      else return;
      event.preventDefault();
    };
    // The mouse's back and forward buttons.
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) run('go-back');
      else if (event.button === 4) run('go-forward');
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mouseup', onMouseUp);
    const unsubscribe = platform.onCommand(run);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mouseup', onMouseUp);
      unsubscribe();
    };
  }, [platform, create, go]);

  // Links (workspace://page/…) and reminder notifications.
  const nonce = useRef(0);
  useEffect(
    () =>
      platform.onNavigate((pageId, blockId) => {
        if (!exists(pageId)) return;
        navigate(pageId);
        if (blockId) setBlockTarget({ pageId, blockId, nonce: ++nonce.current });
      }),
    [platform, exists, navigate],
  );

  return (
    <div className="flex h-full">
      {sidebarOpen && (
        <Sidebar
          workspace={workspace}
          tree={tree}
          favorites={favorites}
          width={sidebarWidth}
          currentPageId={currentPageId}
          expanded={expanded}
          theme={theme}
          onSelect={navigate}
          onToggle={toggle}
          onCreate={create}
          onTrash={trash}
          onDuplicate={duplicate}
          onMove={setMoving}
          onDrop={drop}
          onToggleFavorite={toggleFavorite}
          onSearch={() => setFinding(true)}
          onResize={setSidebarWidth}
          fileUrl={platform.fileUrl}
          onThemeChange={changeTheme}
          onCollapse={() => setSidebarOpen(false)}
        />
      )}
      {currentPageId ? (
        <PageView
          pageId={currentPageId}
          sidebarOpen={sidebarOpen}
          canGoBack={stepHistory(history, -1, exists) !== null}
          canGoForward={stepHistory(history, 1, exists) !== null}
          onGo={go}
          blockTarget={blockTarget?.pageId === currentPageId ? blockTarget : null}
          onOpenSidebar={() => setSidebarOpen(true)}
          onNavigate={navigate}
          onDuplicate={duplicate}
          onMove={setMoving}
          onTrash={trash}
          isFavorite={favorites.includes(currentPageId)}
          onToggleFavorite={() => toggleFavorite(currentPageId)}
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
      {finding && (
        <QuickFind
          workspace={workspace}
          platform={platform}
          recent={recent}
          onOpen={navigate}
          onOpenInWindow={(id) => platform.openWindow(id)}
          onClose={() => setFinding(false)}
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
