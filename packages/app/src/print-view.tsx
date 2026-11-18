import { listPages, type PageId, type PageMeta } from '@workspace/core';
import { compareSiblings, isInTrash } from '@workspace/core';
import { PageEditor, PageIcon } from '@workspace/editor';
import { useEffect, useMemo, useRef } from 'react';
import { useApp } from './context';
import { InlineDatabase } from './database/database-view';
import { useEditorServices } from './editor-services';
import { useDoc } from './hooks';
import { NavigationContext, type Navigation } from './navigation';

/** What `print=all` asks for: every page of the workspace. */
export const PRINT_ALL = 'all';

/**
 * `#print=<id>&subpages=1` (or `#print=all`, the whole workspace): this window only renders
 * pages for printing to PDF. `pageId` is null for the whole workspace.
 */
export function printFromLocation(): { pageId: PageId | null; subpages: boolean } | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const pageId = params.get('print');
  if (!pageId) return null;
  if (pageId === PRINT_ALL) return { pageId: null, subpages: true };
  return { pageId, subpages: params.get('subpages') === '1' };
}

/** The pages to print, in the sidebar's order, each with its depth (0: a top-level one). */
export function printOrder(
  all: readonly PageMeta[],
  pageId: PageId | null,
  subpages: boolean,
): { page: PageMeta; depth: number }[] {
  const byId = new Map(all.map((p) => [p.id, p]));
  const children = new Map<string | null, PageMeta[]>();
  for (const page of all) {
    // A page whose parent isn't printed (gone, or in the trash) counts as top-level.
    const parent = page.parentId && byId.has(page.parentId) ? page.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(page);
    children.set(parent, list);
  }
  const out: { page: PageMeta; depth: number }[] = [];
  const add = (page: PageMeta, depth: number) => {
    out.push({ page, depth });
    if (!subpages) return;
    for (const child of (children.get(page.id) ?? []).sort(compareSiblings)) add(child, depth + 1);
  };
  if (pageId === null) {
    for (const root of (children.get(null) ?? []).sort(compareSiblings)) add(root, 0);
  } else {
    const root = byId.get(pageId);
    if (root) add(root, 0);
  }
  return out;
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

/** The anchor of a page's section (the contents link to it). */
const sectionId = (id: PageId) => `print-${id}`;

/** A first sheet listing the pages, each linking to its own (the PDF keeps the links). */
function Contents({ entries }: { entries: { page: PageMeta; depth: number }[] }) {
  const { platform } = useApp();
  return (
    <nav aria-label="Contents" className="ws-print-section" data-testid="print-contents">
      <h1 className="mt-2 mb-4 text-4xl font-bold">Contents</h1>
      <ol className="flex flex-col gap-1">
        {entries.map(({ page, depth }) => (
          <li key={page.id} style={{ paddingLeft: `${depth * 1.5}rem` }}>
            <a
              href={`#${sectionId(page.id)}`}
              className="inline-flex items-center gap-1.5 no-underline"
            >
              {page.icon && <PageIcon icon={page.icon} size={16} fileUrl={platform.fileUrl} />}
              {page.title || 'Untitled'}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function PrintSection({ page, first }: { page: PageMeta; first: boolean }) {
  const { client, platform } = useApp();
  const database = page.kind === 'database';
  const doc = useDoc(client, database ? null : page.id);
  const services = useEditorServices(page.id);
  return (
    <section
      id={sectionId(page.id)}
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
 * A page (and optionally its sub-pages), or every page of the workspace (`pageId` null),
 * rendered read-only for printing, each from a new sheet; more than one page starts with
 * their contents. Tells the host once everything, images and diagrams included, has loaded.
 */
export function PrintView({ pageId, subpages }: { pageId: PageId | null; subpages: boolean }) {
  const { workspace, platform } = useApp();
  const entries = useMemo(
    () =>
      printOrder(
        listPages(workspace).filter((p) => !isInTrash(workspace, p.id)),
        pageId,
        subpages,
      ),
    [workspace, pageId, subpages],
  );

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
        {entries.length > 1 && <Contents entries={entries} />}
        {entries.map(({ page }, i) => (
          <PrintSection key={page.id} page={page} first={i === 0 && entries.length === 1} />
        ))}
      </div>
    </NavigationContext.Provider>
  );
}
