import { copyPageContent, type DocClient } from '@workspace/core';
import { duplicateRow, type DatabaseHandle } from '@workspace/database';

/** Duplicate a row with its page content, right after it. Resolves the copy's id. */
export async function duplicateRowWithContent(
  client: DocClient,
  handle: DatabaseHandle,
  rowId: string,
  actor: string,
): Promise<string> {
  const copy = duplicateRow(handle.doc, rowId, actor);
  const from = client.acquire(rowId);
  const to = client.acquire(copy);
  try {
    await Promise.all([from.ready, to.ready]);
    copyPageContent(from.doc, to.doc);
  } finally {
    from.release();
    to.release();
  }
  return copy;
}
