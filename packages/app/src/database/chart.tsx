import {
  DATE_BUCKETS,
  GROUPABLE_TYPES,
  chartData,
  updateView,
  type ChartConfig,
  type ChartType,
  type DateBucket,
  type OptionColor,
} from '@workspace/database';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui';
import { Settings2 } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { LayoutViewProps } from './cards';

const PALETTE: OptionColor[] = [
  'blue',
  'green',
  'orange',
  'purple',
  'pink',
  'red',
  'yellow',
  'brown',
  'gray',
];
const CHART_TYPES: { id: ChartType; label: string }[] = [
  { id: 'bar', label: 'Vertical bar' },
  { id: 'horizontalBar', label: 'Horizontal bar' },
  { id: 'line', label: 'Line' },
  { id: 'pie', label: 'Pie' },
  { id: 'donut', label: 'Donut' },
];

/** Theme colors as values SVG attributes accept (CSS variables resolved). */
function useColors(): (color: OptionColor | undefined, index: number) => string {
  return useMemo(() => {
    const style = getComputedStyle(document.documentElement);
    const resolve = (name: string) => style.getPropertyValue(`--ws-${name}`).trim() || '#2383e2';
    return (color, index) =>
      resolve(color && color !== 'default' ? color : PALETTE[index % PALETTE.length]!);
  }, []);
}

