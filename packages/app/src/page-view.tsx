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
  setPageTitle,
  type PageId,
  type PageMeta,
  type PageOptions,
} from '@workspace/core';
import { PageEditor, PageIcon, type Editor, type PageRef } from '@workspace/editor';
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger, cn } from '@workspace/ui';
import {
  ArrowLeft,
  ArrowRight,
  ChevronsRight,
  ImageIcon,
  Lock,
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
import type * as Y from 'yjs';
import type { BlockTarget } from './app';
import { useApp } from './context';
import { can } from './platform';
import { Backlinks } from './backlinks';
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
  /** Favorite toggle (pages only). */
  favorite?: { on: boolean; toggle(): void };
  menu: ReactNode;
}

export function PageHeader({ chrome, crumbs, locked, onUnlock, favorite, menu }: PageHeaderProps) {
  const { platform } = useApp();
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
}: {
  model: PageModel;
  editable: boolean;
  onEnter(): void;
}) {
  const { platform } = useApp();
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const { meta } = model;
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
        {editable && (!meta.icon || !meta.cover) && (
          <div className="mb-1 flex h-7 gap-1 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-within:opacity-100">
            {!meta.icon && (
              <button
                type="button"
                className={heroButton}
                onClick={() => model.setIcon(randomEmoji())}
              >
                <Smile size={15} /> Add icon
              </button>
            )}
            {!meta.cover && (
              <button
                type="button"
                className={heroButton}
                onClick={() => model.setOptions({ cover: randomCover() })}
              >
                <ImageIcon size={15} /> Add cover
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
  // If the editor is still loading when Enter is pressed in the title, focus it once ready.
  const focusWhenReady = useRef(false);
  const onEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
    if (editor && focusWhenReady.current) {
      focusWhenReady.current = false;
      editor.commands.focus('start');
    }
  }, []);
  const focusBody = useCallback(() => {
    if (editorRef.current) editorRef.current.commands.focus('start');
    else focusWhenReady.current = true;
  }, []);
  return { pageDoc, onEditor, focusBody };
}

export function PageBody({
  pageId,
  pageDoc,
  editable,
  onEditor,
}: {
  pageId: PageId;
  pageDoc: Y.Doc | null;
  editable: boolean;
  onEditor(editor: Editor | null): void;
}) {
  const services = useEditorServices(pageId);
  return pageDoc ? (
    <PageEditor
      key={pageId}
      doc={pageDoc}
      services={services}
      editable={editable}
      onEditor={onEditor}
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
}

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
}: PageViewProps) {
  const { pages } = useApp();
  const model = useWorkspacePageModel(pageId);
  const isDatabase = model?.meta.kind === 'database';
  // A database page has no content doc; `useDoc` with null loads nothing.
  const { pageDoc, onEditor, focusBody } = usePageBody(isDatabase ? null : pageId);
  const articleRef = useRef<HTMLElement>(null);
  useScrollToBlock(articleRef, pageDoc ? blockTarget : null);
  if (!model) return null;
  const { meta } = model;
  const editable = !meta.locked && !model.trashed;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <PageHeader
        chrome={chrome}
        crumbs={pages.breadcrumb(pageId)}
        locked={meta.locked}
        onUnlock={() => model.setOptions({ locked: false })}
        favorite={{ on: isFavorite, toggle: onToggleFavorite }}
        menu={
          <PageMenu
            page={meta}
            pageDoc={pageDoc}
            onOptions={model.setOptions}
            onDuplicate={() => onDuplicate(pageId)}
            onMove={() => onMove(pageId)}
            onCopyLink={() => void navigator.clipboard.writeText(pageUrl(pageId))}
            onSaveAsTemplate={() => onSaveAsTemplate(pageId)}
            onExport={onExport ? () => onExport(pageId) : undefined}
            onTrash={() => onTrash(pageId)}
          />
        }
      />
      {model.trashed && <TrashBanner label="This page is in Trash." onRestore={model.restore} />}
      <div className="flex-1 overflow-y-auto" data-testid="page-scroll" data-scroll-root>
        <HeroCover model={model} editable={editable} />
        <article ref={articleRef} {...articleProps(meta, isDatabase)}>
          <PageHero model={model} editable={editable} onEnter={focusBody} />
          <div className="mt-2">
            {isDatabase ? (
              <DatabaseView databaseId={pageId} editable={editable} />
            ) : (
              <>
                <PageBody
                  pageId={pageId}
                  pageDoc={pageDoc}
                  editable={editable}
                  onEditor={onEditor}
                />
                {editable && pageDoc && <GetStarted pageId={pageId} pageDoc={pageDoc} />}
              </>
            )}
          </div>
        </article>
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
