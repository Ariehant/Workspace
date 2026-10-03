import { copyPageContent, duplicatePageTree, type DocClient, type PageId } from '@workspace/core';
import type * as Y from 'yjs';

/**
 * Duplicate a page with all its sub-pages and content. Links between the copied
 * pages point at the copies. Returns the id of the new top page.
 */
export async function duplicatePage(
  client: DocClient,
  workspace: Y.Doc,
  id: PageId,
): Promise<PageId> {
  const mapping = duplicatePageTree(workspace, id);
  for (const [fromId, toId] of mapping) {
    const from = client.acquire(fromId);
    const to = client.acquire(toId);
    try {
      await Promise.all([from.ready, to.ready]);
      copyPageContent(from.doc, to.doc, mapping);
    } finally {
      from.release();
      to.release();
    }
  }
  return mapping.get(id)!;
}
