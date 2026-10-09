/**
 * Database properties in Notion's JSON, both ways: a database's schema (what each
 * property is), and a page's values. Computed values (formulas, rollups, created and
 * edited times and people, unique IDs) come out in Notion's shapes and are refused on
 * write, as Notion does.
 */
import { newId } from '@workspace/core';
import {
  OPTION_COLORS,
  STATUS_GROUPS,
  TITLE_PROPERTY_ID,
  cellValue,
  defaultStatusOptions,
  effectiveType,
  isDateValue,
  optionsOf,
  relationIds,
  type DateValue,
  type FileValue,
  type NumberFormat,
  type OptionColor,
  type Property,
  type PropertyConfig,
  type PropertyType,
  type RollupCalculation,
  type Row,
  type SelectOption,
} from '@workspace/database';
import { invalid } from './errors';
import { parseId } from './ids';
import { readRichText, richText } from './rich-text';

// --- Names ---------------------------------------------------------------------------

const API_TYPES: Record<PropertyType, string> = {
  title: 'title',
  text: 'rich_text',
  number: 'number',
  select: 'select',
  multiSelect: 'multi_select',
  status: 'status',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
  email: 'email',
  phone: 'phone_number',
  files: 'files',
  person: 'people',
  createdTime: 'created_time',
  createdBy: 'created_by',
  lastEditedTime: 'last_edited_time',
  lastEditedBy: 'last_edited_by',
  uniqueId: 'unique_id',
  formula: 'formula',
  relation: 'relation',
  rollup: 'rollup',
  button: 'button',
};

const OUR_TYPES = new Map(Object.entries(API_TYPES).map(([ours, api]) => [api, ours]));

/** A property type's name in the API. */
export const apiType = (type: PropertyType) => API_TYPES[type];

/** The property type for an API name, or null if there isn't one. */
export const ourType = (api: string) => (OUR_TYPES.get(api) as PropertyType | undefined) ?? null;

/** Types whose values are computed (refused on write). */
export const COMPUTED = new Set<PropertyType>([
  'formula',
  'rollup',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
  'uniqueId',
  'button',
]);

const NUMBER_FORMATS: Record<NumberFormat, string> = {
  number: 'number',
  commas: 'number_with_commas',
  percent: 'percent',
  dollar: 'dollar',
  euro: 'euro',
  pound: 'pound',
  yen: 'yen',
  rupee: 'rupee',
  yuan: 'yuan',
  won: 'won',
  real: 'real',
  franc: 'franc',
};

const ROLLUP_FUNCTIONS: Record<RollupCalculation, string> = {
  showOriginal: 'show_original',
  showUnique: 'show_unique',
  countAll: 'count',
  countValues: 'count_values',
  countUnique: 'unique',
  countEmpty: 'empty',
  countNotEmpty: 'not_empty',
  percentEmpty: 'percent_empty',
  percentNotEmpty: 'percent_not_empty',
  sum: 'sum',
  average: 'average',
  median: 'median',
  min: 'min',
  max: 'max',
  range: 'range',
  earliest: 'earliest_date',
  latest: 'latest_date',
  dateRange: 'date_range',
  checked: 'checked',
  unchecked: 'unchecked',
  percentChecked: 'percent_checked',
  percentUnchecked: 'percent_unchecked',
};

const reverse = <K extends string>(map: Record<K, string>) =>
  new Map(Object.entries(map).map(([k, v]) => [v as string, k as K]));
const OUR_NUMBER_FORMATS = reverse(NUMBER_FORMATS);
const OUR_ROLLUP_FUNCTIONS = reverse(ROLLUP_FUNCTIONS);

// --- Dates ---------------------------------------------------------------------------

/**
 * A stored date as Notion writes one. Times are stored as wall-clock times without a
 * zone; the API reads and writes them as UTC.
 */
export const apiDateString = (s: string) => (s.length > 10 ? `${s}:00.000+00:00` : s);

