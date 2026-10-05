import { PageField, applyTextDiff, newId, type PageOptions } from '@workspace/core';
import { generateKeyBetween } from 'fractional-indexing';
import * as Y from 'yjs';
import { renameInFormula } from './formula/engine';
import { cellText, propertyKind, optionsOf } from './properties';
import {
  DEFAULT_VIEW_CONFIG,
  META_MAP,
  ROWS_MAP,
  RowField,
  SCHEMA_MAP,
  TITLE_PROPERTY_ID,
  VIEWS_MAP,
  type DatabaseMeta,
  type DatabaseSnapshot,
  type GroupBy,
  type DisplayContext,
  type Property,
  type PropertyConfig,
  type PropertyType,
  type Row,
  type SelectOption,
  type View,
  type ViewConfig,
  type ViewType,
} from './schema';

type YMap = Y.Map<unknown>;

export const schemaMap = (doc: Y.Doc) => doc.getMap<YMap>(SCHEMA_MAP);
export const viewsMap = (doc: Y.Doc) => doc.getMap<YMap>(VIEWS_MAP);
export const rowsMap = (doc: Y.Doc) => doc.getMap<YMap>(ROWS_MAP);
export const metaMap = (doc: Y.Doc) => doc.getMap<unknown>(META_MAP);

export function readMeta(doc: Y.Doc): DatabaseMeta {
  const meta = metaMap(doc);
  return {
    hideEmptyProperties: meta.get('hideEmptyProperties') === true,
    subItems: (meta.get('subItems') as DatabaseMeta['subItems'] | undefined) ?? null,
    dependencies: (meta.get('dependencies') as DatabaseMeta['dependencies'] | undefined) ?? null,
    defaultTemplateId: (meta.get('defaultTemplateId') as string | null | undefined) ?? null,
    description: (meta.get('description') as string | undefined) ?? '',
    lockViews: meta.get('lockViews') === true,
    lockProperties: meta.get('lockProperties') === true,
    openPagesIn: (meta.get('openPagesIn') as DatabaseMeta['openPagesIn'] | undefined) ?? 'sidePeek',
  };
}

export function setMeta(doc: Y.Doc, changes: Partial<DatabaseMeta>): void {
  doc.transact(() => {
    for (const [key, value] of Object.entries(changes)) metaMap(doc).set(key, value);
  });
}

/** True once the doc has been set up as a database. */
export function isDatabaseDoc(doc: Y.Doc): boolean {
  return doc.share.has(SCHEMA_MAP) && schemaMap(doc).size > 0;
}

/** Fractional-index key for a slot between two (possibly equal, after merges) keys. */
function keyBetween(before: string | null, after: string | null): string {
  if (before !== null && after !== null && before >= after) return generateKeyBetween(before, null);
  return generateKeyBetween(before, after);
}

const byKey = <T extends { sortKey: string; id: string }>(a: T, b: T) =>
  a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1;

/** Key that places an item at `index` in a sorted list (clamped). */
function keyAt(sorted: readonly { sortKey: string }[], index: number): string {
  const i = Math.max(0, Math.min(index, sorted.length));
  return keyBetween(sorted[i - 1]?.sortKey ?? null, sorted[i]?.sortKey ?? null);
}

// --- Reading ---------------------------------------------------------------------------

export function readProperty(map: YMap): Property {
  return {
    id: map.get('id') as string,
    name: (map.get('name') as string | undefined) ?? '',
    type: (map.get('type') as PropertyType | undefined) ?? 'text',
    config: (map.get('config') as PropertyConfig | undefined) ?? {},
    sortKey: (map.get('sortKey') as string | undefined) ?? '',
  };
}

