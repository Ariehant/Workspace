import { getPage, type Forest, type ScopeMoveError, type TreeInfo } from '@workspace/core';
import type { PageDirectory } from './pages';
import type { TeamApi } from './team';

/**
 * The scope a doc belongs in, for a doc the server may not have seen: its page's tree's
 * (a row's database's; comments go with their page). `null` if unknown.
 */
export function scopeOfDoc(forest: Forest, pages: PageDirectory, docId: string): string | null {
  const tree = forest.get(docId);
  if (tree) return tree.info.scope;
  const pageId = docId.startsWith('comments:') ? docId.slice('comments:'.length) : docId;
  const host = forest.treeOf(pageId) ? pageId : pages.databaseOf(pageId);
  return (host && forest.treeOf(host)?.info.scope) || null;
}

/** How a section reads in a sentence ("Move it to …"). */
export function sectionName(info: TreeInfo): string {
  if (info.kind === 'private') return 'your private pages';
  if (info.kind === 'shared') return 'a shared page';
  return info.name || 'the teamspace';
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A page dropped (or moved) into another section: that's another scope, so the server
 * moves it, with its sub-pages, once the person confirms (who can see it changes).
 * Resolves whether it moved.
 */
export async function moveAcrossScopes(
  forest: Forest,
  team: TeamApi | null,
  error: ScopeMoveError,
  confirm: (text: string) => boolean = (text) => window.confirm(text),
): Promise<boolean> {
  const from = forest.get(error.from)?.info;
  const to = forest.get(error.to)?.info;
  if (!team || !from?.scope || !to?.scope) return false;
  const title = getPage(forest, error.pageId)?.title || 'Untitled';
  const where = sectionName(to);
  if (
    !confirm(
      `Move “${title}” to ${where}? It (and its sub-pages) will have the access of ${where}, ` +
        'so who can see it may change.',
    )
  ) {
    return false;
  }
  try {
    await team.movePage(error.pageId, from.scope, to.scope, error.parentId);
    return true;
  } catch (e) {
    window.alert(
      `Couldn’t move “${title}”: ${message(e)}\n\nMoving a page to another section needs a ` +
        'connection to the server.',
    );
    return false;
  }
}
