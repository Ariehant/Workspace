import { compareSiblings } from './workspace';
import type { PageId, PageMeta } from './schema';

export interface PageTreeNode {
  page: PageMeta;
  children: PageTreeNode[];
}

export interface BuildPageTreeOptions {
  /** Include pages that are (or sit under) a trashed page. Default `false`. */
  includeTrashed?: boolean;
}

/**
 * Build the sidebar tree from flat page metadata.
 *
 * Concurrent moves on different devices can leave a page whose parent is gone or
 * whose ancestry loops back on itself. Such pages are shown at the top level so
 * nothing ever disappears from the tree.
 */
export function buildPageTree(
  pages: readonly PageMeta[],
  options: BuildPageTreeOptions = {},
): PageTreeNode[] {
  const byId = new Map<PageId, PageMeta>(pages.map((p) => [p.id, p]));

  const effectiveParent = (page: PageMeta): PageId | null => {
    if (page.parentId === null || !byId.has(page.parentId)) return null;
    const seen = new Set<PageId>([page.id]);
    let current: PageId | null = page.parentId;
    while (current !== null) {
      if (seen.has(current)) return null;
      seen.add(current);
      const parent = byId.get(current);
      if (!parent) break;
      current = parent.parentId;
    }
    return page.parentId;
  };

  const nodes = new Map<PageId, PageTreeNode>();
  for (const page of pages) nodes.set(page.id, { page, children: [] });

  const roots: PageTreeNode[] = [];
  for (const page of pages) {
    const node = nodes.get(page.id)!;
    const parentId = effectiveParent(page);
    if (parentId === null) roots.push(node);
    else nodes.get(parentId)!.children.push(node);
  }

  const finish = (list: PageTreeNode[]): PageTreeNode[] => {
    const kept = options.includeTrashed ? list : list.filter((n) => n.page.trashedAt === null);
    kept.sort((a, b) => compareSiblings(a.page, b.page));
    for (const node of kept) node.children = finish(node.children);
    return kept;
  };
  return finish(roots);
}