export function readView(map: YMap): View {
  const get = <K extends keyof ViewConfig>(key: K): ViewConfig[K] =>
    (map.get(key) as ViewConfig[K] | undefined) ?? DEFAULT_VIEW_CONFIG[key];
  return {
    id: map.get('id') as string,
    viewSet: map.get('viewSet') as string,
    name: (map.get('name') as string | undefined) ?? '',
    type: (map.get('type') as ViewType | undefined) ?? 'table',
    sortKey: (map.get('sortKey') as string | undefined) ?? '',
    properties: get('properties'),
    sorts: get('sorts'),
    filter: get('filter'),
    groupBy: get('groupBy'),
    subGroupBy: get('subGroupBy'),
    calculations: get('calculations'),
    openPagesIn: get('openPagesIn'),
    wrap: get('wrap'),
    cardPreview: get('cardPreview'),
    fitImage: get('fitImage'),
    cardSize: get('cardSize'),
    colorColumns: get('colorColumns'),
    dateProperty: get('dateProperty'),
    endDateProperty: get('endDateProperty'),
    calendarMode: get('calendarMode'),
    weekStart: get('weekStart'),
    timelineZoom: get('timelineZoom'),
    timelineTable: get('timelineTable'),
    showDependencies: get('showDependencies'),
    defaultTemplateId: get('defaultTemplateId'),
    chart: {
      ...DEFAULT_VIEW_CONFIG.chart,
      ...((map.get('chart') as ViewConfig['chart'] | undefined) ?? {}),
    },
  };
}

export function readRow(map: YMap): Row {
  const title = map.get(PageField.title);
  const values = map.get(RowField.values);
  return {
    id: map.get(PageField.id) as string,
    title: title instanceof Y.Text ? title.toString() : '',
    icon: (map.get(PageField.icon) as string | null | undefined) ?? null,
    cover: (map.get(PageField.cover) as Row['cover'] | undefined) ?? null,
    sortKey: (map.get(PageField.sortKey) as string | undefined) ?? '',
    createdAt: (map.get(PageField.createdAt) as number | undefined) ?? 0,
    createdBy: (map.get(RowField.createdBy) as string | null | undefined) ?? null,
    updatedAt: (map.get(PageField.updatedAt) as number | undefined) ?? 0,
    updatedBy: (map.get(RowField.updatedBy) as string | null | undefined) ?? null,
    uid: (map.get(RowField.uid) as number | undefined) ?? 0,
    trashedAt: (map.get(PageField.trashedAt) as number | null | undefined) ?? null,
    fullWidth: map.get(PageField.fullWidth) === true,
    smallText: map.get(PageField.smallText) === true,
    font: (map.get(PageField.font) as Row['font'] | undefined) ?? 'default',
    locked: map.get(PageField.locked) === true,
    isTemplate: map.get(RowField.template) === true,
    values: values instanceof Y.Map ? (values.toJSON() as Record<string, unknown>) : {},
  };
}

export function readProperties(doc: Y.Doc): Property[] {
  return Array.from(schemaMap(doc).values(), readProperty).sort(byKey);
}

export function readViews(doc: Y.Doc): View[] {
  return Array.from(viewsMap(doc).values(), readView).sort(byKey);
}

/** Full snapshot. (The UI uses `DatabaseHandle`, which updates it incrementally.) */
export function readDatabase(doc: Y.Doc): DatabaseSnapshot {
  return {
    properties: readProperties(doc),
    views: readViews(doc),
    rows: Array.from(rowsMap(doc).values(), readRow).sort(byKey),
    meta: readMeta(doc),
  };
}

export function getRowMap(doc: Y.Doc, rowId: string): YMap {
  const row = rowsMap(doc).get(rowId);
  if (!row) throw new Error(`Row not found: ${rowId}`);
  return row;
}

export const hasRow = (doc: Y.Doc, rowId: string) => rowsMap(doc).has(rowId);

function getPropertyMap(doc: Y.Doc, id: string): YMap {
  const map = schemaMap(doc).get(id);
  if (!map) throw new Error(`Property not found: ${id}`);
  return map;
}

function getViewMap(doc: Y.Doc, id: string): YMap {
  const map = viewsMap(doc).get(id);
  if (!map) throw new Error(`View not found: ${id}`);
  return map;
}

