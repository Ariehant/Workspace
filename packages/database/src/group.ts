import { dateFromString, formatDateString } from './format';
import {
  STATUS_GROUPS,
  cellValue,
  effectiveType,
  isDateValue,
  optionsOf,
  propertyKind,
} from './properties';
import type {
  DateBucket,
  DisplayContext,
  GroupBy,
  OptionColor,
  Property,
  PropertyType,
  Row,
} from './schema';

/** Key of the group for rows without a value. */
export const NO_VALUE = '__none__';

export interface GroupInfo {
  key: string;
  label: string;
  /** Option color (select, multi-select, status). */
  color?: OptionColor;
  /** Shown as a status pill. */
  status?: boolean;
  /**
   * The value a row gets when it is added to (or dropped into) this group;
   * `undefined` when the group can't be set (computed, buckets of many values).
   */
  value: unknown;
}

export const GROUPABLE_TYPES: readonly PropertyType[] = [
  'select',
  'status',
  'multiSelect',
  'checkbox',
  'person',
  'createdBy',
  'lastEditedBy',
  'date',
  'createdTime',
  'lastEditedTime',
  'title',
  'text',
  'url',
  'email',
  'phone',
  'number',
  'formula',
];

export const DATE_BUCKETS: { id: DateBucket; label: string }[] = [
  { id: 'relative', label: 'Relative' },
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'year', label: 'Year' },
];

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const DAY_MS = 86_400_000;
const dayNumber = (d: Date) =>
  Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);

const RELATIVE: { key: string; label: string; test(days: number): boolean }[] = [
  { key: 'older', label: 'Older', test: (d) => d < -30 },
  { key: 'last30', label: 'Last 30 days', test: (d) => d < -7 },
  { key: 'last7', label: 'Last 7 days', test: (d) => d < -1 },
  { key: 'yesterday', label: 'Yesterday', test: (d) => d === -1 },
  { key: 'today', label: 'Today', test: (d) => d === 0 },
  { key: 'tomorrow', label: 'Tomorrow', test: (d) => d === 1 },
  { key: 'next7', label: 'Next 7 days', test: (d) => d <= 7 },
  { key: 'next30', label: 'Next 30 days', test: (d) => d <= 30 },
  { key: 'later', label: 'Later', test: () => true },
];

const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' });

/** The bucket a date falls in, and its label. Keys sort chronologically. */
function dateKey(date: Date, bucket: DateBucket, now: Date): { key: string; label: string } {
  switch (bucket) {
    case 'relative': {
      const days = dayNumber(date) - dayNumber(now);
      const index = RELATIVE.findIndex((r) => r.test(days));
      return { key: `${index}:${RELATIVE[index]!.key}`, label: RELATIVE[index]!.label };
    }
    case 'day':
      return { key: isoDay(date), label: formatDateString(isoDay(date), {}, now) };
    case 'week': {
      const monday = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate() - ((date.getDay() + 6) % 7),
      );
      return { key: isoDay(monday), label: `Week of ${formatDateString(isoDay(monday), {}, now)}` };
    }
    case 'month':
      return {
        key: `${date.getFullYear()}-${pad(date.getMonth() + 1)}`,
        label: monthName.format(date),
      };
    case 'year':
      return { key: String(date.getFullYear()), label: String(date.getFullYear()) };
  }
}

function dateOf(value: unknown, type: PropertyType): Date | null {
  if (type === 'createdTime' || type === 'lastEditedTime') {
    return typeof value === 'number' ? new Date(value) : null;
  }
  return isDateValue(value) ? dateFromString(value.start) : null;
}

/** The groups a row belongs to (a multi-select row can be in several). */
function rowGroups(
  row: Row,
  property: Property,
  groupBy: GroupBy,
  ctx: DisplayContext,
): GroupInfo[] {
  const groups = rowGroupsOf(row, property, groupBy, ctx);
  // A formula's value comes from other properties; its groups can't be assigned.
  return property.type === 'formula' ? groups.map((g) => ({ ...g, value: undefined })) : groups;
}

