import {
  DocClient,
  MEMBERS_DOC_ID,
  type NotificationData,
  buildPageTree,
  TRASH_RETENTION_MS,
  createPage,
  emptyTrashBefore,
  getAncestorIds,
  getPage,
  listPages,
  closeTab,
  cycleTab,
  moveTab,
  movePage,
  openTab,
  parseTabs,
  pushHistory,
  resolveDrop,
  stepHistory,
  tabsWith,
  trashPage,
  updateActiveTab,
  type DropZone,
  type NavHistory,
  type PageId,
  type PageTreeNode,
  type TabsState,
  type User,
  upsertUser,
  workspaceDataDoc,
  presenceColor,
  roleAllows,
  ScopeMoveError,
  type Forest,
  type MovePageTarget,
  REGION_SETTING,
  resolveRegion,
  setRegion,
  type RegionSettings,
} from '@workspace/core';
import type { OpenPagesIn } from '@workspace/database';
import { useAppliedTheme, type ThemePreference } from '@workspace/ui';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppContext, useApp } from './context';
import { DatabaseRegistry } from './database/registry';
import { useRegistryVersion } from './database/hooks';
import { RowPageView, RowPeek } from './database/row-page';
import { NavigationContext, type Navigation } from './navigation';
import { Home } from './home';
import { PeopleView } from './people-view';
import { NoAccess } from './no-access';
import { PageDirectory } from './pages';
import { useForest } from './forest';
import { PresenceHub, usePageViewers } from './presence';
import { moveAcrossScopes, scopeOfDoc } from './scope-actions';
import { buildSections } from './sections';
import { ShareDialog } from './share-dialog';
import {
  BrowseTeamspacesDialog,
  NewTeamspaceDialog,
  TeamspaceSettingsDialog,
} from './teamspace-dialogs';
import { useDoc, useDocVersion } from './hooks';
import { PageView } from './page-view';
import { can, type AppCommand, type Platform } from './platform';
import { QuickFind } from './quick-find';
import { ButtonEditorHost } from './buttons/button-dialog';
import { SIDEBAR_WIDTH, Sidebar } from './sidebar';
import { MoveDialog } from './move-dialog';
import { duplicatePage } from './page-actions';
import { SyncDialog, useSyncInfo } from './sync-settings';
import { MembersDialog, ProfileDialog } from './members-dialog';
import { useTeam } from './team';
import { InboxButton, useInbox } from './inbox';
import { requestThread } from './comments';
import { createWelcomePage } from './welcome';
import { TabBar } from './tab-bar';
import { useNewTabIntent, useTabScroll } from './tabs';
import { TemplatesGallery } from './templates/gallery';
import { saveAsTemplate } from './templates/store';
import { ExportDialog, ExportProgress, useDiagramProvider } from './export-dialog';
import { PrintView, printFromLocation } from './print-view';
import { ImportProgress } from './import-dialog';
import { RegionDialog } from './region-dialog';
import { AboutDialog, useUpdates } from './about-dialog';
import { ShortcutsDialog } from './shortcuts-dialog';

const SETTING = {
  theme: 'ui.theme',
  lastPage: 'ui.lastPageId',
  tabs: 'ui.tabs',
  expanded: 'ui.expanded',
  sidebarOpen: 'ui.sidebarOpen',
  sidebarWidth: 'ui.sidebarWidth',
  favorites: 'ui.favorites',
  recent: 'ui.recent',
  onboarded: 'app.onboarded',
  region: REGION_SETTING,
} as const;

interface Settings {
  theme: ThemePreference;
  lastPage: PageId | null;
  tabs: TabsState | null;
  expanded: PageId[];
  sidebarOpen: boolean;
  sidebarWidth: number;
  favorites: PageId[];
  recent: PageId[];
  onboarded: boolean;
  region: RegionSettings;
}