// --- Setup -----------------------------------------------------------------------------

export interface InitDatabaseOptions {
  /** View set of the first view: the database page's id. */
  databaseId: string;
  viewName?: string;
}

/** Give an empty doc the starting schema of a new Notion database: Name, Tags, a table. */
export function initDatabase(doc: Y.Doc, options: InitDatabaseOptions): void {
  if (isDatabaseDoc(doc)) return;
  doc.transact(() => {
    setProperty(doc, { id: TITLE_PROPERTY_ID, name: 'Name', type: 'title', config: {} }, 'a0');
    addProperty(doc, { name: 'Tags', type: 'multiSelect' });
    addView(doc, { viewSet: options.databaseId, name: options.viewName ?? 'Table', type: 'table' });
  });
}

function setProperty(doc: Y.Doc, p: Omit<Property, 'sortKey'>, sortKey: string): void {
  const map = new Y.Map<unknown>();
  map.set('id', p.id);
  map.set('name', p.name);
  map.set('type', p.type);
  map.set('config', p.config);
  map.set('sortKey', sortKey);
  schemaMap(doc).set(p.id, map);
}

// --- Properties ------------------------------------------------------------------------

export interface AddPropertyOptions {
  name: string;
  type: PropertyType;
  config?: PropertyConfig;
  /** Place the new column right after this property in every view (default: last). */
  afterId?: string;
}

export function addProperty(doc: Y.Doc, options: AddPropertyOptions): string {
  const id = newId();
  doc.transact(() => {
    const properties = readProperties(doc);
    const after = options.afterId ? properties.findIndex((p) => p.id === options.afterId) : -1;
    const index = after >= 0 ? after + 1 : properties.length;
    const config = options.config ?? propertyKind(options.type).defaultConfig();
    setProperty(
      doc,
      { id, name: options.name, type: options.type, config },
      keyAt(properties, index),
    );
    for (const view of readViews(doc)) {
      const columns = viewColumns(view, properties);
      const at = options.afterId ? columns.findIndex((c) => c.id === options.afterId) + 1 : 0;
      // Cards and lists only show the properties picked for them.
      columns.splice(at > 0 ? at : columns.length, 0, { id, visible: view.type === 'table' });
      getViewMap(doc, view.id).set('properties', columns);
    }
  });
  return id;
}