export function apiDate(v: DateValue) {
  return {
    start: apiDateString(v.start),
    end: v.end ? apiDateString(v.end) : null,
    time_zone: null,
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** An ISO date or date-time sent in, as stored (`YYYY-MM-DD` or a UTC `YYYY-MM-DDTHH:mm`). */
export function parseDateString(input: unknown, where: string): string {
  if (typeof input !== 'string') throw invalid(`${where} should be an ISO 8601 date.`);
  if (DAY.test(input)) return input;
  if (!DATE_TIME.test(input)) throw invalid(`${where} should be an ISO 8601 date.`);
  // Without a zone it's taken as written (UTC).
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(input)) return input.slice(0, 16);
  const t = new Date(input);
  if (Number.isNaN(t.getTime())) throw invalid(`${where} should be an ISO 8601 date.`);
  return t.toISOString().slice(0, 16);
}

const isoTime = (ms: number) => new Date(ms).toISOString();

// --- Schemas (a database's properties) -----------------------------------------------

const option = (o: SelectOption) => ({ id: o.id, name: o.name, color: o.color, description: null });

export interface SchemaContext {
  /** Properties of other databases (relations and rollups name them). */
  propertiesOf?: (databaseId: string) => readonly Property[] | undefined;
}

/** A database property, as Notion describes it. */
export function propertySchema(
  p: Property,
  properties: readonly Property[],
  ctx: SchemaContext = {},
): Record<string, unknown> {
  const type = apiType(p.type);
  let config: Record<string, unknown> = {};
  switch (p.type) {
    case 'number':
      config = { format: NUMBER_FORMATS[p.config.numberFormat ?? 'number'] };
      break;
    case 'select':
    case 'multiSelect':
      config = { options: optionsOf(p).map(option) };
      break;
    case 'status': {
      const options = optionsOf(p);
      config = {
        options: options.map(option),
        groups: STATUS_GROUPS.map((g) => ({
          id: g.id,
          name: g.label,
          color: g.id === 'todo' ? 'gray' : g.id === 'inProgress' ? 'blue' : 'green',
          option_ids: options.filter((o) => (o.group ?? 'todo') === g.id).map((o) => o.id),
        })),
      };
      break;
    }
    case 'formula':
      config = { expression: p.config.expression ?? '' };
      break;
    case 'uniqueId':
      config = { prefix: p.config.prefix || null };
      break;
    case 'relation': {
      const databaseId = p.config.databaseId ?? '';
      const synced = p.config.syncedPropertyId;
      const other = synced ? ctx.propertiesOf?.(databaseId)?.find((x) => x.id === synced) : null;
      config = {
        database_id: databaseId,
        data_source_id: databaseId,
        ...(synced
          ? {
              type: 'dual_property',
              dual_property: {
                synced_property_id: synced,
                synced_property_name: other?.name ?? '',
              },
            }
          : { type: 'single_property', single_property: {} }),
      };
      break;
    }
    case 'rollup': {
      const via = properties.find((x) => x.id === p.config.relationId);
      const target = via
        ? ctx
            .propertiesOf?.(via.config.databaseId ?? '')
            ?.find((x) => x.id === p.config.targetPropertyId)
        : undefined;
      config = {
        relation_property_id: p.config.relationId ?? '',
        relation_property_name: via?.name ?? '',
        rollup_property_id: p.config.targetPropertyId ?? '',
        rollup_property_name: target?.name ?? '',
        function: ROLLUP_FUNCTIONS[p.config.calculation ?? 'showOriginal'],
      };
      break;
    }
  }
  return { id: p.id, name: p.name, description: '', type, [type]: config };
}

/**
 * Each property's key in the API: its name, made unique (two properties may share a
 * name here, which Notion doesn't allow).
 */
export function propertyKeys(properties: readonly Property[]): Map<string, string> {
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const p of properties) {
    let key = p.name;
    for (let n = 2; used.has(key); n++) key = `${p.name} (${n})`;
    used.add(key);
    keys.set(p.id, key);
  }
  return keys;
}

