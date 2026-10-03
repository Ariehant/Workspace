import { PageIcon } from '../page-icon';
import { NodeViewWrapper, useEditorState, type ReactNodeViewProps } from '@tiptap/react';
import { cn } from '@workspace/ui';
import { ArrowUpRight } from 'lucide-react';
import { useBreadcrumb, useEditorServices, usePageRef } from '../services';
import { atomBlock } from './atom';

// --- Link to page ------------------------------------------------------------------

function PageLinkView({ node, selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const pageId = node.attrs.pageId as string | null;
  const page = usePageRef(pageId);
  const missing = !page || page.inTrash;
  return (
    <NodeViewWrapper>
      <button
        type="button"
        contentEditable={false}
        data-testid="page-link"
        onClick={() => pageId && !missing && services.navigate(pageId)}
        className={cn(
          'ws-page-link flex w-full items-center gap-1.5 rounded px-0.5 py-1 text-left hover:bg-hover',
          selected && 'bg-hover',
          missing && 'text-faint',
        )}
      >
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <PageIcon icon={page?.icon ?? null} size={18} fileUrl={services.fileUrl} />
          <ArrowUpRight size={10} strokeWidth={3} className="absolute -right-0.5 -bottom-0.5" />
        </span>
        <span className="truncate border-b border-line font-medium">
          {missing ? 'Deleted page' : page.title || 'Untitled'}
        </span>
      </button>
    </NodeViewWrapper>
  );
}

export const PageLink = atomBlock('pageLink', PageLinkView, {
  pageId: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-page-id'),
    renderHTML: (attrs: Record<string, unknown>) => ({ 'data-page-id': attrs.pageId }),
  },
});

// --- Breadcrumb --------------------------------------------------------------------

function BreadcrumbView({ selected }: ReactNodeViewProps) {
  const services = useEditorServices();
  const crumbs = useBreadcrumb();
  return (
    <NodeViewWrapper>
      <nav
        contentEditable={false}
        aria-label="Page path"
        className={cn(
          'flex flex-wrap items-center gap-1 rounded py-1 text-sm text-muted',
          selected && 'bg-hover',
        )}
      >
        {crumbs.map((crumb, i) => (
          <span key={crumb.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-faint">/</span>}
            <button
              type="button"
              onClick={() => services.navigate(crumb.id)}
              className="flex items-center gap-1 rounded px-1 hover:bg-hover"
            >
              {crumb.icon && <PageIcon icon={crumb.icon} size={14} fileUrl={services.fileUrl} />}
              <span className="underline decoration-line underline-offset-2">
                {crumb.title || 'Untitled'}
              </span>
            </button>
          </span>
        ))}
      </nav>
    </NodeViewWrapper>
  );
}

export const Breadcrumb = atomBlock('breadcrumb', BreadcrumbView);

// --- Table of contents -------------------------------------------------------------

interface Heading {
  id: string | null;
  level: number;
  text: string;
}

function TableOfContentsView({ editor, selected }: ReactNodeViewProps) {
  const headings = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const list: Heading[] = [];
      e.state.doc.descendants((node) => {
        if (node.type.name === 'heading') {
          list.push({
            id: node.attrs.id as string | null,
            level: node.attrs.level as number,
            text: node.textContent,
          });
        }
        return !node.isTextblock;
      });
      return list;
    },
  });

  // Indent relative to the page's top heading level, so a page of H2s isn't indented.
  const topLevel = Math.min(...headings.map((h) => h.level));

  const jump = (id: string | null) => {
    if (!id) return;
    editor.view.dom
      .querySelector(`[data-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <NodeViewWrapper>
      <nav
        contentEditable={false}
        aria-label="Table of contents"
        className={cn('flex flex-col rounded py-1', selected && 'bg-hover')}
      >
        {headings.length === 0 && (
          <p className="px-1 text-sm text-muted">Add headings to create a table of contents.</p>
        )}
        {headings.map((h, i) => (
          <button
            key={h.id ?? i}
            type="button"
            onClick={() => jump(h.id)}
            style={{ paddingLeft: 4 + (h.level - topLevel) * 20 }}
            className="truncate rounded py-0.5 text-left text-sm text-muted underline decoration-line underline-offset-4 hover:bg-hover"
          >
            {h.text || 'Untitled'}
          </button>
        ))}
      </nav>
    </NodeViewWrapper>
  );
}

export const TableOfContents = atomBlock('tableOfContents', TableOfContentsView);
