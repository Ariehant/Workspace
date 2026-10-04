import { newId, parseDate, toIsoDate } from '@workspace/core';
import { formatDateString, formatNumber, formatTimestamp } from './format';
import {
  OPTION_COLORS,
  TITLE_PROPERTY_ID,
  type DateValue,
  type DisplayContext,
  type FileValue,
  type OptionColor,
  type Property,
  type PropertyConfig,
  type PropertyType,
  type Row,
  type SelectOption,
  type StatusGroup,
} from './schema';

/** What each property type knows about its values. */
export interface PropertyKind {
  type: PropertyType;
  label: string;
  /** Derived from the row (created/edited time and by, unique ID); never stored. */
  computed: boolean;
  defaultConfig(): PropertyConfig;
  isEmpty(value: unknown): boolean;
  /** Display text of a non-empty value (also used for search and copy). */
  text(value: unknown, property: Property, ctx: DisplayContext): string;
  /** Order of two non-empty values, ascending. */
  compare(a: unknown, b: unknown, property: Property, ctx: DisplayContext): number;
  /**
   * Read a value from text (paste, type changes). Select-like types may need new
   * options, returned alongside the value.
   */
  parse(text: string, property: Property, ctx: DisplayContext): Parsed;
}

export interface Parsed {
  value: unknown;
  newOptions?: SelectOption[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const compareText = (a: string, b: string) => collator.compare(a, b);
const compareNumber = (a: number, b: number) => a - b;
const emptyString = (v: unknown) => typeof v !== 'string' || v.trim() === '';
const emptyList = (v: unknown) => !Array.isArray(v) || v.length === 0;

function textKind(type: PropertyType, label: string): PropertyKind {
  return {
    type,
    label,
    computed: false,
    defaultConfig: () => ({}),
    isEmpty: emptyString,
    text: (v) => String(v),
    compare: (a, b) => compareText(String(a), String(b)),
    parse: (text) => ({ value: text.trim() === '' ? null : text }),
  };
}

// --- Options ---------------------------------------------------------------------------

export const optionsOf = (property: Property): SelectOption[] => property.config.options ?? [];

/** A color for the next new option, cycling through the palette (after "default"). */
export function nextOptionColor(existing: readonly SelectOption[]): OptionColor {
  return OPTION_COLORS[1 + (existing.length % (OPTION_COLORS.length - 1))]!;
}

/** Options named in `names` (case-insensitive), creating the missing ones. */
function resolveOptions(
  names: string[],
  property: Property,
  group?: StatusGroup,
): Parsed & {
  ids: string[];
} {
  const known = [...optionsOf(property)];
  const created: SelectOption[] = [];
  const ids: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    let option = known.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!option) {
      option = { id: newId(), name, color: nextOptionColor(known) };
      if (group) option.group = group;
      known.push(option);
      created.push(option);
    }
    if (!ids.includes(option.id)) ids.push(option.id);
  }
  return { value: ids, ids, newOptions: created.length ? created : undefined };
}

const optionIndex = (property: Property, id: unknown) =>
  optionsOf(property).findIndex((o) => o.id === id);
const optionName = (property: Property, id: unknown) =>
  optionsOf(property).find((o) => o.id === id)?.name ?? '';

export const STATUS_GROUPS: { id: StatusGroup; label: string }[] = [
  { id: 'todo', label: 'To-do' },
  { id: 'inProgress', label: 'In progress' },
  { id: 'complete', label: 'Complete' },
];

export function defaultStatusOptions(): SelectOption[] {
  return [
    { id: newId(), name: 'Not started', color: 'default', group: 'todo' },
    { id: newId(), name: 'In progress', color: 'blue', group: 'inProgress' },
    { id: newId(), name: 'Done', color: 'green', group: 'complete' },
  ];
}

// --- Dates -----------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

export const isDateValue = (v: unknown): v is DateValue =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as DateValue).start === 'string' &&
  DATE_RE.test((v as DateValue).start);

function parseDateText(text: string): DateValue | null {
  const t = text.trim();
  if (!t) return null;
  const [startText, endText] = t.split(/\s*(?:→|->)\s*/);
  const one = (part: string | undefined): string | null => {
    if (!part) return null;
    if (DATE_RE.test(part)) return part;
    const iso = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(part);
    if (iso) return `${iso[1]}T${iso[2]}`;
    const parsed = parseDate(part.toLowerCase()) ?? new Date(part);
    return Number.isNaN(parsed.getTime()) ? null : toIsoDate(parsed);
  };
  const start = one(startText);
  if (!start) return null;
  const end = one(endText);
  return end ? { start, end } : { start };
}