/** The schema of a database: its properties by name. */
export function schemaObject(properties: readonly Property[], ctx: SchemaContext = {}) {
  const out: Record<string, unknown> = {};
  const keys = propertyKeys(properties);
  for (const p of properties) {
    out[keys.get(p.id)!] = { ...propertySchema(p, properties, ctx), name: keys.get(p.id) };
  }
  return out;
}

/** A property sent in to create (a database's new property, or a changed type). */
export interface SchemaInput {
  type: PropertyType;
  config: PropertyConfig;
}

const asObject = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw invalid(`${where} should be an object.`);
  return v as Record<string, unknown>;
};

function readOptions(
  input: unknown,
  where: string,
  existing: readonly SelectOption[] = [],
): SelectOption[] {
  if (input === undefined) return [...existing];
  if (!Array.isArray(input)) throw invalid(`${where}.options should be an array.`);
  if (input.length > 100) throw invalid(`${where}.options should have at most 100 items.`);
  return input.map((raw, i) => {
    const o = asObject(raw, `${where}.options[${i}]`);
    const name = typeof o.name === 'string' ? o.name.trim() : '';
    const byId = typeof o.id === 'string' ? existing.find((x) => x.id === o.id) : undefined;
    const byName = existing.find((x) => x.name === name);
    const known = byId ?? byName;
    if (!name && !known) throw invalid(`${where}.options[${i}].name should be a string.`);
    if (name.includes(',')) throw invalid(`${where}.options[${i}].name should not contain commas.`);
    const color =
      typeof o.color === 'string' && (OPTION_COLORS as readonly string[]).includes(o.color)
        ? (o.color as OptionColor)
        : (known?.color ?? 'default');
    return { ...known, id: known?.id ?? newId(), name: name || known!.name, color };
  });
}

/**
 * A property's schema sent in (`{type?, <type>: config}`), checked; `current` is the
 * property it changes, if any (its options and settings carry over).
 */