/** Chart: rows grouped along the X axis, measured on the Y axis. */
export default function ChartView({
  handle,
  snapshot,
  view,
  result,
  ctx,
  editable,
}: LayoutViewProps) {
  const config = view.chart;
  const data = chartData(result.rows, snapshot.properties, config, ctx);
  const color = useColors();
  const pie = config.type === 'pie' || config.type === 'donut';
  const rows = data.categories.map((c) => ({ name: c.label, total: c.total, ...c.values }));
  const muted = color('gray', 0);
  // Series take their option color; plain bars take the category's color.
  const seriesColor = (i: number) => color(data.series[i]!.color, i);
  const single = data.series.length === 1;

  let chart: ReactNode;
  if (data.categories.length === 0) {
    chart = (
      <p className="flex h-full items-center justify-center text-muted">
        {config.x ? 'No data' : 'Choose what the X axis groups by'}
      </p>
    );
  } else if (pie) {
    chart = (
      <PieChart>
        <Pie
          data={rows}
          dataKey="total"
          nameKey="name"
          innerRadius={config.type === 'donut' ? '55%' : 0}
          outerRadius="80%"
          isAnimationActive={false}
          label={config.labels ? ({ value }: { value?: number }) => String(value ?? '') : false}
        >
          {data.categories.map((c, i) => (
            <Cell key={c.key} fill={color(c.color, i)} />
          ))}
        </Pie>
        <Tooltip />
        {config.legend && <Legend />}
      </PieChart>
    );
  } else if (config.type === 'line') {
    chart = (
      <LineChart data={rows} margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={muted} strokeOpacity={0.3} />
        <XAxis dataKey="name" tick={{ fontSize: 12 }} />
        <YAxis tick={{ fontSize: 12 }} allowDecimals={config.y.kind !== 'count'} />
        <Tooltip />
        {config.legend && !single && <Legend />}
        {data.series.map((s, i) => (
          <Line
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stroke={seriesColor(i)}
            strokeWidth={2}
            isAnimationActive={false}
          >
            {config.labels && <LabelList dataKey={s.key} position="top" fontSize={11} />}
          </Line>
        ))}
      </LineChart>
    );
  } else {
    const horizontal = config.type === 'horizontalBar';
    chart = (
      <BarChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 16, right: 16, bottom: 8, left: horizontal ? 24 : 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke={muted} strokeOpacity={0.3} />
        {horizontal ? (
          <>
            <XAxis
              type="number"
              tick={{ fontSize: 12 }}
              allowDecimals={config.y.kind !== 'count'}
            />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={100} />
          </>
        ) : (
          <>
            <XAxis dataKey="name" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} allowDecimals={config.y.kind !== 'count'} />
          </>
        )}
        <Tooltip />
        {config.legend && !single && <Legend />}
        {data.series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId={config.stacked ? 'stack' : undefined}
            fill={seriesColor(i)}
            isAnimationActive={false}
          >
            {single && data.categories.map((c, j) => <Cell key={c.key} fill={color(c.color, j)} />)}
            {config.labels && (
              <LabelList dataKey={s.key} position={horizontal ? 'right' : 'top'} fontSize={11} />
            )}
          </Bar>
        ))}
      </BarChart>
    );
  }

  return (
    <div data-testid="chart-view" data-chart-type={config.type} className="pt-2 pb-4 text-sm">
      <div className="flex h-10 items-center justify-end">
        {editable && !snapshot.meta.lockViews && <ChartSettings {...{ handle, snapshot, view }} />}
      </div>
      <div className="h-[360px] w-full" data-testid="chart-canvas">
        {data.categories.length === 0 ? (
          chart
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {chart as never}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex h-9 items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

const selectClass = 'h-7 w-40 rounded border border-line bg-transparent px-1.5 text-sm text-fg';

function ChartSettings({
  handle,
  snapshot,
  view,
}: Pick<LayoutViewProps, 'handle' | 'snapshot' | 'view'>) {
  const config = view.chart;
  const set = (changes: Partial<ChartConfig>) =>
    updateView(handle.doc, view.id, { chart: { ...config, ...changes } });
  const groupable = snapshot.properties.filter((p) => GROUPABLE_TYPES.includes(p.type));
  const numbers = snapshot.properties.filter(
    (p) =>
      p.type === 'number' ||
      ((p.type === 'formula' || p.type === 'rollup') && p.config.resultType === 'number'),
  );
  const xProperty = snapshot.properties.find((p) => p.id === config.x?.propertyId);
  const isDate = xProperty && ['date', 'createdTime', 'lastEditedTime'].includes(xProperty.type);
  const pie = config.type === 'pie' || config.type === 'donut';
  const toggle = (key: 'stacked' | 'legend' | 'labels' | 'hideEmpty', label: string) => (
    <Field label={label}>
      <input
        type="checkbox"
        aria-label={label}
        checked={config[key]}
        onChange={(e) => set({ [key]: e.target.checked })}
        className="size-4 accent-[var(--ws-accent)]"
      />
    </Field>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-7 items-center gap-1 rounded px-1.5 text-muted hover:bg-hover"
        >
          <Settings2 size={15} /> Chart settings
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3" data-testid="chart-settings">
        <Field label="Chart type">
          <select
            aria-label="Chart type"
            value={config.type}
            onChange={(e) => set({ type: e.target.value as ChartType })}
            className={selectClass}
          >
            {CHART_TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={pie ? 'Slices' : 'X axis'}>
          <select
            aria-label="X axis"
            value={config.x?.propertyId ?? ''}
            onChange={(e) => {
              const p = snapshot.properties.find((q) => q.id === e.target.value);
              const date = p && ['date', 'createdTime', 'lastEditedTime'].includes(p.type);
              set({
                x: p
                  ? { propertyId: p.id, ...(date ? { dateBucket: 'month' as DateBucket } : {}) }
                  : null,
              });
            }}
            className={selectClass}
          >
            <option value="">None</option>
            {groupable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {isDate && config.x && (
          <Field label="Group dates by">
            <select
              aria-label="Group dates by"
              value={config.x.dateBucket ?? 'month'}
              onChange={(e) =>
                set({ x: { ...config.x!, dateBucket: e.target.value as DateBucket } })
              }
              className={selectClass}
            >
              {DATE_BUCKETS.filter((b) => b.id !== 'relative').map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Y axis">
          <select
            aria-label="Y axis"
            value={config.y.kind === 'count' ? '' : config.y.propertyId}
            onChange={(e) =>
              set({
                y: e.target.value
                  ? {
                      kind: 'property',
                      propertyId: e.target.value,
                      calc: config.y.kind === 'property' ? config.y.calc : 'sum',
                    }
                  : { kind: 'count' },
              })
            }
            className={selectClass}
          >
            <option value="">Count</option>
            {numbers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        {config.y.kind === 'property' && (
          <Field label="Calculate">
            <select
              aria-label="Calculate"
              value={config.y.calc}
              onChange={(e) =>
                set({
                  y: {
                    ...(config.y as Extract<ChartConfig['y'], { kind: 'property' }>),
                    calc: e.target.value as 'sum',
                  },
                })
              }
              className={selectClass}
            >
              {(['sum', 'average', 'median', 'min', 'max'] as const).map((c) => (
                <option key={c} value={c}>
                  {c[0]!.toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </Field>
        )}
        {!pie && (
          <Field label="Group by">
            <select
              aria-label="Series"
              value={config.series?.propertyId ?? ''}
              onChange={(e) =>
                set({ series: e.target.value ? { propertyId: e.target.value } : null })
              }
              className={selectClass}
            >
              <option value="">None</option>
              {groupable
                .filter((p) => p.id !== config.x?.propertyId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </Field>
        )}
        <Field label="Sort">
          <select
            aria-label="Sort"
            value={config.sort}
            onChange={(e) => set({ sort: e.target.value as ChartConfig['sort'] })}
            className={selectClass}
          >
            <option value="manual">Property order</option>
            <option value="xAsc">X axis ascending</option>
            <option value="xDesc">X axis descending</option>
            <option value="yAsc">Y axis ascending</option>
            <option value="yDesc">Y axis descending</option>
          </select>
        </Field>
        {!pie && config.series && toggle('stacked', 'Stacked')}
        {toggle('legend', 'Legend')}
        {toggle('labels', 'Data labels')}
        {toggle('hideEmpty', 'Hide empty groups')}
      </PopoverContent>
    </Popover>
  );
}
