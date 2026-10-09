import {
  FILE_ICON_PREFIX,
  getPage,
  getPageContent,
  getPageTitleText,
  isInTrash,
  pageUrl,
  restorePage,
  setPageIcon,
  setPageOptions,
  roleAllows,
  setPageTitle,
  type PageId,
  type PageMeta,
  type PageOptions,
  type TreeRole,
} from '@workspace/core';
import {
  PageEditor,
  PageIcon,
  type Editor,
  type EditorComments,
  type PageRef,
} from '@workspace/editor';
import {
  Avatar,
  Button,
  IconButton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@workspace/ui';
import {
  ArrowLeft,
  ArrowRight,
  ChevronsRight,
  ImageIcon,
  Lock,
  MessageSquare,
  Eye,
  Smile,
  Star,
  Table2,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { useDisplayContext } from './database/hooks';
import { uniquePeople, usePeers, usePresence, type Peer } from './presence';
import type { BlockTarget } from './app';
import { useApp } from './context';
import { can } from './platform';
import { Backlinks } from './backlinks';
import {
  CommentsButton,
  CommentsPanel,
  PageCommentsSection,
  usePageComments,
  type PageComments,
} from './comments';
import { Cover, randomCover } from './cover';
import { DatabaseView } from './database/database-view';
import { convertToDatabase } from './database/registry';
import { useEditorServices } from './editor-services';
import { useDoc, useDocVersion } from './hooks';
import { IconPicker, randomEmoji } from './icon-picker';
import { useNavigation } from './navigation';
import { PageMenu } from './page-menu';

/** Back/forward and sidebar controls shared by every page header. */
export interface ChromeProps {
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  canGoBack: boolean;
  canGoForward: boolean;
  onGo(direction: -1 | 1): void;
}

/**
 * A page as the page chrome sees it: a workspace page or a database row (rows have
 * the same fields, stored in their database doc).
 */
export interface PageModel {
  id: string;
  meta: PageMeta;
  titleText: Y.Text;
  setTitle(title: string): void;
  setIcon(icon: string | null): void;
  setOptions(options: Partial<PageOptions>): void;
  /** The page, an ancestor, or (for a row) its database is in the trash. */
  trashed: boolean;
  restore(): void;
}

// --- Header ------------------------------------------------------------------------------

export interface PageHeaderProps {
  chrome: ChromeProps;
  crumbs: PageRef[];
  locked: boolean;
  onUnlock(): void;
  /** The person may not edit the page: their role, shown as a badge. */
  access?: TreeRole;
  /** Open the share dialog (a page of a server workspace). */
  onShare?(): void;
  /** Others on the page now. */
  people?: Peer[];
  /** The page's comments (the header's comments button). */
  comments?: PageComments | null;
  /** Favorite toggle (pages only). */
  favorite?: { on: boolean; toggle(): void };
  menu: ReactNode;
}

export function PageHeader({
  chrome,
  crumbs,
  locked,
  onUnlock,
  access,
  onShare,
  people = [],
  comments = null,
  favorite,
  menu,
}: PageHeaderProps) {
  const { platform } = useApp();
  const { avatars: pictures } = useDisplayContext();
  const { navigate } = useNavigation();
  return (
    <header className="flex h-11 shrink-0 items-center gap-1 px-3 text-sm">
      {!chrome.sidebarOpen && (
        <IconButton label="Open sidebar (Ctrl+\)" onClick={chrome.onOpenSidebar}>
          <ChevronsRight size={18} />
        </IconButton>
      )}
      <IconButton
        label="Go back (Alt+←)"
        className="disabled:opacity-30"
        disabled={!chrome.canGoBack}
        onClick={() => chrome.onGo(-1)}
      >
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton
        label="Go forward (Alt+→)"
        className="disabled:opacity-30"
        disabled={!chrome.canGoForward}
        onClick={() => chrome.onGo(1)}
      >
        <ArrowRight size={16} />
      </IconButton>
      <ol className="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Breadcrumb">
        {crumbs.map((crumb, i) => (
          <li key={crumb.id} className="flex min-w-0 items-center gap-0.5">
            {i > 0 && <span className="text-faint">/</span>}
            <button
              type="button"
              onClick={() => navigate(crumb.id)}
              className="flex max-w-48 items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-hover"
            >
              {crumb.icon && <PageIcon icon={crumb.icon} size={16} fileUrl={platform.fileUrl} />}
              <span className="truncate">{crumb.title || 'Untitled'}</span>
            </button>
          </li>
        ))}
      </ol>
      {locked && (
        <button
          type="button"
          title="Click to unlock"
          onClick={onUnlock}
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-hover"
        >
          <Lock size={12} /> Locked
        </button>
      )}
      {access && !roleAllows(access, 'edit') && (
        <span
          data-testid="access-badge"
          className="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted"
          title="Ask someone with full access to change this"
        >
          <Eye size={12} />{' '}
          {access === 'content'
            ? 'Can edit content'
            : access === 'comment'
              ? 'Can comment'
              : 'View only'}
        </span>
      )}
      {people.length > 0 && (
        <div className="flex items-center -space-x-1.5 pr-1" data-testid="page-people">
          {people.slice(0, 5).map(({ state }) => (
            <button
              key={state.user.id}
              type="button"
              title={state.user.name}
              aria-label={`${state.user.name} is here`}
              className="rounded-full"
              style={{ boxShadow: `0 0 0 2px ${state.user.color}` }}
              onClick={() =>
                document
                  .querySelector(`.ws-cursor[data-user-id="${CSS.escape(state.user.id)}"]`)
                  ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
              }
            >
              <Avatar
                id={state.user.id}
                name={state.user.name}
                src={pictures?.get(state.user.id)}
                size={24}
              />
            </button>
          ))}
          {people.length > 5 && (
            <span className="pl-2 text-xs text-muted">+{people.length - 5}</span>
          )}
        </div>
      )}
      {comments && <CommentsButton comments={comments} />}
      {onShare && (
        <button
          type="button"
          onClick={onShare}
          className="flex h-7 items-center rounded px-2 text-sm hover:bg-hover"
        >
          Share
        </button>
      )}
      {favorite && (
        <IconButton
          label={favorite.on ? 'Remove from Favorites' : 'Add to Favorites'}
          aria-pressed={favorite.on}
          onClick={favorite.toggle}
        >
          <Star
            size={16}
            className={cn(favorite.on && 'fill-yellow-400 text-yellow-400')}
            aria-hidden
          />
        </IconButton>
      )}
      {menu}
    </header>
  );
}

export function TrashBanner({ label, onRestore }: { label: string; onRestore(): void }) {
  return (
    <div className="flex items-center justify-center gap-3 bg-danger py-1.5 text-sm text-white">
      {label}
      <Button
        className="h-6 border border-white/60 text-white hover:bg-white/15 hover:text-white"
        onClick={onRestore}
      >
        Restore page
      </Button>
    </div>
  );
}

// --- Hero: cover, icon, title ------------------------------------------------------------

export function PageHero({
  model,
  editable,
  onEnter,
  comments = null,
}: {
  model: PageModel;
  editable: boolean;
  onEnter(): void;
  /** Comments on the whole page, shown under the title. */
  comments?: PageComments | null;
}) {
  const { platform } = useApp();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const { meta } = model;
  const canComment = !!comments?.canComment && !!comments.doc;
  const uploadImage = async (file: File) => (await platform.importFile(file)).id;
  const setIcon = (icon: string | null) => {
    model.setIcon(icon);
    setIconPickerOpen(false);
  };
  const heroButton = 'flex h-7 items-center gap-1.5 rounded px-2 text-sm text-muted hover:bg-hover';
  return (
    <>
      <div className={cn('group/hero', meta.cover ? 'pt-4' : 'pt-20')}>
        {meta.icon && (
          <Popover
            open={iconPickerOpen}
            onOpenChange={(open) => editable && setIconPickerOpen(open)}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Change page icon"
                disabled={!editable}
                className={cn(
                  'mb-2 flex size-[78px] items-center justify-center rounded text-[64px] leading-none enabled:hover:bg-hover',
                  meta.cover && 'relative -mt-[58px]',
                )}
              >
                <PageIcon
                  icon={meta.icon}
                  size={meta.icon.startsWith(FILE_ICON_PREFIX) ? 72 : 64}
                  fileUrl={platform.fileUrl}
                />
              </button>
            </PopoverTrigger>
            <PopoverContent>
              <IconPicker
                hasIcon
                onPick={setIcon}
                onUpload={async (file) => setIcon(`${FILE_ICON_PREFIX}${await uploadImage(file)}`)}
              />
            </PopoverContent>
          </Popover>
        )}
        {((editable && (!meta.icon || !meta.cover)) || canComment) && (
          <div className="mb-1 flex h-7 gap-1 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-within:opacity-100">
            {editable && !meta.icon && (
              <button
                type="button"
                className={heroButton}
                onClick={() => model.setIcon(randomEmoji())}
              >
                <Smile size={15} /> Add icon
              </button>
            )}
            {editable && !meta.cover && (
              <button
                type="button"
                className={heroButton}
                onClick={() => model.setOptions({ cover: randomCover() })}
              >
                <ImageIcon size={15} /> Add cover
              </button>
            )}
            {canComment && (
              <button type="button" className={heroButton} onClick={() => setCommenting(true)}>
                <MessageSquare size={15} /> Add comment
              </button>
            )}
          </div>
        )}
        <TitleInput
          key={model.id}
          ytext={model.titleText}
          onChange={model.setTitle}
          readOnly={!editable}
          onEnter={onEnter}
        />
        {can(platform, 'backlinks') && <Backlinks pageId={model.id} />}
        {comments && (
          <PageCommentsSection
            key={`comments:${model.id}`}
            comments={comments}
            composing={commenting}
            onDone={() => setCommenting(false)}
          />
        )}
      </div>
    </>
  );
}

/** The cover banner above a page (full width, outside the reading column). */
export function HeroCover({ model, editable }: { model: PageModel; editable: boolean }) {
  const { platform } = useApp();
  const { cover } = model.meta;
  if (!cover) return null;
  return (
    <Cover
      cover={cover}
      editable={editable}
      fileUrl={platform.fileUrl}
      onChange={(next) => model.setOptions({ cover: next })}
      onUpload={async (file) => ({
        kind: 'file',
        value: (await platform.importFile(file)).id,
        positionY: 50,
      })}
    />
  );
}

/** Page title bound to its collaborative Y.Text. */
export function TitleInput({
  ytext,
  onChange,
  readOnly,
  onEnter,
}: {
  ytext: Y.Text;
  onChange(title: string): void;
  readOnly: boolean;
  onEnter(): void;
}) {
  const subscribe = useCallback(
    (listener: () => void) => {
      ytext.observe(listener);
      return () => ytext.unobserve(listener);
    },
    [ytext],
  );
  const title = useSyncExternalStore(subscribe, () => ytext.toString());
  const ref = useRef<HTMLTextAreaElement>(null);

  // New pages start with the cursor in the title, like Notion.
  useEffect(() => {
    if (ytext.length === 0 && !readOnly) ref.current?.focus();
  }, [ytext, readOnly]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={title}
      readOnly={readOnly}
      placeholder="Untitled"
      aria-label="Page title"
      spellCheck
      onChange={(event) => onChange(event.target.value.replace(/\n/g, ' '))}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onEnter();
        }
      }}
      className="w-full resize-none bg-transparent text-[40px] leading-tight font-bold text-fg outline-none placeholder:text-faint [field-sizing:content]"
    />
  );
}