export function parseSchema(
  input: unknown,
  where: string,
  current?: Property,
  ctx: SchemaContext & { properties?: readonly Property[] } = {},
): SchemaInput {
  const o = asObject(input, where);
  let typeName = typeof o.type === 'string' ? o.type : undefined;
  if (!typeName) {
    typeName = Object.keys(o).find((k) => ourType(k) !== null);
    if (!typeName && current) return { type: current.type, config: current.config };
  }
  const type = typeName ? ourType(typeName) : null;
  if (!type || !typeName) throw invalid(`${where} should have a property type.`);
  if (type === 'button')
    throw invalid(`${where}: button properties can't be made through the API.`);
  const raw = o[typeName] === undefined ? {} : asObject(o[typeName], `${where}.${typeName}`);
  const same = current?.type === type ? current.config : {};
  switch (type) {
    case 'number': {
      const format =
        raw.format === undefined ? undefined : OUR_NUMBER_FORMATS.get(String(raw.format));
      if (raw.format !== undefined && !format) {
        throw invalid(`${where}.number.format "${String(raw.format)}" isn't supported.`);
      }
      return { type, config: { ...same, ...(format && { numberFormat: format }) } };
    }
    case 'select':
    case 'multiSelect':
      return {
        type,
        config: {
          ...same,
          options: readOptions(raw.options, `${where}.${typeName}`, same.options),
        },
      };
    case 'status': {
      if (raw.options !== undefined && current?.type === 'status') {
        throw invalid(`${where}: status options can't be changed through the API.`);
      }
      const options =
        raw.options === undefined
          ? (same.options ?? defaultStatusOptions())
          : readOptions(raw.options, `${where}.status`).map((x, i) => ({
              ...x,
              group: i === 0 ? ('todo' as const) : ('complete' as const),
            }));
      return { type, config: { options } };
    }
    case 'formula': {
      if (typeof raw.expression !== 'string') {
        throw invalid(`${where}.formula.expression should be a string.`);
      }
      return { type, config: { expression: raw.expression } };
    }
    case 'uniqueId': {
      if (raw.prefix !== undefined && raw.prefix !== null && typeof raw.prefix !== 'string') {
        throw invalid(`${where}.unique_id.prefix should be a string.`);
      }
      return { type, config: { prefix: (raw.prefix as string | null) ?? '' } };
    }
    case 'relation': {
      const databaseId = parseId(raw.database_id ?? raw.data_source_id);
      if (!databaseId) throw invalid(`${where}.relation.database_id should be a valid uuid.`);
      return {
        type,
        config: {
          databaseId,
          syncedPropertyId: null,
          ...(raw.type === 'dual_property' || raw.dual_property ? { twoWay: true } : {}),
        } as PropertyConfig,
      };
    }
    case 'rollup': {
      const properties = ctx.properties ?? [];
      const relation = properties.find(
        (p) =>
          p.type === 'relation' &&
          (p.id === raw.relation_property_id || p.name === raw.relation_property_name),
      );
      if (!relation)
        throw invalid(`${where}.rollup should name a relation property of this database.`);
      const targets = ctx.propertiesOf?.(relation.config.databaseId ?? '') ?? [];
      const target = targets.find(
        (p) => p.id === raw.rollup_property_id || p.name === raw.rollup_property_name,
      );
      if (!target) throw invalid(`${where}.rollup should name a property of the related database.`);
      const calculation = OUR_ROLLUP_FUNCTIONS.get(String(raw.function ?? 'show_original'));
      if (!calculation)
        throw invalid(`${where}.rollup.function "${String(raw.function)}" isn't supported.`);
      return {
        type,
        config: { relationId: relation.id, targetPropertyId: target.id, calculation },
      };
    }
    default:
      return { type, config: {} };
  }
}

// --- Values (a page's properties) ----------------------------------------------------

export interface ValueContext {
  /** A stored file's URL, and when it stops working. */
  fileUrl(id: string, name: string): { url: string; expiry_time: string };
}

const user = (id: string | null) => (id ? { object: 'user', id } : null);

function selectValue(p: Property, id: unknown) {
  const o = optionsOf(p).find((x) => x.id === id);
  return o ? { id: o.id, name: o.name, color: o.color } : null;
}

function filesValue(value: unknown, ctx: ValueContext) {
  if (!Array.isArray(value)) return [];
  return (value as FileValue[]).map((f) =>
    f.id
      ? { name: f.name, type: 'file', file: ctx.fileUrl(f.id, f.name) }
      : { name: f.name, type: 'external', external: { url: f.url ?? '' } },
  );
}

/** A computed formula's value, as `{type, <type>: value}`. */
function formulaValue(p: Property, v: unknown) {
  switch (effectiveType(p)) {
    case 'number':
      return { type: 'number', number: typeof v === 'number' ? v : null };
    case 'checkbox':
      return { type: 'boolean', boolean: v === true };
    case 'date':
      return { type: 'date', date: isDateValue(v) ? apiDate(v) : null };
    default:
      return { type: 'string', string: v === null || v === undefined ? null : String(v) };
  }
}

function rollupValue(p: Property, v: unknown) {
  const fn = ROLLUP_FUNCTIONS[p.config.calculation ?? 'showOriginal'];
  if (typeof v === 'number') return { type: 'number', number: v, function: fn };
  if (isDateValue(v)) return { type: 'date', date: apiDate(v), function: fn };
  const text = v === null || v === undefined ? '' : String(v);
  return {
    type: 'array',
    array: text ? [{ type: 'rich_text', rich_text: richText(text) }] : [],
    function: fn,
  };
}

