import { dateFromString } from './format';
import { cellText, cellValue, effectiveType, isDateValue, propertyKind } from './properties';
import type {
  DateValue,
  DisplayContext,
  FormulaResultType,
  Property,
  PropertyConfig,
  RollupCalculation,
  Row,
} from './schema';

export interface RollupCalculationInfo {
  id: RollupCalculation;
  label: string;
  group: 'show' | 'count' | 'percent' | 'more';
}

const SHOW: RollupCalculationInfo[] = [
  { id: 'showOriginal', label: 'Show original', group: 'show' },
  { id: 'showUnique', label: 'Show unique values', group: 'show' },
];
const COUNT: RollupCalculationInfo[] = [
  { id: 'countAll', label: 'Count all', group: 'count' },
  { id: 'countValues', label: 'Count values', group: 'count' },
  { id: 'countUnique', label: 'Count unique values', group: 'count' },
  { id: 'countEmpty', label: 'Count empty', group: 'count' },
  { id: 'countNotEmpty', label: 'Count not empty', group: 'count' },
  { id: 'percentEmpty', label: 'Percent empty', group: 'percent' },
  { id: 'percentNotEmpty', label: 'Percent not empty', group: 'percent' },
];
const NUMBER: RollupCalculationInfo[] = [
  { id: 'sum', label: 'Sum', group: 'more' },
  { id: 'average', label: 'Average', group: 'more' },
  { id: 'median', label: 'Median', group: 'more' },
  { id: 'min', label: 'Min', group: 'more' },
  { id: 'max', label: 'Max', group: 'more' },
  { id: 'range', label: 'Range', group: 'more' },
];
const DATE: RollupCalculationInfo[] = [
  { id: 'earliest', label: 'Earliest date', group: 'more' },
  { id: 'latest', label: 'Latest date', group: 'more' },
  { id: 'dateRange', label: 'Date range', group: 'more' },
];
const CHECKBOX: RollupCalculationInfo[] = [
  { id: 'checked', label: 'Checked', group: 'count' },
  { id: 'unchecked', label: 'Unchecked', group: 'count' },
  { id: 'percentChecked', label: 'Percent checked', group: 'percent' },
  { id: 'percentUnchecked', label: 'Percent unchecked', group: 'percent' },
];

const isDateType = (t: string) => t === 'date' || t === 'createdTime' || t === 'lastEditedTime';
const isNumberType = (t: string) => t === 'number' || t === 'uniqueId';

/** Calculations a rollup of `target` offers. */
export function rollupCalculationsFor(target: Property | undefined): RollupCalculationInfo[] {
  const type = target ? effectiveType(target) : 'text';
  if (type === 'checkbox') return [...SHOW, { ...COUNT[0]! }, ...CHECKBOX];
  if (isNumberType(type)) return [...SHOW, ...COUNT, ...NUMBER];
  if (isDateType(type)) return [...SHOW, ...COUNT, ...DATE];
  return [...SHOW, ...COUNT];
}

export const ROLLUP_CALCULATIONS: readonly RollupCalculationInfo[] = [
  ...SHOW,
  ...COUNT,
  ...NUMBER,
  ...DATE,
  ...CHECKBOX,
];

export const rollupCalculationLabel = (id: RollupCalculation): string =>
  ROLLUP_CALCULATIONS.find((c) => c.id === id)?.label ?? id;

const PERCENT = new Set<RollupCalculation>([
  'percentEmpty',
  'percentNotEmpty',
  'percentChecked',
  'percentUnchecked',
]);

/** What a rollup's value is shown, sorted and filtered as. */
export function rollupResultType(calc: RollupCalculation): FormulaResultType {
  switch (calc) {
    case 'showOriginal':
    case 'showUnique':
      return 'text';
    case 'earliest':
    case 'latest':
    case 'dateRange':
      return 'date';
    default:
      return 'number';
  }
}

/**
 * The display config of a rollup: its own settings, falling back to the target's
 * number or date format (and percent for percentages).
 */