/** A unique name like "Property 2" for a new property. */
export function newPropertyName(doc: Y.Doc, base = 'Property'): string {
  const names = new Set(readProperties(doc).map((p) => p.name));
  if (!names.has(base)) return base;
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Rename a property; formulas that refer to it are updated to the new name. */
export function renameProperty(doc: Y.Doc, id: string, name: string): void {
  doc.transact(() => {
    const map = getPropertyMap(doc, id);
    const oldName = map.get('name') as string;
    map.set('name', name);
    if (oldName === name) return;
    for (const p of readProperties(doc)) {
      if (p.type !== 'formula' || !p.config.expression?.includes(oldName)) continue;
      const expression = renameInFormula(p.config.expression, oldName, name);
      if (expression !== p.config.expression)
        setPropertyConfig(doc, p.id, { ...p.config, expression });
    }
  });
}

/** Store a property's config (computed fields such as a formula's result type are dropped). */
export function setPropertyConfig(doc: Y.Doc, id: string, config: PropertyConfig): void {
  const { resultType: _type, formulaError: _error, ...stored } = config;
  void _type;
  void _error;
  getPropertyMap(doc, id).set('config', stored);
}

/**
 * Change a property's type. Values convert through their display text (so "Done"
 * becomes the option "Done", "12" becomes 12), like Notion.
 */
export function changePropertyType(
  doc: Y.Doc,
  id: string,
  type: PropertyType,
  ctx: DisplayContext,
  /** The new type's settings (default: the type's defaults). */
  config?: PropertyConfig,
): void {
  if (id === TITLE_PROPERTY_ID) throw new Error('The title property keeps its type');
  const from = readProperty(getPropertyMap(doc, id));
  if (from.type === type) return;
  doc.transact(() => {
    const kind = propertyKind(type);
    // Options carry over between select-like types.
    const keepsOptions = ['select', 'multiSelect', 'status'];
    let to: Property = {
      ...from,
      type,
      config:
        keepsOptions.includes(from.type) && keepsOptions.includes(type)
          ? {
              options: optionsOf(from).map((o) =>
                type === 'status' ? { ...o, group: o.group ?? 'todo' } : o,
              ),
            }
          : (config ?? kind.defaultConfig()),
    };
    const rows = Array.from(rowsMap(doc).values());
    for (const rowMap of rows) {
      const row = readRow(rowMap);
      const text = cellText(row, from, ctx);
      const values = rowValues(rowMap);
      if (kind.computed || !text) {
        values.delete(id);
        continue;
      }
      const parsed = kind.parse(text, to, ctx);
      if (parsed.newOptions) {
        to = { ...to, config: { ...to.config, options: [...optionsOf(to), ...parsed.newOptions] } };
      }
      if (kind.isEmpty(parsed.value) && type !== 'checkbox') values.delete(id);
      else values.set(id, parsed.value);
    }
    const map = getPropertyMap(doc, id);
    map.set('type', type);
    map.set('config', to.config);
  });
}

export function deleteProperty(doc: Y.Doc, id: string): void {
  if (id === TITLE_PROPERTY_ID) throw new Error('The title property cannot be deleted');
  doc.transact(() => {
    schemaMap(doc).delete(id);
    for (const rowMap of rowsMap(doc).values()) {
      const values = rowMap.get(RowField.values);
      if (values instanceof Y.Map && values.has(id)) values.delete(id);
    }
    for (const view of readViews(doc)) {
      const map = getViewMap(doc, view.id);
      if (view.properties.some((c) => c.id === id)) {
        map.set(
          'properties',
          view.properties.filter((c) => c.id !== id),
        );
      }
      if (view.sorts.some((s) => s.propertyId === id)) {
        map.set(
          'sorts',
          view.sorts.filter((s) => s.propertyId !== id),
        );
      }
    }
  });
}

/** Copy a property with its values, right after the original. */
export function duplicateProperty(doc: Y.Doc, id: string): string {
  const from = readProperty(getPropertyMap(doc, id));
  if (from.type === 'title') throw new Error('The title property cannot be duplicated');
  let copy = '';
  doc.transact(() => {
    copy = addProperty(doc, {
      name: newPropertyName(doc, from.name),
      type: from.type,
      // A copied relation is one-way (the other side stays synced with the original).
      config:
        from.type === 'relation'
          ? { ...structuredClone(from.config), syncedPropertyId: null }
          : structuredClone(from.config),
      afterId: id,
    });
    for (const rowMap of rowsMap(doc).values()) {
      const values = rowMap.get(RowField.values);
      if (values instanceof Y.Map && values.has(id)) {
        const value = values.get(id);
        values.set(copy, value instanceof Y.AbstractType ? value.toJSON() : structuredClone(value));
      }
    }
  });
  return copy;
}

// --- Options ---------------------------------------------------------------------------

export function addOption(doc: Y.Doc, propertyId: string, option: SelectOption): void {
  const property = readProperty(getPropertyMap(doc, propertyId));
  setPropertyConfig(doc, propertyId, {
    ...property.config,
    options: [...optionsOf(property), option],
  });
}

export function updateOption(
  doc: Y.Doc,
  propertyId: string,
  optionId: string,
  changes: Partial<Omit<SelectOption, 'id'>>,
): void {
  const property = readProperty(getPropertyMap(doc, propertyId));
  setPropertyConfig(doc, propertyId, {
    ...property.config,
    options: optionsOf(property).map((o) => (o.id === optionId ? { ...o, ...changes } : o)),
  });
}

/** Remove an option and clear it from every row. */
export function deleteOption(doc: Y.Doc, propertyId: string, optionId: string): void {
  doc.transact(() => {
    const property = readProperty(getPropertyMap(doc, propertyId));
    setPropertyConfig(doc, propertyId, {
      ...property.config,
      options: optionsOf(property).filter((o) => o.id !== optionId),
    });
    for (const rowMap of rowsMap(doc).values()) {
      const values = rowMap.get(RowField.values);
      if (!(values instanceof Y.Map)) continue;
      const value = values.get(propertyId);
      if (value === optionId) values.delete(propertyId);
      else if (Array.isArray(value) && value.includes(optionId)) {
        const rest = value.filter((v) => v !== optionId);
        if (rest.length) values.set(propertyId, rest);
        else values.delete(propertyId);
      }
    }
  });
}

// --- Rows ------------------------------------------------------------------------------

function rowValues(rowMap: YMap): Y.Map<unknown> {
  let values = rowMap.get(RowField.values);
  if (!(values instanceof Y.Map)) {
    values = new Y.Map<unknown>();
    rowMap.set(RowField.values, values);
  }
  return values as Y.Map<unknown>;
}

function liveRowsByKey(doc: Y.Doc): Row[] {
  return Array.from(rowsMap(doc).values(), readRow).sort(byKey);
}

export interface AddRowOptions {
  /** Who is adding it (for created by / last edited by). */
  actor: string | null;
  id?: string;
  title?: string;
  values?: Record<string, unknown>;
  /** Insert right after / before this row in the manual order (default: last). */
  afterId?: string;
  beforeId?: string;
  now?: number;
}

export function addRow(doc: Y.Doc, options: AddRowOptions): string {
  const id = options.id ?? newId();
  const now = options.now ?? Date.now();
  doc.transact(() => {
    const rows = liveRowsByKey(doc);
    const ref = options.afterId ?? options.beforeId;
    const at = ref ? rows.findIndex((r) => r.id === ref) : -1;
    const index = at < 0 ? rows.length : options.afterId ? at + 1 : at;
    const map = new Y.Map<unknown>();
    const title = new Y.Text();
    if (options.title) title.insert(0, options.title);
    const values = new Y.Map<unknown>();
    for (const [key, value] of Object.entries(options.values ?? {})) {
      if (value !== null && value !== undefined) values.set(key, value);
    }
    map.set(PageField.id, id);
    map.set(PageField.title, title);
    map.set(PageField.icon, null);
    map.set(PageField.sortKey, keyAt(rows, index));
    map.set(PageField.createdAt, now);
    map.set(PageField.updatedAt, now);
    map.set(PageField.trashedAt, null);
    map.set(RowField.createdBy, options.actor);
    map.set(RowField.updatedBy, options.actor);
    // Concurrent offline adds can pick the same number; acceptable until sync (Phase 4).
    map.set(RowField.uid, rows.reduce((max, r) => Math.max(max, r.uid), 0) + 1);
    map.set(RowField.values, values);
    rowsMap(doc).set(id, map);
  });
  return id;
}

/** Stamp an edit; `actor` undefined keeps the last editor. */
function touch(rowMap: YMap, actor: string | null | undefined, now: number): void {
  rowMap.set(PageField.updatedAt, now);
  if (actor !== undefined && rowMap.get(RowField.updatedBy) !== actor) {
    rowMap.set(RowField.updatedBy, actor);
  }
}

/** Set (or clear, with null/undefined) a stored property value. */
export function setCell(
  doc: Y.Doc,
  rowId: string,
  propertyId: string,
  value: unknown,
  actor: string | null,
  now = Date.now(),
): void {
  if (propertyId === TITLE_PROPERTY_ID) {
    setRowTitle(doc, rowId, typeof value === 'string' ? value : '', actor, now);
    return;
  }
  doc.transact(() => {
    const rowMap = getRowMap(doc, rowId);
    const values = rowValues(rowMap);
    if (value === null || value === undefined || value === '') values.delete(propertyId);
    else values.set(propertyId, value);
    touch(rowMap, actor, now);
  });
}

export function setRowTitle(
  doc: Y.Doc,
  rowId: string,
  title: string,
  actor: string | null,
  now = Date.now(),
): void {
  doc.transact(() => {
    const rowMap = getRowMap(doc, rowId);
    applyTextDiff(rowMap.get(PageField.title) as Y.Text, title);
    touch(rowMap, actor, now);
  });
}

/** Icon, cover and page options of a row's page. */
export function setRowPageFields(
  doc: Y.Doc,
  rowId: string,
  fields: Partial<PageOptions & { icon: string | null }>,
  actor: string | null,
  now = Date.now(),
): void {
  doc.transact(() => {
    const rowMap = getRowMap(doc, rowId);
    for (const [key, value] of Object.entries(fields)) rowMap.set(key, value);
    touch(rowMap, actor, now);
  });
}

/** Mark that a row's page content changed (`actor` undefined keeps the last editor). */
export function touchRow(
  doc: Y.Doc,
  rowId: string,
  actor: string | null | undefined,
  now = Date.now(),
) {
  touch(getRowMap(doc, rowId), actor, now);
}

export function trashRow(doc: Y.Doc, rowId: string, now = Date.now()): void {
  getRowMap(doc, rowId).set(PageField.trashedAt, now);
}

export function restoreRow(doc: Y.Doc, rowId: string): void {
  getRowMap(doc, rowId).set(PageField.trashedAt, null);
}

export function deleteRow(doc: Y.Doc, rowId: string): void {
  rowsMap(doc).delete(rowId);
}

/** Permanently delete rows trashed before `cutoff`; returns their ids. */
export function emptyRowTrashBefore(doc: Y.Doc, cutoff: number): string[] {
  const ids = Array.from(rowsMap(doc).values(), readRow)
    .filter((r) => r.trashedAt !== null && r.trashedAt < cutoff)
    .map((r) => r.id);
  if (ids.length) doc.transact(() => ids.forEach((id) => rowsMap(doc).delete(id)));
  return ids;
}

/** Move a row in the manual order: just before `beforeId`, or last when `null`. */
export function moveRow(doc: Y.Doc, rowId: string, beforeId: string | null): void {
  if (rowId === beforeId) return;
  const rows = liveRowsByKey(doc).filter((r) => r.id !== rowId);
  const at = beforeId ? rows.findIndex((r) => r.id === beforeId) : -1;
  getRowMap(doc, rowId).set(PageField.sortKey, keyAt(rows, at < 0 ? rows.length : at));
}

/** Move a row in the manual order to just after `afterId` (first when `null`). */
export function moveRowAfter(doc: Y.Doc, rowId: string, afterId: string | null): void {
  if (rowId === afterId) return;
  const rows = liveRowsByKey(doc).filter((r) => r.id !== rowId);
  const at = afterId ? rows.findIndex((r) => r.id === afterId) + 1 : 0;
  getRowMap(doc, rowId).set(PageField.sortKey, keyAt(rows, at));
}

/** Copy a row's properties (not its content; see `copyPageContent`), right after it. */
export function duplicateRow(doc: Y.Doc, rowId: string, actor: string | null): string {
  const row = readRow(getRowMap(doc, rowId));
  let id = '';
  doc.transact(() => {
    id = addRow(doc, {
      actor,
      title: row.title,
      values: structuredClone(row.values) as Record<string, unknown>,
      afterId: rowId,
    });
    const { icon, cover, fullWidth, smallText, font, locked } = row;
    setRowPageFields(doc, id, { icon, cover, fullWidth, smallText, font, locked }, actor);
    // A copy of a template is a template.
    if (row.isTemplate) getRowMap(doc, id).set(RowField.template, true);
  });
  return id;
}

// --- Views -----------------------------------------------------------------------------

export interface AddViewOptions {
  viewSet: string;
  name: string;
  type: ViewType;
  config?: Partial<ViewConfig>;
}

export function addView(doc: Y.Doc, options: AddViewOptions): string {
  const id = newId();
  doc.transact(() => {
    const views = readViews(doc).filter((v) => v.viewSet === options.viewSet);
    const map = new Y.Map<unknown>();
    map.set('id', id);
    map.set('viewSet', options.viewSet);
    map.set('name', options.name);
    map.set('type', options.type);
    map.set('sortKey', keyAt(views, views.length));
    const config = {
      ...DEFAULT_VIEW_CONFIG,
      openPagesIn: readMeta(doc).openPagesIn,
      ...viewTypeDefaults(doc, options.type),
      ...options.config,
    };
    if (config.properties.length === 0) {
      // Boards, lists and galleries start with just the title, like Notion.
      config.properties = readProperties(doc).map((p) => ({
        id: p.id,
        visible: options.type === 'table' || p.id === TITLE_PROPERTY_ID,
      }));
    }
    for (const [key, value] of Object.entries(config)) map.set(key, value);
    viewsMap(doc).set(id, map);
  });
  return id;
}

/** Settings a new view of this type starts with. */
function viewTypeDefaults(doc: Y.Doc, type: ViewType): Partial<ViewConfig> {
  if (type === 'gallery') return { cardPreview: { kind: 'content' } };
  if (type === 'board') return { groupBy: defaultBoardGroupBy(doc) };
  if (type === 'calendar' || type === 'timeline') return { dateProperty: defaultDateProperty(doc) };
  if (type === 'chart') return { chart: { ...DEFAULT_VIEW_CONFIG.chart, x: defaultChartX(doc) } };
  return {};
}

/** What a new chart's X axis groups by: a select-like property, a date by month, or the title. */
function defaultChartX(doc: Y.Doc): GroupBy {
  const properties = readProperties(doc);
  for (const type of BOARD_TYPES) {
    const property = properties.find((p) => p.type === type);
    if (property) return { propertyId: property.id };
  }
  const date = properties.find((p) => p.type === 'date' || p.type === 'createdTime');
  if (date) return { propertyId: date.id, dateBucket: 'month' };
  return { propertyId: TITLE_PROPERTY_ID };
}

/** The date property a calendar or timeline uses: the first one, or a new "Date". */
export function defaultDateProperty(doc: Y.Doc): string {
  const date = readProperties(doc).find((p) => p.type === 'date');
  return date ? date.id : addProperty(doc, { name: newPropertyName(doc, 'Date'), type: 'date' });
}

const BOARD_TYPES: readonly PropertyType[] = [
  'status',
  'select',
  'multiSelect',
  'person',
  'checkbox',
];

/**
 * What a new board groups by: the first status, select, multi-select, person or
 * checkbox property; a new Status property when there is none.
 */
export function defaultBoardGroupBy(doc: Y.Doc): GroupBy {
  const properties = readProperties(doc);
  for (const type of BOARD_TYPES) {
    const property = properties.find((p) => p.type === type);
    if (property) return { propertyId: property.id };
  }
  const id = addProperty(doc, {
    name: newPropertyName(doc, 'Status'),
    type: 'status',
  });
  return { propertyId: id };
}

/** Change a view's layout; a board needs something to group by. */
export function setViewType(doc: Y.Doc, id: string, type: ViewType): void {
  doc.transact(() => {
    const map = getViewMap(doc, id);
    const view = readView(map);
    map.set('type', type);
    if (type === 'board' && !view.groupBy) map.set('groupBy', defaultBoardGroupBy(doc));
    if ((type === 'calendar' || type === 'timeline') && !view.dateProperty) {
      map.set('dateProperty', defaultDateProperty(doc));
    }
    if (type === 'chart' && !view.chart.x) {
      map.set('chart', { ...view.chart, x: defaultChartX(doc) });
    }
    if (type === 'gallery' && view.cardPreview.kind === 'none') {
      map.set('cardPreview', { kind: 'content' });
    }
  });
}

export function updateView(
  doc: Y.Doc,
  id: string,
  changes: Partial<ViewConfig & { name: string }>,
): void {
  doc.transact(() => {
    const map = getViewMap(doc, id);
    for (const [key, value] of Object.entries(changes)) map.set(key, value);
  });
}

export function deleteView(doc: Y.Doc, id: string): void {
  viewsMap(doc).delete(id);
}

/** Copy a view (filters, sorts, groups, columns) right after it. Returns the copy's id. */
export function duplicateView(doc: Y.Doc, id: string): string {
  const view = readView(getViewMap(doc, id));
  const copyId = newId();
  doc.transact(() => {
    const siblings = readViews(doc).filter((v) => v.viewSet === view.viewSet);
    const at = siblings.findIndex((v) => v.id === id) + 1;
    const map = new Y.Map<unknown>();
    const { id: _id, sortKey: _key, ...rest } = view;
    void _id;
    void _key;
    for (const [key, value] of Object.entries(structuredClone(rest))) map.set(key, value);
    map.set('id', copyId);
    map.set('name', `${view.name} (1)`);
    map.set('sortKey', keyAt(siblings, at));
    viewsMap(doc).set(copyId, map);
  });
  return copyId;
}

/** Move a view tab before another (or last with `null`). */
export function moveView(doc: Y.Doc, id: string, beforeId: string | null): void {
  if (id === beforeId) return;
  const view = readView(getViewMap(doc, id));
  const siblings = readViews(doc).filter((v) => v.viewSet === view.viewSet && v.id !== id);
  const at = beforeId ? siblings.findIndex((v) => v.id === beforeId) : -1;
  getViewMap(doc, id).set('sortKey', keyAt(siblings, at < 0 ? siblings.length : at));
}

/** Views of one view set, in tab order. */
export function viewsOf(snapshot: DatabaseSnapshot, viewSet: string): View[] {
  return snapshot.views.filter((v) => v.viewSet === viewSet);
}

/**
 * Columns of a view: its saved order, then properties it doesn't know yet (added by
 * another device), with deleted properties dropped. The title always comes first.
 */
export function viewColumns(
  view: Pick<View, 'properties'>,
  properties: readonly Property[],
): { id: string; visible: boolean; width?: number }[] {
  const known = new Set(properties.map((p) => p.id));
  const seen = new Set<string>();
  const columns = view.properties.filter((c) => {
    if (!known.has(c.id) || seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  for (const p of properties) if (!seen.has(p.id)) columns.push({ id: p.id, visible: true });
  const title = columns.findIndex((c) => c.id === TITLE_PROPERTY_ID);
  if (title > 0) columns.unshift({ ...columns.splice(title, 1)[0]!, visible: true });
  return columns.map((c) => ({ ...c }));
}

/** Change one column of a view (width, visibility). */
export function updateViewColumn(
  doc: Y.Doc,
  viewId: string,
  propertyId: string,
  changes: { visible?: boolean; width?: number },
): void {
  const view = readView(getViewMap(doc, viewId));
  const columns = viewColumns(view, readProperties(doc)).map((c) =>
    c.id === propertyId ? { ...c, ...changes } : c,
  );
  updateView(doc, viewId, { properties: columns });
}

/** Move a column before another (or to the end with `null`). The title stays first. */
export function moveViewColumn(
  doc: Y.Doc,
  viewId: string,
  propertyId: string,
  beforeId: string | null,
): void {
  if (propertyId === TITLE_PROPERTY_ID || propertyId === beforeId) return;
  const view = readView(getViewMap(doc, viewId));
  const columns = viewColumns(view, readProperties(doc));
  const from = columns.findIndex((c) => c.id === propertyId);
  if (from < 0) return;
  const [moved] = columns.splice(from, 1);
  let to = beforeId ? columns.findIndex((c) => c.id === beforeId) : columns.length;
  if (to < 0) to = columns.length;
  columns.splice(Math.max(1, to), 0, moved!);
  updateView(doc, viewId, { properties: columns });
}