/** A page's value of a property (`row` computed: formulas, rollups and relations filled). */
export function propertyValue(row: Row, p: Property, ctx: ValueContext): Record<string, unknown> {
  const type = apiType(p.type);
  const v = cellValue(row, p);
  let value: unknown;
  switch (p.type) {
    case 'title':
    case 'text':
      value = richText(typeof v === 'string' ? v : '');
      break;
    case 'number':
      value = typeof v === 'number' ? v : null;
      break;
    case 'select':
    case 'status':
      value = selectValue(p, v);
      break;
    case 'multiSelect':
      value = (Array.isArray(v) ? v : []).map((id) => selectValue(p, id)).filter(Boolean);
      break;
    case 'date':
      value = isDateValue(v) ? apiDate(v) : null;
      break;
    case 'checkbox':
      value = v === true;
      break;
    case 'url':
    case 'email':
    case 'phone':
      value = typeof v === 'string' && v ? v : null;
      break;
    case 'files':
      value = filesValue(v, ctx);
      break;
    case 'person':
      value = (Array.isArray(v) ? v : []).map((id) => user(String(id)));
      break;
    case 'createdTime':
    case 'lastEditedTime':
      value = isoTime(v as number);
      break;
    case 'createdBy':
    case 'lastEditedBy':
      value = user(v as string | null) ?? { object: 'user', id: null };
      break;
    case 'uniqueId':
      value = { prefix: p.config.prefix || null, number: v as number };
      break;
    case 'formula':
      value = formulaValue(p, v);
      break;
    case 'relation':
      return { id: p.id, type, relation: relationIds(v).map((id) => ({ id })), has_more: false };
    case 'rollup':
      value = rollupValue(p, v);
      break;
    case 'button':
      value = {};
      break;
  }
  return { id: p.id === TITLE_PROPERTY_ID ? 'title' : p.id, type, [type]: value };
}

/** A page's properties by name. */
export function propertiesObject(row: Row, properties: readonly Property[], ctx: ValueContext) {
  const out: Record<string, unknown> = {};
  const keys = propertyKeys(properties);
  for (const p of properties) out[keys.get(p.id)!] = propertyValue(row, p, ctx);
  return out;
}

/** What a value sent in stores, and the options it makes (a select by a new name). */
export interface ParsedValue {
  value: unknown;
  newOptions?: SelectOption[];
}

export interface ParseContext {
  /** Is this someone (a person property's values)? */
  isUser(id: string): boolean;
}

function readOption(
  p: Property,
  raw: unknown,
  where: string,
  created: SelectOption[],
  mayCreate: boolean,
): string {
  const o = asObject(raw, where);
  const options = [...optionsOf(p), ...created];
  if (typeof o.id === 'string') {
    const found = options.find((x) => x.id === o.id);
    if (!found) throw invalid(`${where}.id doesn't match an option of ${p.name}.`);
    return found.id;
  }
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) throw invalid(`${where} should have a name or an id.`);
  const found = options.find((x) => x.name === name);
  if (found) return found.id;
  if (!mayCreate) throw invalid(`${where}.name "${name}" isn't an option of ${p.name}.`);
  if (name.includes(',')) throw invalid(`${where}.name should not contain commas.`);
  const color =
    typeof o.color === 'string' && (OPTION_COLORS as readonly string[]).includes(o.color)
      ? (o.color as OptionColor)
      : 'default';
  const made: SelectOption = { id: newId(), name, color };
  created.push(made);
  return made.id;
}

const MAX_STRING = 2000;

function readString(raw: unknown, where: string, check?: (s: string) => boolean): string | null {
  if (raw === null) return null;
  if (typeof raw !== 'string') throw invalid(`${where} should be a string or null.`);
  if (raw.length > MAX_STRING) throw invalid(`${where}.length should be ≤ ${MAX_STRING}.`);
  if (raw && check && !check(raw)) throw invalid(`${where} isn't valid.`);
  return raw || null;
}

