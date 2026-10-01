import {
  createPage,
  getAncestorIds,
  getPage,
  getPageTitleText,
  isInTrash,
  listPages,
  restorePage,
  setPageTitle,
  type PageId,
} from '@workspace/core';
import { PageEditor, type Editor, type EditorServices, type PageRef } from '@workspace/editor';
import { Button, IconButton } from '@workspace/ui';
import { ChevronsRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type * as Y from 'yjs';
import { useApp } from './context';
import { useDoc } from './hooks';

export interface PageViewProps {
  pageId: PageId;
  sidebarOpen: boolean;
  onOpenSidebar(): void;
  onNavigate(id: PageId): void;
}

export function PageView({ pageId, sidebarOpen, onOpenSidebar, onNavigate }: PageViewProps) {
  const { client, workspace } = useApp();
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
  const services = useEditorServices(workspace, pageId, onNavigate);

  const page = getPage(workspace, pageId);
  if (!page) return null;

  const crumbs = [...getAncestorIds(workspace, pageId).reverse(), pageId]
    .map((id) => getPage(workspace, id))
    .filter((p) => p !== null);
  const trashed = isInTrash(workspace, pageId);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col bg-surface">
      <header className="flex h-11 shrink-0 items-center gap-1 px-3 text-sm">
        {!sidebarOpen && (
          <IconButton label="Open sidebar (Ctrl+\)" onClick={onOpenSidebar}>
            <ChevronsRight size={18} />
          </IconButton>
        )}
        <ol className="flex min-w-0 items-center gap-0.5" aria-label="Breadcrumb">
          {crumbs.map((crumb, i) => (
            <li key={crumb.id} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <span className="text-faint">/</span>}
              <button
                type="button"
                onClick={() => onNavigate(crumb.id)}
                className="flex max-w-48 items-center gap-1.5 truncate rounded px-1.5 py-0.5 hover:bg-hover"
              >
                {crumb.icon && <span>{crumb.icon}</span>}
                <span className="truncate">{crumb.title || 'Untitled'}</span>
              </button>
            </li>
          ))}
        </ol>
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
        <article className="mx-auto w-full max-w-[900px] px-24 pt-20 max-md:px-6">
          {page.icon && <div className="mb-2 text-[64px] leading-none">{page.icon}</div>}
          <TitleInput key={pageId} workspace={workspace} pageId={pageId} onEnter={focusBody} />
          <div className="mt-2">
            {pageDoc ? (
              <PageEditor key={pageId} doc={pageDoc} services={services} onEditor={onEditor} />
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
  onEnter(): void;
}

/** Page title bound to its collaborative Y.Text in the workspace doc. */
function TitleInput({ workspace, pageId, onEnter }: TitleInputProps) {
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
    if (ytext.length === 0) ref.current?.focus();
  }, [ytext]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={title}
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
    };
  }, [workspace, pageId, navigate]);
}