// --- Registry ----------------------------------------------------------------------------

const KINDS: PropertyKind[] = [
  { ...textKind('title', 'Title') },
  textKind('text', 'Text'),
  {
    type: 'number',
    label: 'Number',
    computed: false,
    defaultConfig: () => ({}),
    isEmpty: (v) => typeof v !== 'number' || Number.isNaN(v),
    text: (v, p) => formatNumber(v as number, p.config),
    compare: (a, b) => compareNumber(a as number, b as number),
    parse: (text) => {
      const cleaned = text.replace(/[,\s$€£¥%]/g, '');
      const n = cleaned === '' ? NaN : Number(cleaned);
      return { value: Number.isFinite(n) ? n : null };
    },
  },
  {
    type: 'select',
    label: 'Select',
    computed: false,
    defaultConfig: () => ({ options: [] }),
    isEmpty: (v) => typeof v !== 'string',
    text: (v, p) => optionName(p, v),
    compare: (a, b, p) => optionIndex(p, a) - optionIndex(p, b),
    parse: (text, p) => {
      const r = resolveOptions(text.split(',').slice(0, 1), p);
      return { value: r.ids[0] ?? null, newOptions: r.newOptions };
    },
  },
  {
    type: 'multiSelect',
    label: 'Multi-select',
    computed: false,
    defaultConfig: () => ({ options: [] }),
    isEmpty: emptyList,
    text: (v, p) =>
      (v as string[])
        .map((id) => optionName(p, id))
        .filter(Boolean)
        .join(', '),
    compare: (a, b, p) => {
      const x = (a as string[]).map((id) => optionIndex(p, id));
      const y = (b as string[]).map((id) => optionIndex(p, id));
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i]! - y[i]!;
      }
      return x.length - y.length;
    },
    parse: (text, p) => {
      const r = resolveOptions(text.split(','), p);
      return { value: r.ids.length ? r.ids : null, newOptions: r.newOptions };
    },
  },
  {
    type: 'status',
    label: 'Status',
    computed: false,
    defaultConfig: () => ({ options: defaultStatusOptions() }),
    isEmpty: (v) => typeof v !== 'string',
    text: (v, p) => optionName(p, v),
    compare: (a, b, p) => {
      const group = (id: unknown) =>
        STATUS_GROUPS.findIndex((g) => g.id === optionsOf(p).find((o) => o.id === id)?.group);
      return group(a) - group(b) || optionIndex(p, a) - optionIndex(p, b);
    },
    parse: (text, p) => {
      const r = resolveOptions(text.split(',').slice(0, 1), p, 'todo');
      return { value: r.ids[0] ?? null, newOptions: r.newOptions };
    },
  },
  {
    type: 'date',
    label: 'Date',
    computed: false,
    defaultConfig: () => ({}),
    isEmpty: (v) => !isDateValue(v),
    text: (v, p, ctx) => {
      const d = v as DateValue;
      const now = new Date(ctx.now ?? Date.now());
      const one = (s: string) => formatDateString(s, p.config, now);
      return d.end ? `${one(d.start)} → ${one(d.end)}` : one(d.start);
    },
    compare: (a, b) => compareText((a as DateValue).start, (b as DateValue).start),
    parse: (text) => ({ value: parseDateText(text) }),
  },
  {
    type: 'checkbox',
    label: 'Checkbox',
    computed: false,
    defaultConfig: () => ({}),
    // An unchecked box is a value (false), but filters treat it as "empty".
    isEmpty: (v) => v !== true,
    text: (v) => (v === true ? 'Yes' : 'No'),
    compare: (a, b) => Number(a === true) - Number(b === true),
    parse: (text) => ({ value: /^(true|yes|y|1|x|✓|✔|☑|checked|on|done)$/i.test(text.trim()) }),
  },
  textKind('url', 'URL'),
  textKind('email', 'Email'),
  textKind('phone', 'Phone'),
  {
    type: 'files',
    label: 'Files & media',
    computed: false,
    defaultConfig: () => ({}),
    isEmpty: emptyList,
    text: (v) => (v as FileValue[]).map((f) => f.name).join(', '),
    compare: (a, b) =>
      compareText((a as FileValue[])[0]?.name ?? '', (b as FileValue[])[0]?.name ?? ''),
    parse: (text) => {
      const files = text
        .split(/[\s,]+/)
        .filter((part) => /^https?:\/\/\S+$/.test(part))
        .map((url) => ({
          url,
          name:
            url
              .replace(/[?#].*$/, '')
              .split('/')
              .pop() || url,
        }));
      return { value: files.length ? files : null };
    },
  },
  {
    type: 'person',
    label: 'Person',
    computed: false,
    defaultConfig: () => ({}),
    isEmpty: emptyList,
    text: (v, _p, ctx) =>
      (v as string[])
        .map((id) => ctx.users.get(id) ?? '')
        .filter(Boolean)
        .join(', '),
    compare: (a, b, _p, ctx) =>
      compareText(
        ctx.users.get((a as string[])[0] ?? '') ?? '',
        ctx.users.get((b as string[])[0] ?? '') ?? '',
      ),
    parse: (text, _p, ctx) => {
      const names = text.split(',').map((n) => n.trim().toLowerCase());
      const ids = [...ctx.users].filter(([, name]) => names.includes(name.toLowerCase()));
      return { value: ids.length ? ids.map(([id]) => id) : null };
    },
  },
  computedKind('createdTime', 'Created time', 'time'),
  computedKind('createdBy', 'Created by', 'user'),
  computedKind('lastEditedTime', 'Last edited time', 'time'),
  computedKind('lastEditedBy', 'Last edited by', 'user'),
  {
    ...computedKind('uniqueId', 'ID', 'number'),
    text: (v, p) => `${p.config.prefix ? `${p.config.prefix}-` : ''}${String(v)}`,
  },
];

function computedKind(
  type: PropertyType,
  label: string,
  of: 'time' | 'user' | 'number',
): PropertyKind {
  return {
    type,
    label,
    computed: true,
    defaultConfig: () => ({}),
    isEmpty: (v) => v === null || v === undefined,
    text: (v, p, ctx) =>
      of === 'time'
        ? formatTimestamp(v as number, p.config, new Date(ctx.now ?? Date.now()))
        : of === 'user'
          ? (ctx.users.get(v as string) ?? '')
          : String(v),
    compare: (a, b, _p, ctx) =>
      of === 'user'
        ? compareText(ctx.users.get(a as string) ?? '', ctx.users.get(b as string) ?? '')
        : compareNumber(a as number, b as number),
    parse: () => ({ value: null }),
  };
}

const BY_TYPE = new Map(KINDS.map((k) => [k.type, k]));

export function propertyKind(type: PropertyType): PropertyKind {
  return BY_TYPE.get(type) ?? BY_TYPE.get('text')!;
}

/** Types offered when adding a property or changing its type (title is fixed). */
export const PROPERTY_TYPES: PropertyType[] = KINDS.map((k) => k.type).filter((t) => t !== 'title');

// --- Reading values ----------------------------------------------------------------------

/** The value of a property for a row: stored, or derived for computed types. */
export function cellValue(row: Row, property: Property): unknown {
  switch (property.type) {
    case 'title':
      return row.title;
    case 'createdTime':
      return row.createdAt;
    case 'createdBy':
      return row.createdBy;
    case 'lastEditedTime':
      return row.updatedAt;
    case 'lastEditedBy':
      return row.updatedBy;
    case 'uniqueId':
      return row.uid;
    default:
      return row.values[property.id] ?? null;
  }
}

export function isCellEmpty(row: Row, property: Property): boolean {
  return propertyKind(property.type).isEmpty(cellValue(row, property));
}

/** Display text of a cell; empty string for empty cells. */
export function cellText(row: Row, property: Property, ctx: DisplayContext): string {
  const kind = propertyKind(property.type);
  const value = cellValue(row, property);
  return kind.isEmpty(value) && property.type !== 'checkbox' ? '' : kind.text(value, property, ctx);
}

/** Text of every non-title property, one per line, for the search index. */
export function rowPropertiesText(
  row: Row,
  properties: readonly Property[],
  ctx: DisplayContext,
): string {
  return properties
    .filter((p) => p.id !== TITLE_PROPERTY_ID && !propertyKind(p.type).computed)
    .filter((p) => p.type !== 'checkbox' && !isCellEmpty(row, p))
    .map((p) => cellText(row, p, ctx))
    .join('\n');
}
