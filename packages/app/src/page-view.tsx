import {
  FILE_ICON_PREFIX,
  createPage,
  getAncestorIds,
  getPage,
  getPageTitleText,
  isInTrash,
  listPages,
  pageUrl,
  restorePage,
  setPageIcon,
  setPageOptions,
  setPageTitle,
  type PageId,
  type PageOptions,
} from '@workspace/core';
import {
  PageEditor,
  PageIcon,
  type Editor,
  type EditorServices,
  type PageRef,
} from '@workspace/editor';
import { Button, IconButton, Popover, PopoverContent, PopoverTrigger, cn } from '@workspace/ui';
import { ArrowLeft, ArrowRight, ChevronsRight, ImageIcon, Lock, Smile, Star } from 'lucide-react';
import { Cover, randomCover } from './cover';
import { IconPicker, randomEmoji } from './icon-picker';
import { PageMenu } from './page-menu';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type * as Y from 'yjs';
import { useApp } from './context';
import type { Platform } from './platform';
import type { BlockTarget } from './app';
import { useDoc } from './hooks';

export interface PageViewProps {
  pageId: PageId;
  sidebarOpen: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGo(direction: -1 | 1): void;
  /** Block to scroll to and highlight (from a link to a block). */
  blockTarget: BlockTarget | null;
  isFavorite: boolean;
  onToggleFavorite(): void;
  onOpenSidebar(): void;
  onNavigate(id: PageId): void;
  onDuplicate(id: PageId): void;
  onMove(id: PageId): void;
  onTrash(id: PageId): void;
}

export function PageView({
  pageId,
  sidebarOpen,
  canGoBack,
  canGoForward,
  onGo,
  blockTarget,
  isFavorite,
  onToggleFavorite,
  onOpenSidebar,
  onNavigate,
  onDuplicate,
  onMove,
  onTrash,
}: PageViewProps) {
  const { client, workspace, platform } = useApp();
  const pageDoc = useDoc(client, pageId);
  const editorRef = useRef<Editor | null>(null);
  // Enter in the title focuses the body; if the body's editor is still loading,
  // focus it as soon as it is ready.
  const focusBodyWhenReady = useRef(false);
  const onEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor;
    if (editor && focusBodyWhenReady.current) {
      focusBodyWhenReady.current = false;
      editor.commands.focus('start');
    }
  }, []);
  const focusBody = useCallback(() => {
    if (editorRef.current) editorRef.current.commands.focus('start');
    else focusBodyWhenReady.current = true;
  }, []);
  const services = useEditorServices(workspace, pageId, onNavigate, platform);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  useScrollToBlock(articleRef, pageDoc ? blockTarget : null);

  const page = getPage(workspace, pageId);
  if (!page) return null;

  const crumbs = [...getAncestorIds(workspace, pageId).reverse(), pageId]
    .map((id) => getPage(workspace, id))
    .filter((p) => p !== null);
  const trashed = isInTrash(workspace, pageId);
  const editable = !page.locked && !trashed;
  const fileUrl = platform.fileUrl;
  const setOptions = (options: Partial<PageOptions>) => setPageOptions(workspace, pageId, options);
  const uploadImage = async (file: File) => (await platform.importFile(file)).id;
  const setIcon = (icon: string | null) => {
    setPageIcon(workspace, pageId, icon);
    setIconPickerOpen(false);
  };

  const heroButton = 'flex h-7 items-center gap-1.5 rounded px-2 text-sm text-muted hover:bg-hover';
  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-11 shrink-0 items-center gap-1 px-3 text-sm">
        {!sidebarOpen && (
          <IconButton label="Open sidebar (Ctrl+\)" onClick={onOpenSidebar}>
            <ChevronsRight size={18} />
          </IconButton>
        )}
        <IconButton
          label="Go back (Alt+←)"
          className="disabled:opacity-30"
          disabled={!canGoBack}
          onClick={() => onGo(-1)}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label="Go forward (Alt+→)"
          className="disabled:opacity-30"
          disabled={!canGoForward}
          onClick={() => onGo(1)}
        >
          <ArrowRight size={16} />
        </IconButton>
        <ol className="flex min-w-0 flex-1 items-center gap-0.5" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            <li key={crumb.id} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <span className="text-faint">/</span>}
              <button
                type="button"
                onClick={() => onNavigate(crumb.id)}
                className="flex max-w-48 items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-hover"
              >
                {crumb.icon && <PageIcon icon={crumb.icon} size={16} fileUrl={fileUrl} />}
                <span className="truncate">{crumb.title || 'Untitled'}</span>
              </button>
            </li>
          ))}
        </ol>
        {page.locked && (
          <button
            type="button"
            title="Click to unlock"
            onClick={() => setOptions({ locked: false })}
            className="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted hover:bg-hover"
          >
            <Lock size={12} /> Locked
          </button>
        )}
        <IconButton
          label={isFavorite ? 'Remove from Favorites' : 'Add to Favorites'}
          aria-pressed={isFavorite}
          onClick={onToggleFavorite}
        >
          <Star
            size={16}
            className={cn(isFavorite && 'fill-yellow-400 text-yellow-400')}
            aria-hidden
          />
        </IconButton>
        <PageMenu
          page={page}
          pageDoc={pageDoc}
          onOptions={setOptions}
          onDuplicate={() => onDuplicate(pageId)}
          onMove={() => onMove(pageId)}
          onCopyLink={() => void navigator.clipboard.writeText(pageUrl(pageId))}
          onTrash={() => onTrash(pageId)}
        />
      </header>

      {trashed && (
        <div className="flex items-center justify-center gap-3 bg-danger py-1.5 text-sm text-white">
          This page is in Trash.
          <Button
            className="h-6 border border-white/60 text-white hover:bg-white/15 hover:text-white"
            onClick={() => restorePage(workspace, pageId)}
          >
            Restore page
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto" data-testid="page-scroll">
        {page.cover && (
          <Cover
            cover={page.cover}
            editable={editable}
            fileUrl={fileUrl}
            onChange={(cover) => setOptions({ cover })}
            onUpload={async (file) => ({
              kind: 'file',
              value: await uploadImage(file),
              positionY: 50,
            })}
          />
        )}
        <article
          ref={articleRef}
          data-testid="page-article"
          data-font={page.font}
          data-small-text={page.smallText || undefined}
          data-full-width={page.fullWidth || undefined}
          className={cn(
            'ws-page mx-auto w-full px-24 max-md:px-6',
            page.fullWidth ? 'max-w-none' : 'max-w-[900px]',
            page.cover ? 'pt-4' : 'pt-20',
          )}
        >
          <div className="group/hero">
            {page.icon && (
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
                      page.cover && 'relative -mt-[58px]',
                    )}
                  >
                    <PageIcon
                      icon={page.icon}
                      size={page.icon.startsWith(FILE_ICON_PREFIX) ? 72 : 64}
                      fileUrl={fileUrl}
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent>
                  <IconPicker
                    hasIcon
                    onPick={setIcon}
                    onUpload={async (file) =>
                      setIcon(`${FILE_ICON_PREFIX}${await uploadImage(file)}`)
                    }
                  />
                </PopoverContent>
              </Popover>
            )}
            {editable && (!page.icon || !page.cover) && (
              <div className="mb-1 flex h-7 gap-1 opacity-0 transition-opacity group-hover/hero:opacity-100 focus-within:opacity-100">
                {!page.icon && (
                  <button
                    type="button"
                    className={heroButton}
                    onClick={() => setPageIcon(workspace, pageId, randomEmoji())}
                  >
                    <Smile size={15} /> Add icon
                  </button>
                )}
                {!page.cover && (
                  <button
                    type="button"
                    className={heroButton}
                    onClick={() => setOptions({ cover: randomCover() })}
                  >
                    <ImageIcon size={15} /> Add cover
                  </button>
                )}
              </div>
            )}
            <TitleInput
              key={pageId}
              workspace={workspace}
              pageId={pageId}
              readOnly={!editable}
              onEnter={focusBody}
            />
          </div>
          <div className="mt-2">
            {pageDoc ? (
              <PageEditor
                key={pageId}
                doc={pageDoc}
                services={services}
                editable={editable}
                onEditor={onEditor}
              />
            ) : (
              <div className="h-6" aria-busy="true" />
            )}
          </div>
        </article>
      </div>
    </main>
  );
}