/** A value sent for a property (`{<type>: value}`), checked, as it's stored. */
export function parseValue(p: Property, input: unknown, ctx: ParseContext): ParsedValue {
  const where = `body.properties.${p.name}`;
  const type = apiType(p.type);
  if (COMPUTED.has(p.type)) {
    throw invalid(`${where}: ${type} properties can't be set; they're computed.`);
  }
  const o = asObject(input, where);
  if (typeof o.type === 'string' && o.type !== type) {
    throw invalid(`${where}.type should be "${type}", not "${o.type}".`);
  }
  if (!(type in o)) throw invalid(`${where}.${type} should be defined.`);
  const raw = o[type];
  const at = `${where}.${type}`;
  switch (p.type) {
    case 'title':
    case 'text':
      return { value: readRichText(raw, at) };
    case 'number':
      if (raw !== null && (typeof raw !== 'number' || !Number.isFinite(raw))) {
        throw invalid(`${at} should be a number or null.`);
      }
      return { value: raw };
    case 'select':
    case 'status': {
      if (raw === null) return { value: null };
      const created: SelectOption[] = [];
      const id = readOption(p, raw, at, created, p.type === 'select');
      return { value: id, ...(created.length && { newOptions: created }) };
    }
    case 'multiSelect': {
      if (!Array.isArray(raw)) throw invalid(`${at} should be an array.`);
      if (raw.length > 100) throw invalid(`${at} should have at most 100 items.`);
      const created: SelectOption[] = [];
      const ids = [...new Set(raw.map((x, i) => readOption(p, x, `${at}[${i}]`, created, true)))];
      return { value: ids.length ? ids : null, ...(created.length && { newOptions: created }) };
    }
    case 'date': {
      if (raw === null) return { value: null };
      const d = asObject(raw, at);
      const start = parseDateString(d.start, `${at}.start`);
      const end =
        d.end === undefined || d.end === null ? null : parseDateString(d.end, `${at}.end`);
      return { value: { start, ...(end && { end }) } satisfies DateValue };
    }
    case 'checkbox':
      if (typeof raw !== 'boolean') throw invalid(`${at} should be a boolean.`);
      return { value: raw };
    case 'url':
      return { value: readString(raw, at) };
    case 'email':
      return { value: readString(raw, at, (s) => /^[^\s@]+@[^\s@]+$/.test(s)) };
    case 'phone':
      return { value: readString(raw, at, (s) => /^[+\d][\d\s().-]*$/.test(s)) };
    case 'files': {
      if (!Array.isArray(raw)) throw invalid(`${at} should be an array.`);
      const files = raw.map((x, i): FileValue => {
        const f = asObject(x, `${at}[${i}]`);
        const url = (f.external as { url?: unknown } | undefined)?.url;
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
          throw invalid(`${at}[${i}] should be an external file with an http(s) URL.`);
        }
        const name = typeof f.name === 'string' && f.name ? f.name : url;
        return { url, name: name.slice(0, 200) };
      });
      return { value: files.length ? files : null };
    }
    case 'person': {
      if (!Array.isArray(raw)) throw invalid(`${at} should be an array.`);
      const ids = raw.map((x, i) => {
        const id = parseId(asObject(x, `${at}[${i}]`).id);
        if (!id || !ctx.isUser(id))
          throw invalid(`${at}[${i}].id should be a user of the workspace.`);
        return id;
      });
      return { value: ids.length ? [...new Set(ids)] : null };
    }
    case 'relation': {
      if (!Array.isArray(raw)) throw invalid(`${at} should be an array.`);
      if (raw.length > 100) throw invalid(`${at} should have at most 100 items.`);
      const ids = raw.map((x, i) => {
        const id = parseId(asObject(x, `${at}[${i}]`).id);
        if (!id) throw invalid(`${at}[${i}].id should be a valid uuid.`);
        return id;
      });
      return { value: [...new Set(ids)] };
    }
    default:
      throw invalid(`${where}: ${type} properties can't be set.`);
  }
}