// --- Body --------------------------------------------------------------------------------

/** The editor of a page's (or row's) content, with "Enter in the title focuses it". */
export function usePageBody(pageId: PageId | null) {
  const { client } = useApp();
  const pageDoc = useDoc(client, pageId);
  const editorRef = useRef<Editor | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  // If the editor is still loading when Enter is pressed in the title, focus it once ready.
  const focusWhenReady = useRef(false);
  const onEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
    setEditor(editor);
    if (editor && focusWhenReady.current) {
      focusWhenReady.current = false;
      editor.commands.focus('start');
    }
  }, []);
  const focusBody = useCallback(() => {
    if (editorRef.current) editorRef.current.commands.focus('start');
    else focusWhenReady.current = true;
  }, []);
  return { pageDoc, onEditor, focusBody, editor };
}

export function PageBody({
  pageId,
  pageDoc,
  editable,
  onEditor,
  awareness = null,
  comments = null,
}: {
  pageId: PageId;
  pageDoc: Y.Doc | null;
  editable: boolean;
  onEditor(editor: Editor | null): void;
  /** Who else is on the page (their cursors show). */
  awareness?: Awareness | null;
  /** The page's comments (highlights, suggestions). */
  comments?: EditorComments | null;
}) {
  const services = useEditorServices(pageId);
  const { user } = useApp();
  return pageDoc ? (
    <PageEditor
      key={pageId}
      doc={pageDoc}
      services={services}
      editable={editable}
      onEditor={onEditor}
      awareness={awareness}
      selfId={user.id}
      comments={comments}
    />
  ) : (
    <div className="h-6" aria-busy="true" />
  );
}