interface TitleInputProps {
  workspace: Y.Doc;
  pageId: PageId;
  readOnly: boolean;
  onEnter(): void;
}

/** Page title bound to its collaborative Y.Text in the workspace doc. */
function TitleInput({ workspace, pageId, readOnly, onEnter }: TitleInputProps) {
  const ytext = getPageTitleText(workspace, pageId);
  const subscribe = useCallback(
    (onChange: () => void) => {
      ytext.observe(onChange);
      return () => ytext.unobserve(onChange);
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
      onChange={(event) => setPageTitle(workspace, pageId, event.target.value.replace(/\n/g, ' '))}
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

/** What the editor needs from the workspace: page lookups, navigation, sub-pages. */
function useEditorServices(
  workspace: Y.Doc,
  pageId: PageId,
  navigate: (id: PageId) => void,
  platform: Platform,
): EditorServices {
  return useMemo(() => {
    const ref = (id: PageId): PageRef | null => {
      const page = getPage(workspace, id);
      return page
        ? { id, title: page.title, icon: page.icon, inTrash: isInTrash(workspace, id) }
        : null;
    };
    return {
      pageId,
      getPage: ref,
      listPages: () =>
        listPages(workspace)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((page) => ref(page.id)!),
      getBreadcrumb: () =>
        [...getAncestorIds(workspace, pageId).reverse(), pageId]
          .map(ref)
          .filter((page) => page !== null),
      navigate,
      createSubpage: () => createPage(workspace, { parentId: pageId }),
      subscribe: (listener) => {
        workspace.on('update', listener);
        return () => workspace.off('update', listener);
      },
      uploadFile: (file) => platform.importFile(file),
      fileUrl: (id) => platform.fileUrl(id),
      openFile: (id) => platform.openFile(id),
      linkPreview: (url) => platform.linkPreview(url),
    };
  }, [workspace, pageId, navigate, platform]);
}

const FLASH_MS = 1600;
const FIND_BLOCK_TIMEOUT_MS = 3000;

/**
 * Scroll a block into view and flash it. The editor renders after its doc loads, so
 * wait (a few frames) for the block to appear. (The flash is an animation rather than
 * a class: ProseMirror resets attributes it didn't render.)
 */
function useScrollToBlock(articleRef: RefObject<HTMLElement | null>, target: BlockTarget | null) {
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