export function rollupConfig(rollup: Property, target: Property | undefined): PropertyConfig {
  const calc = rollup.config.calculation ?? 'showOriginal';
  const config: PropertyConfig = { ...rollup.config, resultType: rollupResultType(calc) };
  if (PERCENT.has(calc)) {
    config.numberFormat ??= 'percent';
  } else if (target && ['sum', 'average', 'median', 'min', 'max', 'range'].includes(calc)) {
    config.numberFormat ??= target.config.numberFormat;
    config.precision ??= target.config.precision;
  } else if (target && rollupResultType(calc) === 'date') {
    config.dateFormat ??= target.config.dateFormat;
    config.timeFormat ??= target.config.timeFormat;
  }
  return config;
}

const pad = (n: number) => String(n).padStart(2, '0');
const isoOf = (ms: number, time: boolean) => {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
};
const round = (n: number) => Math.round(n * 1e10) / 1e10;
const percent = (part: number, whole: number) =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10;

/**
 * A rollup's value over the related rows: a number, text or date cell value
 * (see `rollupResultType`), or null.
 */
export function computeRollup(
  rows: readonly Row[],
  target: Property,
  calc: RollupCalculation,
  ctx: DisplayContext,
): unknown {
  const kind = propertyKind(target.type);
  const values = rows.map((r) => cellValue(r, target));
  const isEmpty = (v: unknown) => target.type !== 'checkbox' && kind.isEmpty(v);
  const filled = values.filter((v) => !isEmpty(v));
  const texts = rows.map((r) => cellText(r, target, ctx)).filter((t) => t !== '');

  switch (calc) {
    case 'showOriginal':
      return texts.length ? texts.join(', ') : null;
    case 'showUnique': {
      const unique = [...new Set(texts)];
      return unique.length ? unique.join(', ') : null;
    }
    case 'countAll':
      return rows.length;
    case 'countValues':
      return filled.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 1), 0);
    case 'countUnique': {
      const unique = new Set<string>();
      rows.forEach((row, i) => {
        const v = values[i];
        if (isEmpty(v)) return;
        if (Array.isArray(v) && target.type !== 'files') {
          v.forEach((x) => unique.add(JSON.stringify(x)));
        } else unique.add(cellText(row, target, ctx).toLowerCase());
      });
      return unique.size;
    }
    case 'countEmpty':
      return rows.length - filled.length;
    case 'countNotEmpty':
      return filled.length;
    case 'percentEmpty':
      return percent(rows.length - filled.length, rows.length);
    case 'percentNotEmpty':
      return percent(filled.length, rows.length);
    case 'checked':
      return values.filter((v) => v === true).length;
    case 'unchecked':
      return values.filter((v) => v !== true).length;
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
      if (nums.length === 0) return calc === 'sum' ? 0 : null;
      const sum = nums.reduce((a, b) => a + b, 0);
      const mid = Math.floor(nums.length / 2);
      return round(
        {
          sum,
          average: sum / nums.length,
          median: nums.length % 2 ? nums[mid]! : (nums[mid - 1]! + nums[mid]!) / 2,
          min: nums[0]!,
          max: nums[nums.length - 1]!,
          range: nums[nums.length - 1]! - nums[0]!,
        }[calc],
      );
    }
    case 'earliest':
    case 'latest':
    case 'dateRange': {
      let time = false;
      const all: number[] = [];
      for (const v of filled) {
        if (typeof v === 'number') {
          all.push(v);
          time = true;
        } else if (isDateValue(v)) {
          all.push(dateFromString(v.start).getTime());
          if (v.end) all.push(dateFromString(v.end).getTime());
          if (v.start.includes('T')) time = true;
        }
      }
      if (all.length === 0) return null;
      all.sort((a, b) => a - b);
      const first = all[0]!;
      const last = all[all.length - 1]!;
      if (calc === 'dateRange') {
        return { start: isoOf(first, time), end: isoOf(last, time) } satisfies DateValue;
      }
      return { start: isoOf(calc === 'earliest' ? first : last, time) } satisfies DateValue;
    }
  }
}
