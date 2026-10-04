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

export type NumberFormat =
  | 'number'
  | 'commas'
  | 'percent'
  | 'dollar'
  | 'euro'
  | 'pound'
  | 'yen'
  | 'rupee'
  | 'yuan'
  | 'won'
  | 'real'
  | 'franc';

export type DateFormat = 'full' | 'mdy' | 'dmy' | 'ymd' | 'relative';
export type TimeFormat = '12h' | '24h';

export interface PropertyConfig {
  /** select, multiSelect, status. */
  options?: SelectOption[];
  /** uniqueId: shown before the number, e.g. `TASK-12`. */
  prefix?: string;
  /** number: how values are shown. */
  numberFormat?: NumberFormat;
  /** number: decimal places (default: as entered). */
  precision?: number;
  /** date, created time, last edited time. */
  dateFormat?: DateFormat;
  timeFormat?: TimeFormat;
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
  /** Notify before the start (see `DATE_REMINDERS`); none when absent. */
  reminder?: DateReminder | null;
}

/**
 * When to remind: for dates without a time, at 9:00 on the day or days before; for
 * dates with a time, before that time.
 */
export type DateReminder =
  'onDay' | '1d' | '2d' | '1w' | 'atTime' | '5m' | '10m' | '15m' | '30m' | '1h' | '2h';

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

// --- Filters -------------------------------------------------------------------------

/** One condition on a property; `value` depends on the operator (see filter.ts). */
export interface FilterRule {
  type: 'rule';
  id: string;
  propertyId: string;
  operator: string;
  value?: unknown;
}

/** Conditions joined with AND / OR; groups nest for advanced filters. */
export interface FilterGroup {
  type: 'group';
  id: string;
  conjunction: 'and' | 'or';
  filters: Filter[];
}

export type Filter = FilterRule | FilterGroup;

// --- Grouping ------------------------------------------------------------------------

export type DateBucket = 'relative' | 'day' | 'week' | 'month' | 'year';

export interface GroupBy {
  propertyId: string;
  /** Dates: bucket size. */
  dateBucket?: DateBucket;
  /** Text: whole value, or by first letter. */
  textBucket?: 'exact' | 'alphabetical';
  /** Numbers: bucket ranges. */
  numberRange?: { start: number; end: number; step: number };
  /** Status: one group per option, or per To-do / In progress / Complete. */
  statusBucket?: 'option' | 'group';
  /** Group keys hidden from the view. */
  hidden?: string[];
  /** Group keys shown collapsed. */
  collapsed?: string[];
  /** Hide groups without rows. */
  hideEmpty?: boolean;
  /** Order of groups (natural order of the property, or reversed). */
  sort?: 'asc' | 'desc';
}

// --- Calculations --------------------------------------------------------------------

export type CalculationId =
  | 'countAll'
  | 'countValues'
  | 'countUnique'
  | 'countEmpty'
  | 'countNotEmpty'
  | 'percentEmpty'
  | 'percentNotEmpty'
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  | 'earliest'
  | 'latest'
  | 'dateRange'
  | 'checked'
  | 'unchecked'
  | 'percentChecked'
  | 'percentUnchecked';

export interface ViewConfig {
  /** Column order, visibility and width. Properties missing here show at the end. */
  properties: ViewProperty[];
  sorts: Sort[];
  /** Root filter group (AND/OR of rules and nested groups); null for none. */
  filter: FilterGroup | null;
  groupBy: GroupBy | null;
  subGroupBy: GroupBy | null;
  /** Calculation shown under each column, by property id. */
  calculations: Record<string, CalculationId>;
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
  meta: DatabaseMeta;
}

/** Lookups that turn stored values into display text (and evaluate filters). */
export interface DisplayContext {
  /** User id -> name. */
  users: ReadonlyMap<string, string>;
  /** The current user, for "me" in person filters. */
  me?: string;
  /** "Now" for relative dates (defaults to the clock). */
  now?: number;
}

/** Database-wide settings, in the doc's `meta` map. */
export interface DatabaseMeta {
  /** Row pages fold empty properties away under "N more properties". */
  hideEmptyProperties: boolean;
}

export const META_MAP = 'meta';

export const DEFAULT_VIEW_CONFIG: ViewConfig = {
  properties: [],
  sorts: [],
  filter: null,
  groupBy: null,
  subGroupBy: null,
  calculations: {},
  openPagesIn: 'sidePeek',
  wrap: false,
};