async function loadSettings(platform: Platform): Promise<Settings> {
  const get = <T,>(key: string) => platform.getSetting<T>(key);
  const [
    theme,
    lastPage,
    tabs,
    expanded,
    sidebarOpen,
    sidebarWidth,
    favorites,
    recent,
    onboarded,
    region,
  ] = await Promise.all([
    get<ThemePreference>(SETTING.theme),
    get<PageId>(SETTING.lastPage),
    get<unknown>(SETTING.tabs),
    get<PageId[]>(SETTING.expanded),
    get<boolean>(SETTING.sidebarOpen),
    get<number>(SETTING.sidebarWidth),
    get<PageId[]>(SETTING.favorites),
    get<PageId[]>(SETTING.recent),
    get<boolean>(SETTING.onboarded),
    get<RegionSettings>(SETTING.region),
  ]);
  // Formats are global: set before anything renders a date.
  setRegion(resolveRegion(region ?? {}));
  return {
    theme: theme ?? 'system',
    lastPage: lastPage ?? null,
    tabs: parseTabs(tabs),
    expanded: expanded ?? [],
    sidebarOpen: sidebarOpen ?? true,
    sidebarWidth: sidebarWidth ?? SIDEBAR_WIDTH.default,
    favorites: favorites ?? [],
    recent: recent ?? [],
    onboarded: onboarded ?? false,
    region: region ?? {},
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
  const workspace = useForest(client, platform);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [user, setUser] = useState<User | null>(null);
  // A window that only renders a page for printing (PDF export), always in light colors.
  const [print] = useState(printFromLocation);
  useEffect(() => {
    if (print) document.documentElement.dataset.theme = 'light';
  }, [print]);

  useEffect(() => {
    loadSettings(platform).then(setSettings, (error: unknown) => {
      console.error('Failed to load settings', error);
    });
    const loadUser = () =>
      platform.getUser().then(
        (next) =>
          setUser((current) =>
            current?.id === next.id && current.name === next.name ? current : next,
          ),
        (error: unknown) => console.error('Failed to load the user', error),
      );
    void loadUser();
    // Signing in (or out) on the desktop changes who the person is: the account's id
    // is the one the server knows them by (comments are checked against it).
    let account: string | null | undefined;
    return platform.sync?.onChange((info) => {
      const next = info.mode === 'on' ? (info.account?.email ?? null) : null;
      if (next !== account) void loadUser();
      account = next;
    });
  }, [platform]);

  const members = useDoc(client, MEMBERS_DOC_ID);
  const team = useTeam(platform, useSyncInfo(platform.sync));
  const base = useMemo(() => {
    if (!workspace || !user) return null;
    const databases = new DatabaseRegistry(client, platform, workspace);
    return {
      platform,
      client,
      workspace,
      user,
      databases,
      pages: new PageDirectory(workspace, databases),
    };
  }, [platform, client, workspace, user]);
  useEffect(() => () => base?.databases.destroy(), [base]);
  // Hosts that place new docs themselves learn from the trees where each one goes.
  useEffect(() => {
    const scopes = platform.scopes;
    if (!base || !scopes?.setResolver) return;
    scopes.setResolver((docId) => scopeOfDoc(base.workspace, base.pages, docId));
    return () => scopes.setResolver?.(null);
  }, [platform, base]);
  const presence = useMemo(
    () =>
      user
        ? new PresenceHub(client, { id: user.id, name: user.name, color: presenceColor(user.id) })
        : null,
    [client, user],
  );
  const context = useMemo(
    () => (base ? { ...base, members, presence, team } : null),
    [base, members, presence, team],
  );
  if (!workspace || !settings || !context) return null;
  if (print) {
    return (
      <AppContext.Provider value={context}>
        <PrintView pageId={print.pageId} subpages={print.subpages} />
      </AppContext.Provider>
    );
  }
  return (
    <AppContext.Provider value={context}>
      <Shell platform={platform} client={client} workspace={workspace} initial={settings} />
    </AppContext.Provider>
  );
}

interface ShellProps {
  platform: Platform;
  client: DocClient;
  workspace: Forest;
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
  const sections = useMemo(() => buildSections(workspace, tree), [workspace, tree]);
  /** The workspace is on a server (its pages are in scopes: teamspaces, private, shared). */
  const scoped = sections.some((s) => s.kind !== 'local');
  const { databases, pages, user, team } = useApp();
  const syncInfo = useSyncInfo(platform.sync);
  const inbox = useInbox(team ? (platform.team ?? null) : null, platform.notifications);
  // Rows of databases loading in, found through links or history.
  const registryVersion = useRegistryVersion();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const exists = useCallback((id: PageId) => pages.exists(id), [pages, registryVersion]);

  const [theme, setTheme] = useState(initial.theme);
  // A window opened on a page (`#page=`) starts with that one tab; the main window
  // gets back the tabs it had.
  const [ownWindow] = useState(() => pageFromLocation());
  const [tabs, setTabs] = useState<TabsState>(() =>
    ownWindow ? tabsWith(ownWindow) : (initial.tabs ?? tabsWith(initial.lastPage)),
  );
  const history = tabs.tabs[tabs.active]!.history;
  const setHistory = useCallback(
    (next: NavHistory) => setTabs((prev) => updateActiveTab(prev, () => next)),
    [],
  );
  const [recent, setRecent] = useState<PageId[]>(initial.recent);
  const [favorites, setFavorites] = useState<PageId[]>(initial.favorites);
  const [expanded, setExpanded] = useState<ReadonlySet<PageId>>(() => new Set(initial.expanded));
  const [sidebarOpen, setSidebarOpen] = useState(initial.sidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth);
  const [finding, setFinding] = useState(false);
  // Home and People are shown over the tab's page (they aren't pages in the history).
  const [screen, setScreen] = useState<'home' | 'people' | null>(null);
  const [templates, setTemplates] = useState(false);
  // The export dialog: for a page, or (null) the whole workspace.
  const [exporting, setExporting] = useState<PageId | null | undefined>(undefined);
  useDiagramProvider(platform);
  const [blockTarget, setBlockTarget] = useState<BlockTarget | null>(null);
  const [peek, setPeek] = useState<{
    rowId: string;
    databaseId: string;
    mode: Exclude<OpenPagesIn, 'fullPage'>;
  } | null>(null);
  /**
   * A page asked for that isn't here (no access, or gone): the no-access screen. `n` counts
   * the times it was asked for, so asking again looks again.
   */
  const [missingPage, setMissingPage] = useState<{ id: PageId; n: number } | null>(null);
  const missing = missingPage?.id ?? null;
  const setMissing = useCallback(
    (id: PageId | null) => setMissingPage((m) => (id ? { id, n: (m?.n ?? 0) + 1 } : null)),
    [],
  );
  const appliedTheme = useAppliedTheme(theme);

  // Fall back to the first page when the remembered one no longer exists.
  const selected = history.entries[history.index] ?? null;
  // A row not loaded yet is looked up first (`exists` starts that) before falling back.
  const pending = selected !== null && !exists(selected) && databases.isLocating(selected);
  const currentPageId = selected && (exists(selected) || pending) ? selected : firstPage(tree);
  // Who else is viewing which page (a dot in the sidebar).
  const viewers = usePageViewers(workspace, currentPageId);

  useEffect(() => platform.setTheme(theme), [platform, theme]);
  useEffect(() => platform.setSetting(SETTING.lastPage, currentPageId), [platform, currentPageId]);
  useEffect(() => {
    if (ownWindow) return;
    const saved = { tabs: tabs.tabs.map((t) => ({ history: t.history })), active: tabs.active };
    platform.setSetting(SETTING.tabs, saved);
  }, [platform, ownWindow, tabs]);
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

  // Ctrl+click (or middle-click) on whatever navigates opens the page in a new tab.
  const newTabIntent = useNewTabIntent();
  const scroll = useTabScroll(tabs);

  const navigate = useCallback(
    (id: PageId) => {
      if (newTabIntent.take()) {
        scroll.save();
        setTabs((prev) => openTab(prev, id));
      } else {
        setTabs((prev) => updateActiveTab(prev, (h) => pushHistory(h, id)));
      }
      setPeek(null);
      setMissing(null);
      setScreen(null);
      show(id);
    },
    [show, newTabIntent, scroll, setMissing],
  );

  const tabPage = useCallback(
    (index: number) => {
      const h = tabs.tabs[index]?.history;
      const id = h?.entries[h.index] ?? null;
      return id && exists(id) ? id : firstPage(tree);
    },
    [tabs, exists, tree],
  );
  const changeTabs = useCallback(
    (update: (prev: TabsState) => TabsState) => {
      scroll.save();
      setPeek(null);
      setScreen(null);
      setTabs(update);
    },
    [scroll],
  );
  const selectTab = useCallback(
    (index: number) => changeTabs((prev) => ({ ...prev, active: index })),
    [changeTabs],
  );
  const closeTabAt = useCallback(
    (index: number) => changeTabs((prev) => closeTab(prev, index)),
    [changeTabs],
  );
  const newTab = useCallback(() => {
    changeTabs((prev) => openTab(prev, null));
    setFinding(true);
  }, [changeTabs]);
  const detachTab = useCallback(
    (index: number) => {
      const id = tabPage(index);
      if (!id || tabs.tabs.length <= 1) return;
      platform.openWindow(id);
      closeTabAt(index);
    },
    [platform, tabPage, tabs.tabs.length, closeTabAt],
  );

  const blockNonce = useRef(0);
  const go = useCallback(
    (direction: -1 | 1) => {
      // Back from Home or People, or from a page that can't be shown, is the page it was
      // opened over.
      if (screen || missing) {
        if (direction === -1) {
          setScreen(null);
          setMissing(null);
        }
        return;
      }
      const next = stepHistory(history, direction, exists);
      if (!next) return;
      setHistory(next);
      setMissing(null);
      show(next.entries[next.index]!);
    },
    [screen, missing, history, exists, show, setHistory, setMissing],
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
    (parentId: PageId | null, tree?: string) => {
      let id: PageId;
      try {
        id = createPage(workspace, { parentId, tree, createdBy: user.id });
      } catch (error) {
        // No section this person can add pages to.
        console.error('Could not create the page', error);
        return;
      }
      navigate(id);
    },
    [workspace, navigate, user.id],
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
      duplicatePage(client, workspace, id, user.id).then(navigate, (error: unknown) =>
        console.error('Failed to duplicate page', error),
      );
    },
    [client, workspace, navigate, user.id],
  );

  const saveTemplate = useCallback(
    (id: PageId) => {
      saveAsTemplate(client, workspace, id).catch((error: unknown) =>
        console.error('Failed to save the template', error),
      );
    },
    [client, workspace],
  );

  /**
   * Move a page; to another section (another scope), the server moves it, once confirmed:
   * who can see it changes.
   */
  const moveTo = useCallback(
    (id: PageId, target: MovePageTarget) => {
      try {
        movePage(workspace, id, target);
        if (target.parentId) setExpanded((prev) => new Set([...prev, target.parentId!]));
      } catch (error) {
        if (!(error instanceof ScopeMoveError)) throw error;
        void moveAcrossScopes(workspace, team, error);
      }
    },
    [workspace, team],
  );

  const drop = useCallback(
    (id: PageId, targetId: PageId | null, zone: DropZone, tree?: string) => {
      const target = targetId
        ? resolveDrop(workspace, id, targetId, zone)
        : { parentId: null, ...(tree ? { tree } : {}) };
      if (!target) return;
      moveTo(id, target);
    },
    [workspace, moveTo],
  );

  const toggleFavorite = useCallback((id: PageId) => {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]));
  }, []);

  const [moving, setMoving] = useState<PageId | null>(null);
  const [sharing, setSharing] = useState<PageId | null>(null);
  /** Teamspace dialogs: new, browse, or one's settings (its scope id). */
  const [teamspaceDialog, setTeamspaceDialog] = useState<
    { kind: 'new' } | { kind: 'browse' } | { kind: 'settings'; scopeId: string } | null
  >(null);
  const leaveTeamspace = useCallback(
    (scopeId: string) => {
      const name = workspace.byScope(scopeId)?.info.name ?? 'this teamspace';
      if (!team || !window.confirm(`Leave ${name}? Its pages leave your sidebar.`)) return;
      team
        .leaveTeamspace(scopeId)
        .catch((error: unknown) =>
          window.alert(error instanceof Error ? error.message : String(error)),
        );
    },
    [team, workspace],
  );
  // Teamspace icons come from the server (sync carries names and roles only).
  const [teamspaceIcons, setTeamspaceIcons] = useState<ReadonlyMap<string, string>>(new Map());
  const teamspaceKey = sections
    .filter((s) => s.kind === 'teamspace')
    .map((s) => s.scope)
    .join();
  useEffect(() => {
    if (!team || !teamspaceKey || teamspaceDialog) return;
    let alive = true;
    team.teamspaces().then(
      ({ teamspaces }) =>
        alive &&
        setTeamspaceIcons(new Map(teamspaces.flatMap((t) => (t.icon ? [[t.id, t.icon]] : [])))),
      () => {},
    );
    return () => {
      alive = false;
    };
    // Again after a teamspace dialog closes (its icon may have changed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, teamspaceKey, teamspaceDialog === null]);
  const [syncOpen, setSyncOpen] = useState(false);
  // Keep the user's name current in a local workspace (created by / person values show
  // it). A server workspace has its members doc for names, and its page tree may not be
  // the user's to change (the server would refuse it, and send its copy back).
  const local = !platform.team || (!!platform.sync && !!syncInfo && syncInfo.mode !== 'on');
  useEffect(() => {
    if (local) upsertUser(workspaceDataDoc(workspace), user);
  }, [local, workspace, user]);
  const [peopleOpen, setPeopleOpen] = useState<'members' | 'profile' | null>(null);

  // Language and region: the formats change at once (everything re-renders from here).
  const [regionSettings, setRegionSettings] = useState(initial.region);
  const [regionOpen, setRegionOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const updates = useUpdates(platform.about?.updates);
  const changeRegion = useCallback(
    (next: RegionSettings) => {
      setRegion(resolveRegion(next));
      setRegionSettings(next);
      platform.setSetting(SETTING.region, next);
    },
    [platform],
  );

  const changeTheme = useCallback(
    (next: ThemePreference) => {
      setTheme(next);
      platform.setSetting(SETTING.theme, next);
    },
    [platform],
  );

  // What those shortcuts need from this render (read when the key is pressed).
  const keys = useRef({ toParent: () => {}, toggleTheme: () => {} });
  useLayoutEffect(() => {
    keys.current = {
      toParent: () => {
        const crumbs = pages.breadcrumb(currentPageId ?? '');
        const parent = crumbs[crumbs.length - 2];
        if (parent) navigate(parent.id);
      },
      toggleTheme: () => changeTheme(appliedTheme === 'dark' ? 'light' : 'dark'),
    };
  });

  // Shortcuts that work in the desktop and web builds alike.
  useEffect(() => {
    const run = (command: AppCommand) => {
      if (command === 'new-page') create(null);
      else if (command === 'toggle-sidebar') setSidebarOpen((open) => !open);
      else if (command === 'quick-find') setFinding(true);
      else if (command === 'new-tab') newTab();
      else if (command === 'close-tab') changeTabs((prev) => closeTab(prev, prev.active));
      else if (command === 'next-tab') changeTabs((prev) => cycleTab(prev, 1));
      else if (command === 'prev-tab') changeTabs((prev) => cycleTab(prev, -1));
      else if (command === 'sync-settings') setSyncOpen(true);
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
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      // Ctrl+Tab / Ctrl+Shift+Tab, and Ctrl+PageDown / Ctrl+PageUp.
      if (event.key === 'Tab' || event.key === 'PageDown' || event.key === 'PageUp') {
        const back = event.key === 'PageUp' || (event.key === 'Tab' && event.shiftKey);
        run(back ? 'prev-tab' : 'next-tab');
        event.preventDefault();
        return;
      }
      const key = event.key.toLowerCase();
      if (event.shiftKey) {
        if (key === 'u') keys.current.toParent();
        else if (key === 'l') keys.current.toggleTheme();
        // Ctrl+? (Ctrl+Shift+/ on most keyboards).
        else if (key === '?' || event.code === 'Slash') setShortcutsOpen(true);
        else return;
        event.preventDefault();
        return;
      }
      if (key === '[') run('go-back');
      else if (key === ']') run('go-forward');
      else if (key === 'n') run('new-page');
      else if (key === 't') run('new-tab');
      else if (key === 'w') run('close-tab');
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
  }, [platform, create, go, newTab, changeTabs]);

  // Links (workspace://page/…) and reminder notifications.
  const nonce = useRef(0);
  const showPage = useCallback(
    (pageId: PageId, blockId: string | null) => {
      const go = () => {
        navigate(pageId);
        if (blockId) setBlockTarget({ pageId, blockId, nonce: ++nonce.current });
      };
      if (exists(pageId)) go();
      // A row: find and load its database first. Neither: it can't be opened (here).
      else
        void databases
          .locate(pageId)
          .then((databaseId) => (databaseId ? go() : setMissing(pageId)));
    },
    [exists, navigate, databases, setMissing],
  );
  useEffect(() => platform.onNavigate(showPage), [platform, showPage]);

  const navigation = useMemo<Navigation>(
    () => ({
      // A page that isn't here: a row to look up, or one this person can't open.
      navigate: (id) => (exists(id) ? navigate(id) : showPage(id, null)),
      openRow: (rowId, databaseId, mode) => {
        if (mode === 'fullPage') navigate(rowId);
        else setPeek({ rowId, databaseId, mode });
      },
      navigateToBlock: (pageId, blockId) => {
        navigate(pageId);
        if (blockId) setBlockTarget({ pageId, blockId, nonce: ++blockNonce.current });
      },
    }),
    [navigate, exists, showPage],
  );

  // A notification (the inbox's, or a system one clicked): its page, at its block or thread.
  const openNotification = useCallback(
    (n: NotificationData) => {
      if (!n.pageId) return;
      if (n.threadId) requestThread(n.pageId, n.threadId);
      showPage(n.pageId, n.blockId);
    },
    [showPage],
  );
  useEffect(() => platform.notifications?.onOpen?.(openNotification), [platform, openNotification]);
  const analyticsApi = useMemo(
    () => (team ? { get: team.analytics, view: team.view } : undefined),
    [team],
  );
  const followApi = useMemo(
    () => (inbox ? { get: inbox.api.following, set: inbox.api.setFollowing } : undefined),
    [inbox?.api], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const chrome = {
    sidebarOpen,
    onOpenSidebar: () => setSidebarOpen(true),
    canGoBack: stepHistory(history, -1, exists) !== null,
    canGoForward: stepHistory(history, 1, exists) !== null,
    onGo: go,
  };

  const screenChrome = { ...chrome, canGoBack: currentPageId !== null, canGoForward: false };
  const content =
    screen === 'home' ? (
      <Home chrome={screenChrome} recent={recent} onOpen={showPage} />
    ) : screen === 'people' ? (
      <PeopleView chrome={screenChrome} onOpen={(id) => showPage(id, null)} />
    ) : missing ? (
      <NoAccess
        key={`${missing}:${missingPage?.n}`}
        pageId={missing}
        version={version}
        onFound={() => showPage(missing, null)}
      />
    ) : !currentPageId ? (
      <EmptyState onCreate={() => create(null)} />
    ) : getPage(workspace, currentPageId) ? (
      <PageView
        pageId={currentPageId}
        chrome={chrome}
        blockTarget={blockTarget?.pageId === currentPageId ? blockTarget : null}
        onDuplicate={duplicate}
        onSaveAsTemplate={saveTemplate}
        onExport={can(platform, 'export') ? setExporting : undefined}
        onMove={setMoving}
        onTrash={trash}
        onShare={team && scoped ? setSharing : undefined}
        follow={followApi}
        analytics={analyticsApi}
        isFavorite={favorites.includes(currentPageId)}
        onToggleFavorite={() => toggleFavorite(currentPageId)}
      />
    ) : pages.databaseOf(currentPageId) ? (
      <RowPageView
        key={currentPageId}
        rowId={currentPageId}
        databaseId={pages.databaseOf(currentPageId)!}
        chrome={chrome}
        blockTarget={blockTarget?.pageId === currentPageId ? blockTarget : null}
      />
    ) : (
      // Still looking up a row.
      <main className="flex-1 bg-surface" aria-busy="true" />
    );

  return (
    <NavigationContext.Provider value={navigation}>
      <div className="flex h-full">
        {sidebarOpen && (
          <Sidebar
            workspace={workspace}
            sections={sections}
            canEdit={(id) => roleAllows(pages.role(id), 'edit')}
            viewers={viewers}
            icons={teamspaceIcons}
            favorites={favorites}
            width={sidebarWidth}
            currentPageId={screen ? null : currentPageId}
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
            onHome={() => {
              setPeek(null);
              setMissing(null);
              setScreen('home');
            }}
            homeActive={screen === 'home'}
            onPeople={() => {
              setPeek(null);
              setMissing(null);
              setScreen('people');
            }}
            peopleActive={screen === 'people'}
            onTemplates={() => setTemplates(true)}
            onImport={() =>
              void platform
                .startImport(workspace.primary?.info.id)
                .catch((error: unknown) => console.error('Import failed', error))
            }
            onExportAll={() => setExporting(null)}
            onBackup={() =>
              void platform
                .startExport({ format: 'backup' })
                .catch((error: unknown) => console.error('Backup failed', error))
            }
            onRestore={() =>
              void platform
                .restoreBackup()
                .catch((error: unknown) => window.alert(`Restore failed: ${String(error)}`))
            }
            onResize={setSidebarWidth}
            fileUrl={platform.fileUrl}
            onThemeChange={changeTheme}
            onRegion={() => setRegionOpen(true)}
            onAbout={platform.about ? () => setAboutOpen(true) : undefined}
            onShortcuts={() => setShortcutsOpen(true)}
            updateReady={
              updates?.status === 'ready' && updates.version
                ? { version: updates.version, onRestart: () => platform.about?.updates?.install() }
                : undefined
            }
            zoom={platform.zoom}
            onCollapse={() => setSidebarOpen(false)}
            sync={syncInfo}
            onSync={() => setSyncOpen(true)}
            can={{
              export: can(platform, 'export'),
              import: can(platform, 'import'),
              backup: can(platform, 'backup'),
            }}
            account={platform.account}
            inbox={
              inbox
                ? (className) => (
                    <InboxButton inbox={inbox} className={className} onOpen={openNotification} />
                  )
                : undefined
            }
            team={
              team
                ? {
                    onMembers: () => setPeopleOpen('members'),
                    onProfile: () => setPeopleOpen('profile'),
                  }
                : undefined
            }
            teamspaces={
              team && scoped
                ? {
                    onNew: () => setTeamspaceDialog({ kind: 'new' }),
                    onBrowse: () => setTeamspaceDialog({ kind: 'browse' }),
                    onSettings: (scopeId) => setTeamspaceDialog({ kind: 'settings', scopeId }),
                    onLeave: leaveTeamspace,
                  }
                : undefined
            }
          />
        )}
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
        {aboutOpen && platform.about && (
          <AboutDialog about={platform.about} onClose={() => setAboutOpen(false)} />
        )}
        {regionOpen && (
          <RegionDialog
            settings={regionSettings}
            onChange={changeRegion}
            onClose={() => setRegionOpen(false)}
          />
        )}
        {team && sharing && (
          <ShareDialog
            team={team}
            forest={workspace}
            pageId={sharing}
            onClose={() => setSharing(null)}
          />
        )}
        {team && teamspaceDialog?.kind === 'new' && (
          <NewTeamspaceDialog
            team={team}
            onClose={() => setTeamspaceDialog(null)}
            onCreated={() => {}}
          />
        )}
        {team && teamspaceDialog?.kind === 'browse' && (
          <BrowseTeamspacesDialog team={team} onClose={() => setTeamspaceDialog(null)} />
        )}
        {team && teamspaceDialog?.kind === 'settings' && (
          <TeamspaceSettingsDialog
            team={team}
            scopeId={teamspaceDialog.scopeId}
            onClose={() => setTeamspaceDialog(null)}
          />
        )}
        {team && peopleOpen === 'members' && (
          <MembersDialog
            team={team}
            onClose={() => setPeopleOpen(null)}
            onLeft={() => {
              setPeopleOpen(null);
              platform.account?.switchWorkspace();
            }}
          />
        )}
        {team && peopleOpen === 'profile' && (
          <ProfileDialog team={team} onClose={() => setPeopleOpen(null)} />
        )}
        {syncOpen && platform.sync && syncInfo && (
          <SyncDialog
            sync={platform.sync}
            info={syncInfo}
            onClose={() => setSyncOpen(false)}
            onBackup={() =>
              void platform
                .startExport({ format: 'backup' })
                .catch((error: unknown) => console.error('Backup failed', error))
            }
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {tabs.tabs.length > 1 && (
            <TabBar
              state={tabs}
              pageOf={tabPage}
              onSelect={selectTab}
              onClose={closeTabAt}
              onMove={(from, to) => changeTabs((prev) => moveTab(prev, from, to))}
              onNew={newTab}
              onDetach={detachTab}
            />
          )}
          <div className="flex min-h-0 flex-1" key={tabs.tabs[tabs.active]!.id}>
            {content}
          </div>
        </div>
        {peek && (
          <RowPeek
            key={peek.rowId}
            rowId={peek.rowId}
            databaseId={peek.databaseId}
            mode={peek.mode}
            onClose={() => setPeek(null)}
          />
        )}
        {moving && getPage(workspace, moving) && (
          <MoveDialog
            workspace={workspace}
            pageId={moving}
            fileUrl={platform.fileUrl}
            onMove={(parentId) => {
              moveTo(moving, { parentId });
              navigate(moving);
            }}
            onClose={() => setMoving(null)}
          />
        )}
        <ButtonEditorHost />
        <ExportProgress />
        <ImportProgress onOpen={navigate} />
        {exporting !== undefined && (
          <ExportDialog pageId={exporting} onClose={() => setExporting(undefined)} />
        )}
        {templates && <TemplatesGallery onUse={navigate} onClose={() => setTemplates(false)} />}
        {finding && (
          <QuickFind
            workspace={workspace}
            platform={platform}
            recent={recent}
            sections={sections}
            shared={scoped}
            onOpen={navigate}
            onOpenInWindow={(id) => platform.openWindow(id)}
            onClose={() => setFinding(false)}
          />
        )}
      </div>
    </NavigationContext.Provider>
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
