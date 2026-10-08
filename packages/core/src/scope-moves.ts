/**
 * Moving a page (with its sub-pages) from one scope's tree doc to another's: what the
 * server does when a page is shared on its own or moved to another teamspace. Pure Yjs
 * edits; the caller stores both docs' updates and moves the pages' docs.
 */
import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { PageField, type PageId } from './schema';
import { getPagesMap, isStub } from './workspace';

/** A page and every page under it (stubs included: they move along as stubs). */
export function subtreeIds(tree: Y.Doc, rootId: PageId): PageId[] {
  const pages = getPagesMap(tree);
  if (!pages.has(rootId)) return [];
  const children = new Map<string, string[]>();
  for (const [id, page] of pages) {
    const parent = page.get(PageField.parentId) as string | null | undefined;
    if (!parent) continue;
    let list = children.get(parent);
    if (!list) children.set(parent, (list = []));
    list.push(id);
  }
  const out: PageId[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of children.get(id) ?? []) visit(child);
  };
  visit(rootId);
  return out;
}

/** A copy of a page entry for another doc (Y.Text title copied as text). */
function copyEntry(page: Y.Map<unknown>): Y.Map<unknown> {
  const copy = new Y.Map<unknown>();
  for (const [key, value] of page) {
    if (value instanceof Y.Text) {
      const text = new Y.Text();
      text.insert(0, value.toString());
      copy.set(key, text);
    } else if (value instanceof Y.AbstractType) {
      copy.set(key, value.toJSON());
    } else {
      copy.set(key, value);
    }
  }
  return copy;
}

export interface MoveOptions {
  /** Where the page goes in the target tree: under this page, or at the top. */
  parentId?: PageId | null;
  /**
   * Leave a stub where the page was (sharing a page: people with the source scope still
   * see it in place). Without it, the page is just gone from the source tree (moved).
   */
  stubScope?: string | null;
}

/**
 * Move page `rootId` and its sub-pages from `from` to `to`. Returns the moved page ids
 * (the docs to re-place), or [] if the page isn't in `from`.
 */
export function moveSubtree(
  from: Y.Doc,
  to: Y.Doc,
  rootId: PageId,
  options: MoveOptions = {},
): PageId[] {
  const ids = subtreeIds(from, rootId);
  if (ids.length === 0) return [];
  const source = getPagesMap(from);
  const target = getPagesMap(to);
  const root = source.get(rootId)!;
  const parentId =
    options.parentId === undefined
      ? ((root.get(PageField.parentId) as string | null | undefined) ?? null)
      : options.parentId;
  to.transact(() => {
    for (const id of ids) {
      const entry = copyEntry(source.get(id)!);
      if (id === rootId) {
        entry.set(PageField.parentId, parentId);
        if (options.parentId !== undefined) {
          // At the end of its new siblings.
          let last: string | null = null;
          for (const page of target.values()) {
            if ((page.get(PageField.parentId) ?? null) !== parentId) continue;
            const key = page.get(PageField.sortKey) as string;
            if (last === null || key > last) last = key;
          }
          entry.set(PageField.sortKey, generateKeyBetween(last, null));
        }
      }
      target.set(id, entry);
    }
  });
  // Read before deleting: a deleted Y.Map forgets its content.
  const place = {
    parentId: (root.get(PageField.parentId) as string | null | undefined) ?? null,
    sortKey: root.get(PageField.sortKey) as string,
  };
  from.transact(() => {
    for (const id of ids) source.delete(id);
    if (options.stubScope) {
      const stub = new Y.Map<unknown>();
      stub.set(PageField.id, rootId);
      stub.set(PageField.parentId, place.parentId);
      stub.set(PageField.sortKey, place.sortKey);
      stub.set(PageField.scope, options.stubScope);
      source.set(rootId, stub);
    }
  });
  return ids.filter((id) => !isStub(target.get(id)!));
}
