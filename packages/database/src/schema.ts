import type { ButtonConfig } from '@workspace/core';
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
  /** Set on template rows: pages new rows are made from, hidden from views. */
  template: 'template',
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
  | 'uniqueId'
  | 'formula'
  | 'relation'
  | 'rollup'
  | 'button';

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
  /** formula: the expression, with properties as `prop("Name")`. */
  expression?: string;
  /**
   * formula: the type of its result and its error, if any. Computed when formulas are
   * applied to a snapshot (see `applyFormulas`), never stored.
   */
  resultType?: FormulaResultType;
  formulaError?: string;
  /** relation: the database it links to (may be this database). */
  databaseId?: string;
  /** relation: the synced property in the other database (two-way relations). */
  syncedPropertyId?: string | null;
  /** relation: at most one linked page. */
  limitOne?: boolean;
  /** button: what clicking it does (per row). */
  button?: ButtonConfig;
  /** rollup: the relation it goes through and the property it reads there. */
  relationId?: string;
  targetPropertyId?: string;
  calculation?: RollupCalculation;
}

/** What a rollup computes over the related pages' values. */
export type RollupCalculation =
  | 'showOriginal'
  | 'showUnique'
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

/** What a formula's result is shown and filtered as. */
export type FormulaResultType = 'number' | 'text' | 'boolean' | 'date';

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

export type ViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline' | 'chart';

export const VIEW_TYPES: { type: ViewType; label: string }[] = [
  { type: 'table', label: 'Table' },
  { type: 'board', label: 'Board' },
  { type: 'list', label: 'List' },
  { type: 'gallery', label: 'Gallery' },
  { type: 'calendar', label: 'Calendar' },
  { type: 'timeline', label: 'Timeline' },
  { type: 'chart', label: 'Chart' },
];

export type TimelineZoom = 'hours' | 'day' | 'week' | 'biweek' | 'month' | 'quarter' | 'year';

export type ChartType = 'bar' | 'horizontalBar' | 'line' | 'pie' | 'donut';

/** Chart view settings: what the X axis groups by and what the Y axis measures. */
export interface ChartConfig {
  type: ChartType;
  /** Property the X axis (or pie slices) groups by; with its buckets. */
  x: GroupBy | null;
  /** Count rows, or a calculation over a number property. */
  y:
    | { kind: 'count' }
    | { kind: 'property'; propertyId: string; calc: 'sum' | 'average' | 'median' | 'min' | 'max' };
  /** Split each bar / line into series by another property. */
  series: GroupBy | null;
  stacked: boolean;
  sort: 'manual' | 'xAsc' | 'xDesc' | 'yAsc' | 'yDesc';
  legend: boolean;
  labels: boolean;
  /** Leave out categories without rows. */
  hideEmpty: boolean;
}

/** What a board or gallery card shows above its title. */
export type CardPreview =
  | { kind: 'none' }
  | { kind: 'cover' }
  | { kind: 'content' }
  | { kind: 'property'; propertyId: string };

export type CardSize = 'small' | 'medium' | 'large';

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
  /** Board and gallery: the image on cards, fit inside (or cropped to) the preview area. */
  cardPreview: CardPreview;
  fitImage: boolean;
  cardSize: CardSize;
  /** Board: tint columns with their group's color. */
  colorColumns: boolean;
  /**
   * Calendar and timeline: the date property rows are placed by (default: the first
   * date property). Timelines can take the end from another date property.
   */
  dateProperty: string | null;
  endDateProperty: string | null;
  calendarMode: 'month' | 'week';
  /** 0 = Sunday, 1 = Monday. */
  weekStart: 0 | 1;
  timelineZoom: TimelineZoom;
  /** Timeline: the table of rows on the left. */
  timelineTable: boolean;
  /** Timeline: arrows between dependent rows (see `DatabaseMeta.dependencies`). */
  showDependencies: boolean;
  chart: ChartConfig;
  /**
   * The template "New" uses in this view: a template id, `'none'` for an empty page,
   * or null for the database's default.
   */
  defaultTemplateId: string | null;
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
  /** A template, not a row: new rows can start from it; views don't show it. */
  isTemplate: boolean;
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
  /** Pages of related databases (set on computed snapshots). */
  related?: ReadonlyMap<string, RelatedPage>;
}

/** Lookups that turn stored values into display text (and evaluate filters). */
export interface DisplayContext {
  /** User id -> name. */
  users: ReadonlyMap<string, string>;
  /** The current user, for "me" in person filters. */
  me?: string;
  /** "Now" for relative dates (defaults to the clock). */
  now?: number;
  /** Pages that relations point at (title, icon), for display, filters and formulas. */
  pages?: ReadonlyMap<string, RelatedPage>;
}

/** A page a relation links to (a row of the related database). */
export interface RelatedPage {
  id: string;
  title: string;
  icon: string | null;
  databaseId: string;
}

/** Database-wide settings, in the doc's `meta` map. */
export interface DatabaseMeta {
  /** Row pages fold empty properties away under "N more properties". */
  hideEmptyProperties: boolean;
  /** Sub-items: the self-relation pair that links a row to its parent and children. */
  subItems: { parentId: string; childrenId: string } | null;
  /** Dependencies: the self-relation pair "Blocked by" / "Blocking". */
  dependencies: { blockedById: string; blockingId: string } | null;
  /** The template new rows start from (views can choose another). */
  defaultTemplateId: string | null;
  /** Shown under the database title. */
  description: string;
  /** Locked views can't be added, removed or reconfigured; locked properties can't change. */
  lockViews: boolean;
  lockProperties: boolean;
  /** How new views open pages. */
  openPagesIn: OpenPagesIn;
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
  cardPreview: { kind: 'none' },
  fitImage: false,
  cardSize: 'medium',
  colorColumns: true,
  dateProperty: null,
  endDateProperty: null,
  calendarMode: 'month',
  weekStart: 0,
  timelineZoom: 'week',
  timelineTable: true,
  showDependencies: true,
  chart: {
    type: 'bar',
    x: null,
    y: { kind: 'count' },
    series: null,
    stacked: true,
    sort: 'manual',
    legend: true,
    labels: false,
    hideEmpty: false,
  },
  defaultTemplateId: null,
};