/** Article classes for page options (width, text size, font). */
export function articleProps(meta: PageMeta, wide = false) {
  return {
    'data-testid': 'page-article',
    'data-font': meta.font,
    'data-small-text': meta.smallText || undefined,
    'data-full-width': meta.fullWidth || undefined,
    className: cn(
      'ws-page mx-auto w-full px-24 pb-24 max-md:px-6',
      meta.fullWidth || wide ? 'max-w-none' : 'max-w-[900px]',
    ),
  };
}

// --- Workspace pages ---------------------------------------------------------------------

export interface PageViewProps {
  pageId: PageId;
  chrome: ChromeProps;
  /** Block to scroll to and highlight (from a link to a block). */
  blockTarget: BlockTarget | null;
  isFavorite: boolean;
  onToggleFavorite(): void;
  onDuplicate(id: PageId): void;
  onSaveAsTemplate(id: PageId): void;
  /** Absent where the host can't export (the web app). */
  onExport?(id: PageId): void;
  onMove(id: PageId): void;
  onTrash(id: PageId): void;
  /** Share the page (a server workspace). */
  onShare?(id: PageId): void;
  /** Following pages (a server workspace): their comments reach the inbox. */
  follow?: { get(id: PageId): Promise<boolean>; set(id: PageId, on: boolean): Promise<void> };
  /** Page views (a server workspace): counted when a page is opened, shown in its menu. */
  analytics?: {
    get(id: PageId): Promise<{ views: number; viewers: number }>;
    view(id: PageId): Promise<unknown>;
  };
}

