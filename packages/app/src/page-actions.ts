import {
  copyPageContent,
  duplicatePageTree,
  getPage,
  type DocClient,
  type PageId,
} from '@workspace/core';
import { copyDatabase } from '@workspace/database';
import type * as Y from 'yjs';

/**
 * Duplicate a page with all its sub-pages and content. Links between the copied
 * pages point at the copies; databases are copied with their rows. Returns the id of
 * the new top page.
 */
export async function duplicatePage(
  client: DocClient,
  workspace: Y.Doc,
  id: PageId,
): Promise<PageId> {
  const mapping = duplicatePageTree(workspace, id);
  for (const [fromId, toId] of mapping) {
    if (getPage(workspace, fromId)?.kind === 'database') {
      const rows = await withDocs(client, [fromId, toId], ([from, to]) =>
        copyDatabase(from!, to!, { fromViewSet: fromId, toViewSet: toId }),
      );
      for (const [fromRow, toRow] of rows) {
        await withDocs(client, [fromRow, toRow], ([from, to]) =>
          copyPageContent(from!, to!, mapping),
        );
      }
    } else {
      await withDocs(client, [fromId, toId], ([from, to]) => copyPageContent(from!, to!, mapping));
    }
  }
  return mapping.get(id)!;
}

async function withDocs<T>(client: DocClient, ids: string[], use: (docs: Y.Doc[]) => T) {
  const handles = ids.map((docId) => client.acquire(docId));
  try {
    await Promise.all(handles.map((h) => h.ready));
    return use(handles.map((h) => h.doc));
  } finally {
    handles.forEach((h) => h.release());
  }
}
