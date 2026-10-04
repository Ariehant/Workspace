import { dateFromString, formatDateString, formatNumber, formatTimestamp } from './format';
import { cellText, cellValue, effectiveType, isDateValue, propertyKind } from './properties';
import type { CalculationId, DisplayContext, Property, PropertyType, Row } from './schema';

export interface CalculationInfo {
  id: CalculationId;
  /** Menu label. */
  label: string;
  /** Short label shown before the result, e.g. "Sum". */
  short: string;
  group: 'count' | 'percent' | 'more';
}

const ALL: CalculationInfo[] = [
  { id: 'countAll', label: 'Count all', short: 'Count', group: 'count' },
  { id: 'countValues', label: 'Count values', short: 'Values', group: 'count' },
  { id: 'countUnique', label: 'Count unique values', short: 'Unique', group: 'count' },
  { id: 'countEmpty', label: 'Count empty', short: 'Empty', group: 'count' },
  { id: 'countNotEmpty', label: 'Count not empty', short: 'Not empty', group: 'count' },
  { id: 'percentEmpty', label: 'Percent empty', short: 'Empty', group: 'percent' },
  { id: 'percentNotEmpty', label: 'Percent not empty', short: 'Not empty', group: 'percent' },
];

const NUMBER: CalculationInfo[] = [
  { id: 'sum', label: 'Sum', short: 'Sum', group: 'more' },
  { id: 'average', label: 'Average', short: 'Average', group: 'more' },
  { id: 'median', label: 'Median', short: 'Median', group: 'more' },
  { id: 'min', label: 'Min', short: 'Min', group: 'more' },
  { id: 'max', label: 'Max', short: 'Max', group: 'more' },
  { id: 'range', label: 'Range', short: 'Range', group: 'more' },
];

const DATE: CalculationInfo[] = [
  { id: 'earliest', label: 'Earliest date', short: 'Earliest', group: 'more' },
  { id: 'latest', label: 'Latest date', short: 'Latest', group: 'more' },
  { id: 'dateRange', label: 'Date range', short: 'Range', group: 'more' },
];

const CHECKBOX: CalculationInfo[] = [
  { id: 'countAll', label: 'Count all', short: 'Count', group: 'count' },
  { id: 'checked', label: 'Checked', short: 'Checked', group: 'count' },
  { id: 'unchecked', label: 'Unchecked', short: 'Unchecked', group: 'count' },
  { id: 'percentChecked', label: 'Percent checked', short: 'Checked', group: 'percent' },
  { id: 'percentUnchecked', label: 'Percent unchecked', short: 'Unchecked', group: 'percent' },
];

/** Calculations offered under a column of this type. */
export function calculationsFor(type: PropertyType): CalculationInfo[] {
  if (type === 'checkbox') return CHECKBOX;
  if (type === 'number' || type === 'uniqueId') return [...ALL, ...NUMBER];
  if (type === 'date' || type === 'createdTime' || type === 'lastEditedTime')
    return [...ALL, ...DATE];
  return ALL;
}

export function calculationInfo(
  type: PropertyType,
  id: CalculationId,
): CalculationInfo | undefined {
  return calculationsFor(type).find((c) => c.id === id);
}

const percent = (part: number, whole: number) =>
  whole === 0 ? '0%' : `${Math.round((part / whole) * 1000) / 10}%`;

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** Timestamps (ms) of date-like cells: the start, and the end for ranges. */
function times(row: Row, property: Property): number[] {
  const value = cellValue(row, property);
  if (typeof value === 'number') return [value];
  if (!isDateValue(value)) return [];
  const t = [dateFromString(value.start).getTime()];
  if (value.end) t.push(dateFromString(value.end).getTime());
  return t;
}

function formatSpan(ms: number): string {
  const days = Math.round(ms / 86_400_000);
  if (days < 1) {
    const hours = Math.round(ms / 3_600_000);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days < 14) return `${days} day${days === 1 ? '' : 's'}`;
  if (days < 60) return `${Math.round(days / 7)} weeks`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${Math.round(days / 365)} years`;
}

/** The result of a column calculation over `rows`, as display text. */
export function calculate(
  rows: readonly Row[],
  property: Property,
  calc: CalculationId,
  ctx: DisplayContext,
): string {
  const kind = propertyKind(property.type);
  const values = rows.map((r) => cellValue(r, property));
  const filled = values.filter((v) => !kind.isEmpty(v));
  const now = new Date(ctx.now ?? Date.now());
  switch (calc) {
    case 'countAll':
      return String(rows.length);
    case 'countValues':
      return String(filled.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0));
    case 'countUnique': {
      const unique = new Set<string>();
      rows.forEach((row, i) => {
        const v = values[i];
        if (kind.isEmpty(v)) return;
        if (Array.isArray(v) && property.type !== 'files') {
          v.forEach((x) => unique.add(JSON.stringify(x)));
        } else unique.add(cellText(row, property, ctx).toLowerCase());
      });
      return String(unique.size);
    }
    case 'countEmpty':
      return String(rows.length - filled.length);
    case 'countNotEmpty':
      return String(filled.length);
    case 'percentEmpty':
      return percent(rows.length - filled.length, rows.length);
    case 'percentNotEmpty':
      return percent(filled.length, rows.length);
    case 'checked':
      return String(values.filter((v) => v === true).length);
    case 'unchecked':
      return String(values.filter((v) => v !== true).length);
    case 'percentChecked':
      return percent(values.filter((v) => v === true).length, rows.length);
    case 'percentUnchecked':
      return percent(values.filter((v) => v !== true).length, rows.length);
    case 'sum':
    case 'average':
    case 'median':
    case 'min':
    case 'max':
    case 'range': {
      const nums = filled.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
      if (nums.length === 0) return '';
      const sum = nums.reduce((a, b) => a + b, 0);
      const mid = Math.floor(nums.length / 2);
      const result = {
        sum,
        average: sum / nums.length,
        median: nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2,
        min: nums[0]!,
        max: nums[nums.length - 1]!,
        range: nums[nums.length - 1]! - nums[0]!,
      }[calc];
      return effectiveType(property) === 'number'
        ? formatNumber(round(result), property.config)
        : String(round(result));
    }
    case 'earliest':
    case 'latest':
    case 'dateRange': {
      const all = rows.flatMap((r) => times(r, property)).sort((a, b) => a - b);
      if (all.length === 0) return '';
      if (calc === 'dateRange') return formatSpan(all[all.length - 1]! - all[0]!);
      const t = calc === 'earliest' ? all[0]! : all[all.length - 1]!;
      if (effectiveType(property) !== 'date') return formatTimestamp(t, property.config, now);
      // Show a date the way the property does (with a time only if the values have one).
      const sample = rows
        .map((r) => cellValue(r, property))
        .find((v) => isDateValue(v) && v.start.includes('T'));
      const d = new Date(t);
      const pad = (n: number) => String(n).padStart(2, '0');
      const iso = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      return formatDateString(
        sample ? `${iso}T${pad(d.getHours())}:${pad(d.getMinutes())}` : iso,
        property.config,
        now,
      );
    }
  }
}