/** Pages this window has counted a view of. */
const viewed = new Set<PageId>();

function useWorkspacePageModel(pageId: PageId): PageModel | null {
  const { workspace } = useApp();
  const page = getPage(workspace, pageId);
  if (!page) return null;
  return {
    id: pageId,
    meta: page,
    titleText: getPageTitleText(workspace, pageId),
    setTitle: (title) => setPageTitle(workspace, pageId, title),
    setIcon: (icon) => setPageIcon(workspace, pageId, icon),
    setOptions: (options) => setPageOptions(workspace, pageId, options),
    trashed: isInTrash(workspace, pageId),
    restore: () => restorePage(workspace, pageId),
  };
}

/** A workspace page: its content, or for a database page, its views. */
export function PageView({
  pageId,
  chrome,
  blockTarget,
  isFavorite,
  onToggleFavorite,
  onDuplicate,
  onSaveAsTemplate,
  onExport,
  onMove,
  onTrash,
  onShare,
  follow,
  analytics,
}: PageViewProps) {
  // A view, once per page per window.
  useEffect(() => {
    if (!analytics || viewed.has(pageId)) return;
    viewed.add(pageId);
    analytics.view(pageId).catch(() => viewed.delete(pageId));
  }, [analytics, pageId]);
  const { pages } = useApp();
  const model = useWorkspacePageModel(pageId);
  const isDatabase = model?.meta.kind === 'database';
  // A database page has no content doc; `useDoc` with null loads nothing.
  const { pageDoc, onEditor, focusBody, editor } = usePageBody(isDatabase ? null : pageId);
  const { user } = useApp();
  const role = pages.role(pageId);
  const comments = usePageComments(isDatabase ? null : pageId, role);
  const awareness = usePresence(isDatabase ? null : pageId, pageDoc);
  const people = uniquePeople(usePeers(awareness, user.id));
  const articleRef = useRef<HTMLElement>(null);
  useScrollToBlock(articleRef, pageDoc ? blockTarget : null);
  if (!model) return null;
  const { meta } = model;
  // Someone who may only view (or comment) gets the page read-only, as when locked.
  const editable = !meta.locked && !model.trashed && roleAllows(role, 'edit');
  // Suggesting: the text can be typed in, as suggestions (all a commenter may do).
  const bodyEditable = !meta.locked && !model.trashed && comments.suggesting;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <PageHeader
        chrome={chrome}
        crumbs={pages.breadcrumb(pageId)}
        locked={meta.locked}
        onUnlock={() => model.setOptions({ locked: false })}
        access={role}
        onShare={onShare ? () => onShare(pageId) : undefined}
        people={people}
        comments={isDatabase ? null : comments}
        favorite={{ on: isFavorite, toggle: onToggleFavorite }}
        menu={
          <PageMenu
            page={meta}
            pageDoc={pageDoc}
            onOptions={model.setOptions}
            onDuplicate={() => onDuplicate(pageId)}
            onMove={() => onMove(pageId)}
            onCopyLink={() => void navigator.clipboard.writeText(pageUrl(pageId))}
            onConnections={onShare ? () => onShare(pageId) : undefined}
            onSaveAsTemplate={() => onSaveAsTemplate(pageId)}
            onExport={onExport ? () => onExport(pageId) : undefined}
            onTrash={() => onTrash(pageId)}
            views={analytics && (() => analytics.get(pageId))}
            follow={
              follow && {
                get: () => follow.get(pageId),
                set: (on) => follow.set(pageId, on),
              }
            }
            suggest={
              isDatabase || !comments.canComment
                ? undefined
                : { on: comments.suggesting, toggle: comments.toggleSuggesting }
            }
          />
        }
      />
      {model.trashed && <TrashBanner label="This page is in Trash." onRestore={model.restore} />}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto" data-testid="page-scroll" data-scroll-root>
          <HeroCover model={model} editable={editable} />
          <article ref={articleRef} {...articleProps(meta, isDatabase)}>
            <PageHero
              model={model}
              editable={editable}
              onEnter={focusBody}
              comments={isDatabase ? null : comments}
            />
            <div className="mt-2">
              {isDatabase ? (
                // Its rows may be editable without the page ("can edit content").
                <DatabaseView databaseId={pageId} editable={!meta.locked && !model.trashed} />
              ) : (
                <>
                  <PageBody
                    pageId={pageId}
                    pageDoc={pageDoc}
                    editable={editable || bodyEditable}
                    onEditor={onEditor}
                    awareness={awareness}
                    comments={comments.host}
                  />
                  {editable && pageDoc && <GetStarted pageId={pageId} pageDoc={pageDoc} />}
                </>
              )}
            </div>
          </article>
        </div>
        {!isDatabase && comments.panelOpen && comments.doc && (
          <CommentsPanel comments={comments} editor={editor} />
        )}
      </div>
    </main>
  );
}

