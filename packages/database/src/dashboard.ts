/**
 * Dashboard views (Phase 8 #19): a grid of widgets over the rows the view's own filter keeps.
 * A widget is a number (a calculation over a property, or the row count), a chart (a chart
 * view's settings of its own), or another view of the same database. Pure: the config is
 * changed here and written with `updateView(doc, id, { dashboard })`.
 */
import { newId } from '@workspace/core';
import { calculate, calculationInfo } from './calc';
import {
  DEFAULT_VIEW_CONFIG,
  type DashboardConfig,
  type DashboardWidget,
  type DisplayContext,
  type GroupBy,
  type Property,
  type Row,
} from './schema';

/** The widgets a new dashboard starts with: how many pages, and a chart by `x` if any. */
export function defaultWidgets(x: GroupBy | null): DashboardWidget[] {
  const widgets: DashboardWidget[] = [
    {
      id: newId(),
      kind: 'number',
      title: '',
      width: 1,
      number: { propertyId: null, calc: 'countAll' },
    },
  ];
  if (x) {
    widgets.push({
      id: newId(),
      kind: 'chart',
      title: '',
      width: 2,
      chart: { ...DEFAULT_VIEW_CONFIG.chart, x },
    });
  }
  return widgets;
}

/** A new widget of `kind` (a count, a chart by `x`, or the first other view). */
export function newWidget(
  kind: DashboardWidget['kind'],
  options: { x?: GroupBy | null; viewId?: string } = {},
): DashboardWidget {
  const id = newId();
  if (kind === 'number') {
    return { id, kind, title: '', width: 1, number: { propertyId: null, calc: 'countAll' } };
  }
  if (kind === 'chart') {
    return {
      id,
      kind,
      title: '',
      width: 2,
      chart: { ...DEFAULT_VIEW_CONFIG.chart, x: options.x ?? null },
    };
  }
  return { id, kind, title: '', width: 3, ...(options.viewId && { viewId: options.viewId }) };
}

/** A number widget's value, as display text (in the property's format). */
export function numberWidgetText(
  rows: readonly Row[],
  properties: readonly Property[],
  widget: DashboardWidget,
  ctx: DisplayContext,
): string {
  const number = widget.number ?? { propertyId: null, calc: 'countAll' };
  const property =
    number.propertyId === null ? undefined : properties.find((p) => p.id === number.propertyId);
  if (!property) return new Intl.NumberFormat().format(rows.length);
  return calculate(rows, property, number.calc, ctx);
}

const replace = (config: DashboardConfig, widgets: DashboardWidget[]): DashboardConfig => ({
  ...config,
  widgets,
});

export function addWidget(config: DashboardConfig, widget: DashboardWidget): DashboardConfig {
  return replace(config, [...config.widgets, widget]);
}

export function removeWidget(config: DashboardConfig, id: string): DashboardConfig {
  return replace(
    config,
    config.widgets.filter((w) => w.id !== id),
  );
}

/** Change one widget (its title, width, settings). */
export function updateWidget(
  config: DashboardConfig,
  id: string,
  changes: Partial<Omit<DashboardWidget, 'id'>>,
): DashboardConfig {
  return replace(
    config,
    config.widgets.map((w) => (w.id === id ? { ...w, ...changes } : w)),
  );
}

/** Move a widget one place earlier (-1) or later (+1); at an end, it stays. */
export function moveWidget(config: DashboardConfig, id: string, by: -1 | 1): DashboardConfig {
  const widgets = [...config.widgets];
  const at = widgets.findIndex((w) => w.id === id);
  const to = at + by;
  if (at < 0 || to < 0 || to >= widgets.length) return config;
  [widgets[at], widgets[to]] = [widgets[to]!, widgets[at]!];
  return replace(config, widgets);
}

/** A widget's title when it has none of its own. */
export function widgetTitle(
  widget: DashboardWidget,
  properties: readonly Property[],
  viewName: (id: string) => string | undefined,
): string {
  if (widget.title.trim()) return widget.title;
  const name = (id: string | null | undefined) =>
    id ? properties.find((p) => p.id === id)?.name : undefined;
  if (widget.kind === 'number') {
    const n = widget.number;
    if (!n || n.propertyId === null) return 'Pages';
    const property = properties.find((p) => p.id === n.propertyId);
    if (!property) return 'Pages';
    const calc = calculationInfo(property.type, n.calc)?.label ?? n.calc;
    return `${calc} · ${property.name}`;
  }
  if (widget.kind === 'chart') {
    const x = name(widget.chart?.x?.propertyId);
    return x ? `By ${x}` : 'Chart';
  }
  return (widget.viewId && viewName(widget.viewId)) || 'View';
}
