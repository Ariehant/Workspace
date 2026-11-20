/**
 * Dashboard view (Phase 8 #19): widgets in a grid over the rows the view's own filter keeps.
 * A widget is a number (the page count, or a calculation over a property), a chart (settings
 * of its own), or another view of the database in a box of its own.
 */
import {
  addWidget,
  calculationInfo,
  calculationsFor,
  moveWidget,
  newWidget,
  numberWidgetText,
  removeWidget,
  runView,
  updateView,
  updateWidget,
  widgetTitle,
  GROUPABLE_TYPES,
  type DashboardConfig,
  type DashboardWidget,
  type Property,
  type View,
  type ViewResult,
} from '@workspace/database';
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
  cn,
} from '@workspace/ui';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Hash,
  LayoutGrid,
  MoreHorizontal,
  Plus,
  Ruler,
  Sigma,
  Trash2,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { LayoutViewProps } from './cards';
import { ChartCanvas, ChartSettings } from './chart';

export interface DashboardViewProps extends LayoutViewProps {
  /** The views next to this one (a view widget shows one of them). */
  views: readonly View[];
  onOpenView(viewId: string): void;
  /** Draws another view's layout (as its tab would). */
  renderLayout(view: View, result: ViewResult): ReactNode;
}

/** Views a widget can show: those that lay out rows (not forms, nor dashboards). */
const showable = (v: View) => v.type !== 'dashboard' && v.type !== 'form';

const WIDTHS: { width: DashboardWidget['width']; label: string }[] = [
  { width: 1, label: 'A third' },
  { width: 2, label: 'Two thirds' },
  { width: 3, label: 'Full width' },
];

const SPAN: Record<DashboardWidget['width'], string> = {
  1: 'md:col-span-1',
  2: 'md:col-span-2',
  3: 'md:col-span-3',
};