/** Notion's "Get started with": an empty page can become a database. */
function GetStarted({ pageId, pageDoc }: { pageId: PageId; pageDoc: Y.Doc }) {
  const { client, workspace } = useApp();
  useDocVersion(pageDoc);
  const content = getPageContent(pageDoc);
  const empty =
    content.length === 0 ||
    (content.length === 1 &&
      content
        .toArray()[0]!
        .toString()
        .replace(/<[^>]*>/g, '') === '');
  if (!empty) return null;
  return (
    <div className="mt-6 flex items-center gap-2 text-sm text-faint" data-testid="get-started">
      <span>Get started with</span>
      <button
        type="button"
        onClick={() => void convertToDatabase(client, workspace, pageId)}
        className="flex h-7 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
      >
        <Table2 size={15} /> Database
      </button>
    </div>
  );
}

// --- Scroll to block ---------------------------------------------------------------------

const FLASH_MS = 1600;
const FIND_BLOCK_TIMEOUT_MS = 3000;

/**
 * Scroll a block into view and flash it. The editor renders after its doc loads, so
 * wait (a few frames) for the block to appear. (The flash is an animation rather than
 * a class: ProseMirror resets attributes it didn't render.)
 */
export function useScrollToBlock(
  articleRef: RefObject<HTMLElement | null>,
  target: BlockTarget | null,
) {
  useEffect(() => {
    if (!target) return;
    const started = performance.now();
    let frame = 0;
    let flash: Animation | undefined;
    const find = () => {
      const el = articleRef.current?.querySelector<HTMLElement>(
        `[data-id="${CSS.escape(target.blockId)}"]`,
      );
      if (el) {
        el.scrollIntoView({ block: 'center' });
        const color = 'color-mix(in srgb, var(--ws-accent) 22%, transparent)';
        flash = el.animate(
          [{ backgroundColor: color }, { backgroundColor: color, offset: 0.4 }, {}],
          { duration: FLASH_MS, easing: 'ease-out', id: 'ws-flash' },
        );
      } else if (performance.now() - started < FIND_BLOCK_TIMEOUT_MS) {
        frame = requestAnimationFrame(find);
      }
    };
    find();
    return () => {
      cancelAnimationFrame(frame);
      flash?.cancel();
    };
  }, [articleRef, target]);
}
