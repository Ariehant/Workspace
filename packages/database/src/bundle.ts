import {
  compareSiblings,
  copyPageContent,
  createPage,
  getDescendantIds,
  getPage,
  isInTrash,
  newId,
  setPageOptions,
  type PageId,
  type PageMeta,
} from '@workspace/core';
import * as Y from 'yjs';
import { copyDatabase } from './copy';
import { readDatabase } from './doc';

/**
 * A page tree packed up to be copied in later (page templates): the pages' metadata
 * and the state of every doc behind them — pages, databases and database rows.
 */
export interface PageBundle {
  root: PageId;
  pages: PageMeta[];
  docs: Record<string, Uint8Array>;
}

/** Run `use` on a doc, loaded for the duration of the call. */
export type WithDoc = <T>(id: string, use: (doc: Y.Doc) => T) => Promise<T>;

const isEmpty = (doc: Y.Doc) => Y.encodeStateVector(doc).length <= 1;

/** Pack a page with its sub-pages (not those in the trash), databases and rows. */
export async function captureBundle(
  workspace: Y.Doc,
  rootId: PageId,
  withDoc: WithDoc,
): Promise<PageBundle> {
  const root = getPage(workspace, rootId);
  if (!root) throw new Error(`Page not found: ${rootId}`);
  const pages = [
    root,
    ...getDescendantIds(workspace, rootId)
      .filter((id) => !isInTrash(workspace, id))
      .map((id) => getPage(workspace, id)!),
  ];
  const docs: Record<string, Uint8Array> = {};
  const save = (id: string, doc: Y.Doc) => {
    if (!isEmpty(doc)) docs[id] = Y.encodeStateAsUpdate(doc);
  };
  for (const page of pages) {
    const rows = await withDoc(page.id, (doc) => {
      save(page.id, doc);
      return page.kind === 'database' ? readDatabase(doc).rows.map((r) => r.id) : [];
    });
    for (const row of rows) await withDoc(row, (doc) => save(row, doc));
  }
  return { root: rootId, pages, docs };
}

function loadDoc(bundle: PageBundle, id: string): Y.Doc {
  const doc = new Y.Doc();
  const state = bundle.docs[id];
  if (state) Y.applyUpdate(doc, state);
  return doc;
}

/**
 * Copy a bundle into the workspace under `parentId`, every page, database and row with
 * a fresh id. Links, relations and inline databases between them point at the copies.
 * Returns the new root page's id.
 */
export async function instantiateBundle(
  bundle: PageBundle,
  workspace: Y.Doc,
  options: { parentId: PageId | null; withDoc: WithDoc; now?: number },
): Promise<PageId> {
  const now = options.now ?? Date.now();
  const byParent = new Map<PageId | null, PageMeta[]>();
  for (const page of bundle.pages) {
    const parent = page.id === bundle.root ? null : page.parentId;
    byParent.set(parent, [...(byParent.get(parent) ?? []), page]);
  }
  const pageIds = new Map<PageId, PageId>();
  workspace.transact(() => {
    const copy = (page: PageMeta, parentId: PageId | null) => {
      const id = createPage(workspace, {
        parentId,
        title: page.title,
        icon: page.icon,
        kind: page.kind,
        now,
      });
      const { cover, fullWidth, smallText, font, locked } = page;
      setPageOptions(workspace, id, { cover, fullWidth, smallText, font, locked }, now);
      pageIds.set(page.id, id);
      for (const child of (byParent.get(page.id) ?? []).sort(compareSiblings)) copy(child, id);
    };
    const root = bundle.pages.find((p) => p.id === bundle.root);
    if (!root) throw new Error('Template has no root page');
    copy(root, options.parentId);
  });

  // Rows get their ids up front, so relations between the databases link the copies.
  const sources = new Map(bundle.pages.map((p) => [p.id, loadDoc(bundle, p.id)]));
  const rowIds = new Map<string, string>();
  for (const page of bundle.pages) {
    if (page.kind !== 'database') continue;
    for (const row of readDatabase(sources.get(page.id)!).rows) rowIds.set(row.id, newId());
  }
  const remap = new Map([...pageIds, ...rowIds]);

  for (const page of bundle.pages) {
    const from = sources.get(page.id)!;
    const to = pageIds.get(page.id)!;
    if (page.kind === 'database') {
      await options.withDoc(to, (doc) =>
        copyDatabase(from, doc, {
          fromViewSet: page.id,
          toViewSet: to,
          databases: pageIds,
          rows: rowIds,
        }),
      );
    } else {
      await options.withDoc(to, (doc) => copyPageContent(from, doc, remap));
    }
  }
  for (const [fromRow, toRow] of rowIds) {
    if (!bundle.docs[fromRow]) continue;
    const from = loadDoc(bundle, fromRow);
    await options.withDoc(toRow, (doc) => copyPageContent(from, doc, remap));
    from.destroy();
  }
  sources.forEach((doc) => doc.destroy());
  return pageIds.get(bundle.root)!;
}
