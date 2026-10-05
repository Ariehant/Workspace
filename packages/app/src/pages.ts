import { getAncestorIds, getPage, isInTrash, listPages, type PageId } from '@workspace/core';
import type { PageRef } from '@workspace/editor';
import type * as Y from 'yjs';
import { isLiveRow } from '@workspace/database';
import type { DatabaseRegistry } from './database/registry';

/**
 * Pages and database rows behind one lookup: a row is a page whose "parent" is its
 * database, so breadcrumbs, links, mentions and history treat both alike.
 */
export class PageDirectory {
  constructor(
    private readonly workspace: Y.Doc,
    private readonly databases: DatabaseRegistry,
  ) {}

  /** Title, icon and trash state of a page or row; null if unknown (or still loading). */
  get(id: PageId): PageRef | null {
    const page = getPage(this.workspace, id);
    if (page)
      return {
        id,
        title: page.title,
        icon: page.icon,
        inTrash: isInTrash(this.workspace, id),
        isDatabase: page.kind === 'database',
      };
    const found = this.databases.row(id);
    if (!found) return null;
    const { row, databaseId } = found;
    return {
      id,
      title: row.title,
      icon: row.icon,
      inTrash: row.trashedAt !== null || isInTrash(this.workspace, databaseId),
    };
  }

  exists(id: PageId): boolean {
    return this.get(id) !== null;
  }

  /** The database of a row; null for pages. */
  databaseOf(id: PageId): string | null {
    if (getPage(this.workspace, id)) return null;
    return this.databases.databaseOf(id)?.id ?? null;
  }

  /** The workspace page new sub-pages of `id` go under (a row's go under its database). */
  hostOf(id: PageId): PageId | null {
    if (getPage(this.workspace, id)) return id;
    return this.databaseOf(id);
  }

  /** Ancestors (outermost first), then the page itself. */
  breadcrumb(id: PageId): PageRef[] {
    const databaseId = this.databaseOf(id);
    const chain = databaseId
      ? [...this.breadcrumb(databaseId).map((p) => p.id), id]
      : [...getAncestorIds(this.workspace, id).reverse(), id];
    return chain.map((pid) => this.get(pid)).filter((p): p is PageRef => p !== null);
  }

  /** Pages and rows of loaded databases, most recently edited first. */
  list(): PageRef[] {
    const pages = listPages(this.workspace)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((p) => this.get(p.id)!);
    const rows = this.databases.loaded().flatMap((handle) =>
      handle
        .snapshot()
        .rows.filter(isLiveRow)
        .map((r) => ({ id: r.id, title: r.title, icon: r.icon, inTrash: false })),
    );
    return [...pages, ...rows];
  }

  subscribe(listener: () => void): () => void {
    this.workspace.on('update', listener);
    const off = this.databases.subscribe(listener);
    return () => {
      this.workspace.off('update', listener);
      off();
    };
  }
}