function rowGroupsOf(
  row: Row,
  property: Property,
  groupBy: GroupBy,
  ctx: DisplayContext,
): GroupInfo[] {
  const value = cellValue(row, property);
  const kind = propertyKind(property.type);
  const none: GroupInfo = { key: NO_VALUE, label: `No ${property.name}`, value: null };
  const now = new Date(ctx.now ?? Date.now());

  switch (effectiveType(property)) {
    case 'select':
    case 'status': {
      if (kind.isEmpty(value)) return [none];
      const option = optionsOf(property).find((o) => o.id === value);
      if (!option) return [none];
      if (property.type === 'status' && groupBy.statusBucket === 'group') {
        const group = STATUS_GROUPS.find((g) => g.id === (option.group ?? 'todo'))!;
        return [statusGroupInfo(property, group.id)];
      }
      return [optionInfo(property, option.id)!];
    }
    case 'multiSelect': {
      if (kind.isEmpty(value)) return [none];
      const infos = (value as string[])
        .map((id) => optionInfo(property, id))
        .filter((g) => g !== null);
      return infos.length ? infos : [none];
    }
    case 'checkbox':
      return [
        value === true
          ? { key: 'true', label: 'Checked', value: true }
          : { key: 'false', label: 'Unchecked', value: false },
      ];
    case 'person':
    case 'createdBy':
    case 'lastEditedBy': {
      if (kind.isEmpty(value)) return [none];
      const ids = Array.isArray(value) ? (value as string[]) : [value as string];
      return ids.map((id) => ({
        key: id,
        label: ctx.users.get(id) ?? 'Unknown',
        value: property.type === 'person' ? [id] : undefined,
      }));
    }
    case 'date':
    case 'createdTime':
    case 'lastEditedTime': {
      const date = dateOf(value, effectiveType(property));
      if (!date) return [none];
      const bucket = groupBy.dateBucket ?? 'relative';
      const { key, label } = dateKey(date, bucket, now);
      const settable = property.type === 'date' && bucket === 'day';
      return [{ key, label, value: settable ? { start: key } : undefined }];
    }
    case 'number': {
      if (kind.isEmpty(value)) return [none];
      const n = value as number;
      const { start, end, step } = groupBy.numberRange ?? { start: 0, end: 100, step: 10 };
      if (n < start) return [{ key: `0:${start}`, label: `< ${start}`, value: undefined }];
      if (n >= end) return [{ key: `2:${end}`, label: `≥ ${end}`, value: undefined }];
      const from = start + Math.floor((n - start) / step) * step;
      const key = `1:${String(from - start).padStart(12, '0')}`;
      return [{ key, label: `${from} – ${from + step}`, value: undefined }];
    }
    default: {
      // Text-like properties.
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return [none];
      if (groupBy.textBucket === 'alphabetical') {
        const first = text.charAt(0).toUpperCase();
        const letter = /\p{L}/u.test(first) ? first : '#';
        return [{ key: letter, label: letter, value: undefined }];
      }
      return [{ key: text.toLowerCase(), label: text, value: text }];
    }
  }
}

function optionInfo(property: Property, id: string): GroupInfo | null {
  const option = optionsOf(property).find((o) => o.id === id);
  if (!option) return null;
  return {
    key: option.id,
    label: option.name,
    color: option.color,
    status: property.type === 'status',
    value: property.type === 'multiSelect' ? [option.id] : option.id,
  };
}

function statusGroupInfo(property: Property, group: string): GroupInfo {
  const info = STATUS_GROUPS.find((g) => g.id === group)!;
  const first = optionsOf(property).find((o) => (o.group ?? 'todo') === group);
  return {
    key: `group:${group}`,
    label: info.label,
    color: first?.color,
    status: true,
    value: first?.id,
  };
}

/** Groups that exist even without rows (every option, both checkbox states). */
function knownGroups(property: Property, groupBy: GroupBy): GroupInfo[] {
  switch (effectiveType(property)) {
    case 'select':
    case 'multiSelect':
      return optionsOf(property).map((o) => optionInfo(property, o.id)!);
    case 'status':
      return groupBy.statusBucket === 'group'
        ? STATUS_GROUPS.map((g) => statusGroupInfo(property, g.id))
        : optionsOf(property).map((o) => optionInfo(property, o.id)!);
    case 'checkbox':
      return [
        { key: 'true', label: 'Checked', value: true },
        { key: 'false', label: 'Unchecked', value: false },
      ];
    default:
      return [];
  }
}

export interface RowGroup {
  info: GroupInfo;
  rows: Row[];
}

/**
 * Split rows into groups, in the property's natural order (options in their order,
 * dates chronologically, text alphabetically), "No value" first. Rows keep their
 * order inside each group. Hidden groups are included (the view lists them apart).
 */
export function groupRows(
  rows: readonly Row[],
  property: Property,
  groupBy: GroupBy,
  ctx: DisplayContext,
): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const ensure = (info: GroupInfo) => {
    let group = groups.get(info.key);
    if (!group) {
      group = { info, rows: [] };
      groups.set(info.key, group);
    }
    return group;
  };
  const known = knownGroups(property, groupBy);
  const ordered = known.length > 0;
  if (ordered) {
    ensure({ key: NO_VALUE, label: `No ${property.name}`, value: null });
    known.forEach(ensure);
  }
  for (const row of rows) {
    for (const info of rowGroups(row, property, groupBy, ctx)) ensure(info).rows.push(row);
  }
  let list = [...groups.values()];
  if (!ordered) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sortKey = (g: RowGroup) =>
      property.type === 'person' ||
      property.type === 'createdBy' ||
      property.type === 'lastEditedBy'
        ? g.info.label
        : g.info.key;
    list.sort((a, b) => collator.compare(sortKey(a), sortKey(b)));
  }
  const none = list.filter((g) => g.info.key === NO_VALUE);
  list = list.filter((g) => g.info.key !== NO_VALUE);
  if (groupBy.sort === 'desc') list.reverse();
  // Checkbox groups have no "empty" group; neither do unordered groups without empties.
  list = [...none.filter((g) => g.rows.length > 0 || ordered), ...list];
  if (effectiveType(property) === 'checkbox') list = list.filter((g) => g.info.key !== NO_VALUE);
  if (groupBy.hideEmpty) list = list.filter((g) => g.rows.length > 0);
  return list;
}
