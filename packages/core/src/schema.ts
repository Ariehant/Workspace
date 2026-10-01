/**
 * Shape of the Yjs documents that hold all workspace data.
 *
 * - One *workspace doc* (guid `WORKSPACE_DOC_ID`) holds the metadata of every page:
 *   title, icon, position in the page tree and trash state. The sidebar, search index
 *   and page tree read only this doc, so they never have to load page content.
 * - One *page doc* per page (guid = page id) holds the page content as a ProseMirror
 *   XML fragment under `PAGE_CONTENT_FIELD`.
 */
export const WORKSPACE_DOC_ID = 'workspace';

/** Top-level Y.Map in the workspace doc: pageId -> Y.Map of page fields. */
export const PAGES_MAP = 'pages';

/** Y.XmlFragment in a page doc that the editor binds to. */
export const PAGE_CONTENT_FIELD = 'content';

export type PageId = string;

/** Plain-object snapshot of a page's metadata. */
export interface PageMeta {
  id: PageId;
  /** Parent page, or `null` for a top-level page. */
  parentId: PageId | null;
  title: string;
  /** Emoji or image reference; `null` for the default icon. */
  icon: string | null;
  /** Fractional index ordering the page among its siblings. */
  sortKey: string;
  createdAt: number;
  updatedAt: number;
  /** When the page itself was moved to the trash, or `null`. */
  trashedAt: number | null;
}

/** Keys stored in each page's Y.Map inside the workspace doc. */
export const PageField = {
  id: 'id',
  parentId: 'parentId',
  title: 'title',
  icon: 'icon',
  sortKey: 'sortKey',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  trashedAt: 'trashedAt',
} as const;
