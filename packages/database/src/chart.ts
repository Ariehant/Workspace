import { groupRows, NO_VALUE } from './group';
import { cellValue } from './properties';
import type { ChartConfig, DisplayContext, OptionColor, Property, Row } from './schema';

export interface ChartCategory {
  key: string;
  label: string;
  color?: OptionColor;
  /** Y value per series key (`value` without series). */
  values: Record<string, number>;
  total: number;
}

export interface ChartData {
  categories: ChartCategory[];
  /** Series (from `config.series`); one series keyed `value` without it. */
  series: { key: string; label: string; color?: OptionColor }[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** The Y value of a set of rows: their count, or a calculation over a number property. */
export function chartValue(rows: readonly Row[], config: ChartConfig, property?: Property): number {
  if (config.y.kind === 'count') return rows.length;
  if (!property) return 0;
  const nums = rows
    .map((r) => cellValue(r, property))
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length === 0) return 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  const value = {
    sum,
    average: sum / nums.length,
    median: median(nums),
    min: Math.min(...nums),
    max: Math.max(...nums),
  }[config.y.calc];
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Data for a chart view: categories from the X property's groups (in its natural
 * order, then sorted as configured), each with a value per series.
 */
export function chartData(
  rows: readonly Row[],
  properties: readonly Property[],
  config: ChartConfig,
  ctx: DisplayContext,
): ChartData {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const xProperty = config.x ? byId.get(config.x.propertyId) : undefined;
  if (!config.x || !xProperty) return { categories: [], series: [] };
  const yProperty = config.y.kind === 'property' ? byId.get(config.y.propertyId) : undefined;
  const seriesProperty =
    config.series && config.type !== 'pie' && config.type !== 'donut'
      ? byId.get(config.series.propertyId)
      : undefined;
  const series = seriesProperty
    ? groupRows(rows, seriesProperty, { ...config.series!, hideEmpty: true }, ctx).map((g) => ({
        key: g.info.key,
        label: g.info.label,
        color: g.info.color,
      }))
    : [{ key: 'value', label: yProperty?.name ?? 'Count' }];

  let categories = groupRows(rows, xProperty, config.x, ctx).map((group): ChartCategory => {
    const values: Record<string, number> = {};
    if (seriesProperty) {
      for (const sub of groupRows(group.rows, seriesProperty, config.series!, ctx)) {
        values[sub.info.key] = chartValue(sub.rows, config, yProperty);
      }
      for (const s of series) values[s.key] ??= 0;
    } else {
      values.value = chartValue(group.rows, config, yProperty);
    }
    return {
      key: group.info.key,
      label: group.info.label,
      color: group.info.color,
      values,
      total: seriesProperty ? chartValue(group.rows, config, yProperty) : values.value!,
    };
  });
  if (config.hideEmpty || config.x.hideEmpty) {
    categories = categories.filter((c) => c.total !== 0 || c.key !== NO_VALUE);
    categories = categories.filter((c) => Object.values(c.values).some((v) => v !== 0));
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  switch (config.sort) {
    case 'xAsc':
      categories.sort((a, b) => collator.compare(a.label, b.label));
      break;
    case 'xDesc':
      categories.sort((a, b) => collator.compare(b.label, a.label));
      break;
    case 'yAsc':
      categories.sort((a, b) => a.total - b.total);
      break;
    case 'yDesc':
      categories.sort((a, b) => b.total - a.total);
      break;
  }
  return { categories, series };
}
