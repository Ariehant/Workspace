import type { PageCover, PageFont } from '@workspace/core';

/**
 * Layout of a *database doc* (guid = the database page's id):
 *
 * - `schema`: propertyId -> Y.Map { id, name, type, config, sortKey }
 * - `views`:  viewId -> Y.Map { id, viewSet, name, type, sortKey, ...ViewConfig }
 * - `rows`:   rowId -> Y.Map of page fields (title Y.Text, icon, cover, sortKey,
 *   createdAt, updatedAt, trashedAt, ...) plus `createdBy`, `updatedBy`, `uid` and
 *   `values` (Y.Map propertyId -> JSON value).
 *
 * Rows use the same field names as pages in the workspace doc, so the page chrome
 * (title, icon, cover, page options) works on them unchanged. A row's content is an
 * ordinary page doc with guid = row id.
 */
export const SCHEMA_MAP = 'schema';
export const VIEWS_MAP = 'views';
export const ROWS_MAP = 'rows';

/** Row fields beyond the shared page fields. */
export const RowField = {
  createdBy: 'createdBy',
  updatedBy: 'updatedBy',
  uid: 'uid',
  values: 'values',
} as const;

/** The title property: every database has exactly one, and it can't be deleted. */
export const TITLE_PROPERTY_ID = 'title';

export type PropertyType =
  | 'title'
  | 'text'
  | 'number'
  | 'select'
  | 'multiSelect'
  | 'status'
  | 'date'
  | 'checkbox'
  | 'url'
  | 'email'
  | 'phone'
  | 'files'
  | 'person'
  | 'createdTime'
  | 'createdBy'
  | 'lastEditedTime'
  | 'lastEditedBy'
  | 'uniqueId';

/** Notion's option palette (also used for text colors). */
export const OPTION_COLORS = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export type StatusGroup = 'todo' | 'inProgress' | 'complete';

export interface SelectOption {
  id: string;
  name: string;
  color: OptionColor;
  /** Status options only. */
  group?: StatusGroup;
}

export interface PropertyConfig {
  /** select, multiSelect, status. */
  options?: SelectOption[];
  /** uniqueId: shown before the number, e.g. `TASK-12`. */
  prefix?: string;
}

export interface Property {
  id: string;
  name: string;
  type: PropertyType;
  config: PropertyConfig;
  /** Default order (row page panel, new views). Views keep their own column order. */
  sortKey: string;
}

/** `YYYY-MM-DD`, or `YYYY-MM-DDTHH:mm` when it includes a time (local time). */
export interface DateValue {
  start: string;
  end?: string | null;
}

/** A file in the workspace file store (`id`) or a link to one on the web (`url`). */
export interface FileValue {
  id?: string;
  url?: string;
  name: string;
  mime?: string;
}

export type ViewType = 'table';

export type OpenPagesIn = 'sidePeek' | 'center' | 'fullPage';

export interface ViewProperty {
  id: string;
  visible: boolean;
  /** Column width in pixels (table). */
  width?: number;
}

export interface Sort {
  propertyId: string;
  direction: 'asc' | 'desc';
}

export interface ViewConfig {
  /** Column order, visibility and width. Properties missing here show at the end. */
  properties: ViewProperty[];
  sorts: Sort[];
  openPagesIn: OpenPagesIn;
  /** Wrap long cell content instead of cutting it off. */
  wrap: boolean;
}

export interface View extends ViewConfig {
  id: string;
  /**
   * The group of views this view belongs to: the database's own views use the
   * database id, a linked view block uses its block id.
   */
  viewSet: string;
  name: string;
  type: ViewType;
  sortKey: string;
}

/** Plain snapshot of a row. */
export interface Row {
  id: string;
  title: string;
  icon: string | null;
  cover: PageCover | null;
  sortKey: string;
  createdAt: number;
  createdBy: string | null;
  updatedAt: number;
  updatedBy: string | null;
  /** Sequence number for the unique ID property. */
  uid: number;
  trashedAt: number | null;
  fullWidth: boolean;
  smallText: boolean;
  font: PageFont;
  locked: boolean;
  /** Stored property values by property id (computed properties aren't stored). */
  values: Readonly<Record<string, unknown>>;
}

export interface DatabaseSnapshot {
  /** In default order (title first). */
  properties: Property[];
  views: View[];
  /** Every row including trashed ones, in manual order. */
  rows: Row[];
}

/** Lookups that turn stored values into display text. */
export interface DisplayContext {
  /** User id -> name. */
  users: ReadonlyMap<string, string>;
}

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  properties: [],
  sorts: [],
  openPagesIn: 'sidePeek',
  wrap: false,
};