export default function DashboardView(props: DashboardViewProps) {
  const { handle, snapshot, view, editable, views } = props;
  const config = view.dashboard;
  const canEdit = editable && !snapshot.meta.lockViews;
  const set = (dashboard: DashboardConfig) => updateView(handle.doc, view.id, { dashboard });
  const others = views.filter((v) => v.id !== view.id && showable(v));
  const firstGroupable = snapshot.properties.find(
    (p) => GROUPABLE_TYPES.includes(p.type) && p.type !== 'title',
  );

  return (
    <div data-testid="dashboard-view" className="pt-2 pb-4 text-sm">
      {canEdit && (
        <div className="flex h-10 items-center justify-end">
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="flex h-7 items-center gap-1 rounded px-1.5 text-muted hover:bg-hover"
              >
                <Plus size={15} /> Add a widget
              </button>
            </MenuTrigger>
            <MenuContent align="end" aria-label="Add a widget">
              <MenuItem
                icon={<Hash size={15} />}
                onSelect={() => set(addWidget(config, newWidget('number')))}
              >
                Number
              </MenuItem>
              <MenuItem
                icon={<BarChart3 size={15} />}
                onSelect={() =>
                  set(
                    addWidget(
                      config,
                      newWidget('chart', {
                        x: firstGroupable ? { propertyId: firstGroupable.id } : null,
                      }),
                    ),
                  )
                }
              >
                Chart
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger icon={<LayoutGrid size={15} />} disabled={others.length === 0}>
                  View
                </MenuSubTrigger>
                <MenuSubContent aria-label="Views">
                  {others.map((v) => (
                    <MenuItem
                      key={v.id}
                      onSelect={() => set(addWidget(config, newWidget('view', { viewId: v.id })))}
                    >
                      {v.name}
                    </MenuItem>
                  ))}
                </MenuSubContent>
              </MenuSub>
            </MenuContent>
          </Menu>
        </div>
      )}
      {config.widgets.length === 0 ? (
        <p className="py-6 text-center text-faint" data-testid="dashboard-empty">
          {canEdit ? 'No widgets yet: add a number, a chart or a view.' : 'No widgets yet.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {config.widgets.map((widget, index) => (
            <Widget
              key={widget.id}
              {...props}
              widget={widget}
              others={others}
              canEdit={canEdit}
              first={index === 0}
              last={index === config.widgets.length - 1}
              onChange={(changes) => set(updateWidget(config, widget.id, changes))}
              onMove={(by) => set(moveWidget(config, widget.id, by))}
              onRemove={() => set(removeWidget(config, widget.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface WidgetProps extends DashboardViewProps {
  widget: DashboardWidget;
  others: readonly View[];
  canEdit: boolean;
  first: boolean;
  last: boolean;
  onChange(changes: Partial<Omit<DashboardWidget, 'id'>>): void;
  onMove(by: -1 | 1): void;
  onRemove(): void;
}

function Widget(props: WidgetProps) {
  const { widget, snapshot, views, canEdit, onChange } = props;
  const properties = snapshot.properties;
  const title = widgetTitle(widget, properties, (id) => views.find((v) => v.id === id)?.name);
  const headingId = `widget-${widget.id}`;
  return (
    <section
      aria-labelledby={headingId}
      data-testid="dashboard-widget"
      data-kind={widget.kind}
      className={cn(
        'flex min-w-0 flex-col rounded-lg border border-line bg-surface p-3',
        SPAN[widget.width],
      )}
    >
      <header className="mb-2 flex min-h-7 items-center gap-1">
        <h2 id={headingId} className="flex min-w-0 flex-1 font-medium">
          {canEdit ? (
            <WidgetTitle
              value={widget.title}
              shown={title}
              onChange={(t) => onChange({ title: t })}
            />
          ) : (
            <span className="truncate px-1">{title}</span>
          )}
        </h2>
        {widget.kind === 'chart' && canEdit && (
          <ChartSettings
            config={widget.chart!}
            properties={properties}
            onChange={(chart) => onChange({ chart })}
            label="Chart"
          />
        )}
        {widget.kind === 'view' && widget.viewId && views.some((v) => v.id === widget.viewId) && (
          <button
            type="button"
            onClick={() => props.onOpenView(widget.viewId!)}
            className="flex h-7 items-center gap-1 rounded px-1.5 text-muted hover:bg-hover"
          >
            <ArrowUpRight size={15} /> Open
          </button>
        )}
        {canEdit && <WidgetMenu {...props} title={title} />}
      </header>
      <WidgetBody {...props} />
    </section>
  );
}

/** The title: a button that edits it in place (emptied: the widget's own default again). */
function WidgetTitle({
  value,
  shown,
  onChange,
}: {
  value: string;
  shown: string;
  onChange(value: string): void;
}) {
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <button
        type="button"
        title="Rename"
        onClick={() => setText(value)}
        className="min-w-0 truncate rounded px-1 text-left hover:bg-hover"
      >
        {shown}
      </button>
    );
  }
  const commit = () => {
    if (text.trim() !== value) onChange(text.trim());
    setText(null);
  };
  return (
    <input
      aria-label="Widget title"
      autoFocus
      value={text}
      placeholder={shown}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setText(null);
      }}
      className="min-w-0 flex-1 rounded bg-hover px-1 outline-none"
    />
  );
}

function WidgetMenu(props: WidgetProps & { title: string }) {
  const { widget, snapshot, others, first, last, onChange, title } = props;
  const properties = snapshot.properties;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          aria-label={`Widget options: ${title}`}
          className="flex size-7 items-center justify-center rounded text-muted hover:bg-hover"
        >
          <MoreHorizontal size={16} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" aria-label="Widget options">
        {widget.kind === 'number' && <NumberSettings {...props} properties={properties} />}
        {widget.kind === 'view' && (
          <MenuSub>
            <MenuSubTrigger icon={<LayoutGrid size={15} />}>Show view</MenuSubTrigger>
            <MenuSubContent>
              <MenuRadioGroup
                value={widget.viewId ?? ''}
                onValueChange={(viewId) => onChange({ viewId })}
              >
                {others.map((v) => (
                  <MenuRadioItem key={v.id} value={v.id}>
                    {v.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubContent>
          </MenuSub>
        )}
        <MenuSub>
          <MenuSubTrigger icon={<Ruler size={15} />}>Width</MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup
              value={String(widget.width)}
              onValueChange={(w) => onChange({ width: Number(w) as DashboardWidget['width'] })}
            >
              {WIDTHS.map((w) => (
                <MenuRadioItem key={w.width} value={String(w.width)}>
                  {w.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
        <MenuSeparator />
        <MenuItem icon={<ArrowLeft size={15} />} disabled={first} onSelect={() => props.onMove(-1)}>
          Move earlier
        </MenuItem>
        <MenuItem icon={<ArrowRight size={15} />} disabled={last} onSelect={() => props.onMove(1)}>
          Move later
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 size={15} />} danger onSelect={props.onRemove}>
          Remove widget
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** A number widget's property and calculation. */
function NumberSettings({
  widget,
  properties,
  onChange,
}: WidgetProps & { properties: readonly Property[] }) {
  const number = widget.number ?? { propertyId: null, calc: 'countAll' as const };
  const property = properties.find((p) => p.id === number.propertyId);
  const choices = properties.filter((p) => p.type !== 'button');
  return (
    <>
      <MenuSub>
        <MenuSubTrigger icon={<Hash size={15} />}>Property</MenuSubTrigger>
        <MenuSubContent className="max-h-80 overflow-y-auto">
          <MenuRadioGroup
            value={property?.id ?? ''}
            onValueChange={(id) => {
              const p = properties.find((q) => q.id === id);
              if (!p) return onChange({ number: { propertyId: null, calc: 'countAll' } });
              const keep = calculationInfo(p.type, number.calc);
              const calc = keep
                ? number.calc
                : p.type === 'number'
                  ? 'sum'
                  : calculationsFor(p.type)[0]!.id;
              onChange({ number: { propertyId: p.id, calc } });
            }}
          >
            <MenuRadioItem value="">Page count</MenuRadioItem>
            {choices.map((p) => (
              <MenuRadioItem key={p.id} value={p.id}>
                {p.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuSubContent>
      </MenuSub>
      {property && (
        <MenuSub>
          <MenuSubTrigger icon={<Sigma size={15} />}>Calculate</MenuSubTrigger>
          <MenuSubContent>
            <MenuRadioGroup
              value={number.calc}
              onValueChange={(calc) =>
                onChange({
                  number: { propertyId: property.id, calc: calc as typeof number.calc },
                })
              }
            >
              {calculationsFor(property.type).map((c) => (
                <MenuRadioItem key={c.id} value={c.id}>
                  {c.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubContent>
        </MenuSub>
      )}
      <MenuSeparator />
    </>
  );
}

function WidgetBody(props: WidgetProps) {
  const { widget, snapshot, result, ctx, views } = props;
  if (widget.kind === 'number') {
    return (
      <p className="py-3 text-3xl font-semibold tabular-nums" data-testid="widget-number">
        {numberWidgetText(result.rows, snapshot.properties, widget, ctx)}
      </p>
    );
  }
  if (widget.kind === 'chart') {
    return (
      <ChartCanvas
        config={widget.chart!}
        rows={result.rows}
        properties={snapshot.properties}
        ctx={ctx}
        height={240}
      />
    );
  }
  const shown = views.find((v) => v.id === widget.viewId);
  if (!shown || !showable(shown)) {
    return <p className="py-3 text-faint">This view isn’t there any more.</p>;
  }
  // The other view's layout over the rows this dashboard keeps (its filter, then theirs).
  const rows = runView({ ...snapshot, rows: result.rows }, shown, ctx);
  return (
    <div
      className="max-h-[420px] overflow-auto"
      data-scroll-root
      data-testid="widget-view"
      data-view-type={shown.type}
    >
      <div>{props.renderLayout(shown, rows)}</div>
    </div>
  );
}
