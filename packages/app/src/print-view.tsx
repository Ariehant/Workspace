import { getPage, listPages, type PageId, type PageMeta } from '@workspace/core';
import { compareSiblings, isInTrash } from '@workspace/core';
import { PageEditor, PageIcon } from '@workspace/editor';
import { useEffect, useMemo, useRef } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { useEditorServices } from './editor-services';
import { useDoc } from './hooks';
import { NavigationContext, type Navigation } from './navigation';

/** `#print=<id>&subpages=1`: this window only renders a page for printing to PDF. */
export function printFromLocation(): { pageId: PageId; subpages: boolean } | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const pageId = params.get('print');
  return pageId ? { pageId, subpages: params.get('subpages') === '1' } : null;
}

const NO_NAVIGATION: Navigation = {
  navigate: () => {},
  openRow: () => {},
  navigateToBlock: () => {},
};

const READY_TIMEOUT_MS = 20_000;

/** True once images and diagrams in the page have finished loading. */
function settled(root: HTMLElement): boolean {
  if (root.querySelector('[aria-busy="true"]')) return false;
  const diagrams = [...root.querySelectorAll('.ws-mermaid')];
  if (diagrams.some((d) => !d.querySelector('img, [data-testid="mermaid-error"]'))) return false;
  return [...root.querySelectorAll('img')].every((img) => img.complete);
}

function PrintSection({ page, first }: { page: PageMeta; first: boolean }) {
  const { client, platform } = useApp();
  const database = page.kind === 'database';
  const doc = useDoc(client, database ? null : page.id);
  const services = useEditorServices(page.id);
  return (
    <section
      className="ws-print-section"
      style={first ? undefined : { breakBefore: 'page' }}
      data-testid="print-section"
      aria-busy={!database && !doc}
    >
      {page.icon && <PageIcon icon={page.icon} size={48} fileUrl={platform.fileUrl} />}
      <h1 className="mt-2 mb-4 text-4xl font-bold">{page.title || 'Untitled'}</h1>
      {database ? (
        <InlineDatabase databaseId={page.id} />
      ) : (
        doc && <PageEditor doc={doc} services={services} editable={false} nested />
      )}
    </section>
  );
}

/**
 * A page (and optionally its sub-pages, each from a new sheet) rendered read-only for
 * printing. Tells the host once everything, images and diagrams included, has loaded.
 */
export function PrintView({ pageId, subpages }: { pageId: PageId; subpages: boolean }) {
  const { workspace, platform } = useApp();
  const pages = useMemo(() => {
    const root = getPage(workspace, pageId);
    if (!root) return [];
    const all = listPages(workspace).filter((p) => !isInTrash(workspace, p.id));
    const out: PageMeta[] = [];
    const add = (page: PageMeta) => {
      out.push(page);
      if (!subpages) return;
      all
        .filter((p) => p.parentId === page.id)
        .sort(compareSiblings)
        .forEach(add);
    };
    add(root);
    return out;
  }, [workspace, pageId, subpages]);

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const started = Date.now();
    let done = false;
    let frame = 0;
    const timer = setInterval(() => {
      const root = ref.current;
      if (done || !root) return;
      if (!settled(root) && Date.now() - started < READY_TIMEOUT_MS) return;
      done = true;
      clearInterval(timer);
      // Let layout catch up before printing.
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => platform.printReady());
      });
    }, 150);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(frame);
    };
  }, [platform]);

  return (
    <NavigationContext.Provider value={NO_NAVIGATION}>
      <div ref={ref} className="ws-print mx-auto max-w-[720px] bg-surface px-2 py-4">
        {pages.map((page, i) => (
          <PrintSection key={page.id} page={page} first={i === 0} />
        ))}
      </div>
    </NavigationContext.Provider>
  );
}
