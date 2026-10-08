import { getPage, newId, type DocClient, type PageId, type PageTree } from '@workspace/core';
import {
  captureBundle,
  instantiateBundle,
  type PageBundle,
  type WithDoc,
} from '@workspace/database';
import type * as Y from 'yjs';

/** The doc holding "My templates" (kept like any other doc, so it syncs later too). */
export const TEMPLATES_DOC_ID = 'templates';
const TEMPLATES_MAP = 'templates';

export interface SavedTemplate {
  id: string;
  name: string;
  icon: string | null;
  createdAt: number;
  bundle: PageBundle;
}

export const templatesMap = (doc: Y.Doc) => doc.getMap<SavedTemplate>(TEMPLATES_MAP);

/** Saved templates, newest first. */
export function listSavedTemplates(doc: Y.Doc): SavedTemplate[] {
  return [...templatesMap(doc).values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function deleteSavedTemplate(doc: Y.Doc, id: string): void {
  templatesMap(doc).delete(id);
}

/** Load each doc through the client while `use` runs. */
export function clientDocs(client: DocClient): WithDoc {
  return async (id, use) => {
    const handle = client.acquire(id);
    try {
      await handle.ready;
      return use(handle.doc);
    } finally {
      handle.release();
    }
  };
}

/** "Save as template": pack the page (and its sub-pages and databases) into My templates. */
export async function saveAsTemplate(
  client: DocClient,
  workspace: PageTree,
  pageId: PageId,
): Promise<string> {
  const page = getPage(workspace, pageId);
  if (!page) throw new Error(`Page not found: ${pageId}`);
  const bundle = await captureBundle(workspace, pageId, clientDocs(client));
  const handle = client.acquire(TEMPLATES_DOC_ID);
  try {
    await handle.ready;
    const id = newId();
    templatesMap(handle.doc).set(id, {
      id,
      name: page.title || 'Untitled',
      icon: page.icon,
      createdAt: Date.now(),
      bundle,
    });
    return id;
  } finally {
    handle.release();
  }
}

/** "Use template": a copy of the template at the top level. Resolves its page id. */
export function applyTemplate(
  client: DocClient,
  workspace: PageTree,
  bundle: PageBundle,
  parentId: PageId | null = null,
): Promise<PageId> {
  return instantiateBundle(bundle, workspace, { parentId, withDoc: clientDocs(client) });
}
