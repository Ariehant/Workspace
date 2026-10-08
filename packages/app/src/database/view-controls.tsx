import {
  DATE_BUCKETS,
  GROUPABLE_TYPES,
  ME,
  countRules,
  effectiveType,
  filterOperators,
  newFilterGroup,
  newFilterRule,
  operatorInfo,
  optionsOf,
  relativeDayLabel,
  updateFilterTree,
  type DateRangeTarget,
  type DateTarget,
  type DisplayContext,
  type Filter,
  type FilterGroup,
  type FilterRule,
  type GroupBy,
  type Property,
  type Sort,
  type ViewGroup,
} from '@workspace/database';
import { Popover, PopoverAnchor, PopoverContent, cn } from '@workspace/ui';
import { ChevronDown, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PropertyIcon, pickablePeople } from './cells';

const field =
  'h-7 rounded border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent';

// --- Property picker ---------------------------------------------------------------------

/** A searchable list of properties (to filter, sort or group by). */
export function PropertyPicker({
  properties,
  onPick,
  label,
}: {
  properties: Property[];
  onPick(property: Property): void;
  label: string;
}) {
  const [query, setQuery] = useState('');
  const matches = properties.filter((p) =>
    p.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div className="w-60" data-testid="property-picker">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) onPick(matches[0]);
        }}
        placeholder={label}
        aria-label={label}
        className="h-9 w-full border-b border-line bg-transparent px-3 outline-none"
      />
      <div className="max-h-72 overflow-y-auto p-1">
        {matches.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p)}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover"
          >
            <PropertyIcon type={p.type} />
            <span className="truncate">{p.name}</span>
          </button>
        ))}
        {matches.length === 0 && <p className="px-2 py-1.5 text-muted">No properties</p>}
      </div>
    </div>
  );
}

// --- Filter rules --------------------------------------------------------------------------

const RELATIVE_DATES: DateTarget[] = (
  [
    'today',
    'tomorrow',
    'yesterday',
    'oneWeekAgo',
    'oneWeekFromNow',
    'oneMonthAgo',
    'oneMonthFromNow',
  ] as const
).map((relative) => ({ kind: 'relative', relative }));

/** Short text of a rule's condition, for its chip: "contains servo", "Done, Doing". */
export function ruleSummary(rule: FilterRule, property: Property, ctx: DisplayContext): string {
  const info = operatorInfo(property, rule.operator);
  if (!info) return '';
  const v = rule.value;
  switch (info.value) {
    case 'none':
      return info.label.toLowerCase();
    case 'text':
    case 'number':
      return v === undefined || v === '' ? '' : `${info.label.toLowerCase()} ${String(v)}`;
    case 'boolean':
      return v ? 'Checked' : 'Unchecked';
    case 'options': {
      const names = ((v as string[] | undefined) ?? []).map(
        (id) => optionsOf(property).find((o) => o.id === id)?.name ?? '?',
      );
      return `${rule.operator === 'isNot' || rule.operator === 'doesNotContain' ? 'not ' : ''}${names.join(', ')}`;
    }
    case 'people': {
      const names = ((v as string[] | undefined) ?? []).map((id) =>
        id === ME ? 'Me' : (ctx.users.get(id) ?? '?'),
      );
      return `${rule.operator === 'doesNotContain' ? 'not ' : ''}${names.join(', ')}`;
    }
    case 'date':
      return v
        ? `${info.label === 'Is' ? '' : `${info.label.toLowerCase()} `}${relativeDayLabel(v as DateTarget)}`
        : '';
    case 'range': {
      const r = v as DateRangeTarget | undefined;
      if (!r) return '';
      return r.direction === 'this' ? `this ${r.unit}` : `${r.direction} ${r.amount} ${r.unit}s`;
    }
  }
}

/** Operator and value inputs for one rule. */
export function RuleFields({
  rule,
  property,
  ctx,
  onChange,
}: {
  rule: FilterRule;
  property: Property;
  ctx: DisplayContext;
  onChange(rule: FilterRule): void;
}) {
  const operators = filterOperators(property);
  const info = operatorInfo(property, rule.operator) ?? operators[0]!;
  const set = (value: unknown) => onChange({ ...rule, value });
  const selectedIds = (rule.value as string[] | undefined) ?? [];
  const toggleId = (id: string) =>
    set(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);

  let valueInput: ReactNode = null;
  switch (info.value) {
    case 'text':
      valueInput = (
        <input
          autoFocus
          value={(rule.value as string | undefined) ?? ''}
          onChange={(e) => set(e.target.value)}
          placeholder="Type a value…"
          aria-label="Filter value"
          className={cn(field, 'w-full')}
        />
      );
      break;
    case 'number':
      valueInput = (
        <input
          autoFocus
          type="number"
          value={typeof rule.value === 'number' ? rule.value : ''}
          onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
          placeholder="Type a number…"
          aria-label="Filter value"
          className={cn(field, 'w-full')}
        />
      );
      break;
    case 'boolean':
      valueInput = (
        <select
          aria-label="Filter value"
          value={rule.value ? 'true' : 'false'}
          onChange={(e) => set(e.target.value === 'true')}
          className={field}
        >
          <option value="true">Checked</option>
          <option value="false">Unchecked</option>
        </select>
      );
      break;
    case 'options':
      valueInput = (
        <div className="max-h-56 overflow-y-auto" role="group" aria-label="Filter options">
          {optionsOf(property).map((o) => (
            <label
              key={o.id}
              className="flex h-7 cursor-pointer items-center gap-2 rounded px-1 hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(o.id)}
                onChange={() => toggleId(o.id)}
              />
              <span
                className="ws-option"
                data-color={o.color}
                data-status={property.type === 'status' || undefined}
              >
                {o.name}
              </span>
            </label>
          ))}
          {optionsOf(property).length === 0 && <p className="px-1 text-muted">No options yet</p>}
        </div>
      );
      break;
    case 'people':
      valueInput = (
        <div role="group" aria-label="Filter people">
          {[[ME, 'Me'] as const, ...pickablePeople(ctx)].map(([id, name]) => (
            <label
              key={id}
              className="flex h-7 cursor-pointer items-center gap-2 rounded px-1 hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={selectedIds.includes(id)}
                onChange={() => toggleId(id)}
              />
              {name}
            </label>
          ))}
        </div>
      );
      break;
    case 'date': {
      const target = (rule.value as DateTarget | undefined) ?? RELATIVE_DATES[0]!;
      valueInput = (
        <div className="flex gap-1">
          <select
            aria-label="Date"
            value={target.kind === 'exact' ? 'exact' : target.relative}
            onChange={(e) =>
              set(
                e.target.value === 'exact'
                  ? { kind: 'exact', date: new Date().toISOString().slice(0, 10) }
                  : { kind: 'relative', relative: e.target.value },
              )
            }
            className={field}
          >
            {RELATIVE_DATES.map((d) => (
              <option
                key={d.kind === 'relative' ? d.relative : 'x'}
                value={d.kind === 'relative' ? d.relative : ''}
              >
                {relativeDayLabel(d)}
              </option>
            ))}
            <option value="exact">Exact date</option>
          </select>
          {target.kind === 'exact' && (
            <input
              type="date"
              aria-label="Exact date"
              value={target.date}
              onChange={(e) => e.target.value && set({ kind: 'exact', date: e.target.value })}
              className={field}
            />
          )}
        </div>
      );
      break;
    }
    case 'range': {
      const range = (rule.value as DateRangeTarget | undefined) ?? {
        direction: 'past',
        amount: 1,
        unit: 'week',
      };
      valueInput = (
        <div className="flex gap-1">
          <select
            aria-label="Range"
            value={range.direction}
            onChange={(e) => set({ ...range, direction: e.target.value })}
            className={field}
          >
            <option value="past">Past</option>
            <option value="next">Next</option>
            <option value="this">This</option>
          </select>
          {range.direction !== 'this' && (
            <input
              type="number"
              min={1}
              aria-label="Amount"
              value={range.amount}
              onChange={(e) => set({ ...range, amount: Number(e.target.value) || 1 })}
              className={cn(field, 'w-14')}
            />
          )}
          <select
            aria-label="Unit"
            value={range.unit}
            onChange={(e) => set({ ...range, unit: e.target.value })}
            className={field}
          >
            {(['day', 'week', 'month', 'year'] as const).map((u) => (
              <option key={u} value={u}>
                {range.direction === 'this' ? u : `${u}s`}
              </option>
            ))}
          </select>
        </div>
      );
      break;
    }
  }

  return (
    <>
      <select
        aria-label="Condition"
        value={info.id}
        onChange={(e) => {
          const next = operatorInfo(property, e.target.value)!;
          // Keep the value while the kind of value stays the same.
          const value =
            next.value === info.value
              ? rule.value
              : next.value === 'range'
                ? { direction: 'past', amount: 1, unit: 'week' }
                : next.value === 'date'
                  ? RELATIVE_DATES[0]
                  : next.value === 'boolean'
                    ? true
                    : undefined;
          onChange({ ...rule, operator: next.id, value });
        }}
        className={field}
      >
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {valueInput}
    </>
  );
}

/** The popover of a simple filter chip: one rule. */
export function RuleChip({
  rule,
  property,
  ctx,
  open,
  onOpenChange,
  onChange,
  onDelete,
  onAdvanced,
}: {
  rule: FilterRule;
  property: Property;
  ctx: DisplayContext;
  open: boolean;
  onOpenChange(open: boolean): void;
  onChange(rule: FilterRule): void;
  onDelete(): void;
  onAdvanced(): void;
}) {
  const summary = ruleSummary(rule, property, ctx);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <button
          type="button"
          data-testid="filter-chip"
          onClick={() => onOpenChange(!open)}
          className={cn(
            'flex h-6 max-w-64 items-center gap-1 rounded-full border px-2 text-xs',
            summary ? 'border-accent/40 bg-accent/10 text-accent' : 'border-line text-muted',
          )}
        >
          <PropertyIcon type={property.type} size={12} />
          <span className="truncate">
            {property.name}
            {summary && `: ${summary}`}
          </span>
          <ChevronDown size={12} />
        </button>
      </PopoverAnchor>
      <PopoverContent className="w-72 p-2" data-testid="filter-popover">
        <div className="mb-2 flex items-center gap-1 text-xs text-muted">
          <span className="flex-1">{property.name}</span>
          <button type="button" onClick={onAdvanced} className="rounded px-1 hover:bg-hover">
            Advanced
          </button>
          <button
            type="button"
            aria-label="Delete filter"
            onClick={onDelete}
            className="rounded p-1 hover:bg-hover"
          >
            <Trash2 size={13} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          <RuleFields rule={rule} property={property} ctx={ctx} onChange={onChange} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- Advanced filter ---------------------------------------------------------------------

/** Nested AND/OR filter groups (Notion's advanced filter). */
export function FilterGroupEditor({
  root,
  properties,
  ctx,
  onChange,
}: {
  root: FilterGroup;
  properties: Property[];
  ctx: DisplayContext;
  onChange(root: FilterGroup | null): void;
}) {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const update = (id: string, fn: (f: Filter) => Filter | null) =>
    onChange(updateFilterTree(root, id, fn));
  const addTo = (group: FilterGroup, filter: Filter) =>
    update(group.id, (g) => ({
      ...(g as FilterGroup),
      filters: [...(g as FilterGroup).filters, filter],
    }));
  const first = properties[0];

  const renderGroup = (group: FilterGroup, depth: number): ReactNode => (
    <div className="flex flex-col gap-1.5" data-testid="filter-group" data-depth={depth}>
      {group.filters.length === 0 && <p className="text-muted">No filter rules. Add one below.</p>}
      {group.filters.map((filter, i) => (
        <div key={filter.id} className="flex items-start gap-1.5">
          <div className="w-16 shrink-0 pt-1 text-xs text-muted">
            {i === 0 ? (
              'Where'
            ) : i === 1 ? (
              <select
                aria-label="And or or"
                value={group.conjunction}
                onChange={(e) =>
                  update(group.id, (g) => ({
                    ...(g as FilterGroup),
                    conjunction: e.target.value as 'and' | 'or',
                  }))
                }
                className={cn(field, 'h-6 w-full text-xs')}
              >
                <option value="and">And</option>
                <option value="or">Or</option>
              </select>
            ) : group.conjunction === 'and' ? (
              'And'
            ) : (
              'Or'
            )}
          </div>
          {filter.type === 'group' ? (
            <div className="flex-1 rounded border border-line bg-hover/40 p-1.5">
              {renderGroup(filter, depth + 1)}
            </div>
          ) : (
            <div className="flex flex-1 flex-wrap items-center gap-1" data-testid="filter-rule">
              <select
                aria-label="Property"
                value={filter.propertyId}
                onChange={(e) => {
                  const property = byId.get(e.target.value);
                  if (property)
                    update(filter.id, () => ({ ...newFilterRule(property), id: filter.id }));
                }}
                className={field}
              >
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {byId.get(filter.propertyId) && (
                <RuleFields
                  rule={filter}
                  property={byId.get(filter.propertyId)!}
                  ctx={ctx}
                  onChange={(next) => update(filter.id, () => next)}
                />
              )}
            </div>
          )}
          <button
            type="button"
            aria-label={filter.type === 'group' ? 'Delete filter group' : 'Delete filter rule'}
            onClick={() => update(filter.id, () => null)}
            className="mt-0.5 rounded p-1 text-muted hover:bg-hover"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {depth > 0 && first && (
        <button
          type="button"
          onClick={() => addTo(group, newFilterRule(first))}
          className="flex items-center gap-1 self-start text-xs text-muted hover:text-fg"
        >
          <Plus size={12} /> Add filter rule
        </button>
      )}
    </div>
  );

  return (
    <div className="flex w-[560px] max-w-[90vw] flex-col gap-2 p-2" data-testid="advanced-filter">
      {renderGroup(root, 0)}
      <div className="flex gap-3 border-t border-line pt-2 text-sm">
        {first && (
          <button
            type="button"
            onClick={() => addTo(root, newFilterRule(first))}
            className="flex items-center gap-1 text-muted hover:text-fg"
          >
            <Plus size={14} /> Add filter rule
          </button>
        )}
        {first && (
          <button
            type="button"
            onClick={() => addTo(root, newFilterGroup('and', [newFilterRule(first)]))}
            className="flex items-center gap-1 text-muted hover:text-fg"
          >
            <Plus size={14} /> Add filter group
          </button>
        )}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => onChange(null)}
          className="flex items-center gap-1 text-muted hover:text-danger"
        >
          <Trash2 size={14} /> Delete filter
        </button>
      </div>
    </div>
  );
}

/** Whether a filter needs the advanced editor (OR, or nested groups). */
export function isAdvanced(filter: FilterGroup | null): boolean {
  return (
    !!filter && (filter.conjunction === 'or' || filter.filters.some((f) => f.type === 'group'))
  );
}

export { countRules };

// --- Sorts -------------------------------------------------------------------------------

export function SortEditor({
  sorts,
  properties,
  onChange,
}: {
  sorts: Sort[];
  properties: Property[];
  onChange(sorts: Sort[]): void;
}) {
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const unused = properties.filter((p) => !sorts.some((s) => s.propertyId === p.id));
  const set = (i: number, sort: Sort) => onChange(sorts.map((s, j) => (j === i ? sort : s)));
  return (
    <div className="w-[360px] p-2" data-testid="sort-editor">
      <div className="flex flex-col gap-1">
        {sorts.map((sort, i) => (
          <div
            key={sort.propertyId}
            data-testid="sort-row"
            className={cn('flex items-center gap-1.5', dragging === i && 'opacity-50')}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', sort.propertyId);
              setDragging(i);
            }}
            onDragOver={(e) => dragging !== null && e.preventDefault()}
            onDrop={() => {
              if (dragging === null || dragging === i) return;
              const next = [...sorts];
              const [moved] = next.splice(dragging, 1);
              next.splice(i, 0, moved!);
              onChange(next);
              setDragging(null);
            }}
            onDragEnd={() => setDragging(null)}
          >
            <GripVertical size={14} className="cursor-grab text-faint" aria-hidden />
            <select
              aria-label="Sort property"
              value={sort.propertyId}
              onChange={(e) => set(i, { ...sort, propertyId: e.target.value })}
              className={cn(field, 'min-w-0 flex-1')}
            >
              {properties
                .filter(
                  (p) => p.id === sort.propertyId || !sorts.some((s) => s.propertyId === p.id),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
            <select
              aria-label="Sort direction"
              value={sort.direction}
              onChange={(e) => set(i, { ...sort, direction: e.target.value as Sort['direction'] })}
              className={field}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button
              type="button"
              aria-label="Remove sort"
              onClick={() => onChange(sorts.filter((_, j) => j !== i))}
              className="rounded p-1 text-muted hover:bg-hover"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {adding ? (
        <div className="mt-2 rounded border border-line">
          <PropertyPicker
            properties={unused}
            label="Sort by…"
            onPick={(p) => {
              onChange([...sorts, { propertyId: p.id, direction: 'asc' }]);
              setAdding(false);
            }}
          />
        </div>
      ) : (
        <div className="mt-2 flex gap-3 border-t border-line pt-2 text-sm">
          {unused.length > 0 && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="flex items-center gap-1 text-muted hover:text-fg"
            >
              <Plus size={14} /> Add sort
            </button>
          )}
          <span className="flex-1" />
          {sorts.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex items-center gap-1 text-muted hover:text-danger"
            >
              <Trash2 size={14} /> Delete sort
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// --- Grouping ----------------------------------------------------------------------------

function GroupOptions({
  property,
  groupBy,
  onChange,
}: {
  property: Property;
  groupBy: GroupBy;
  onChange(groupBy: GroupBy): void;
}) {
  const row = (label: string, input: ReactNode) => (
    <label className="flex h-8 items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      {input}
    </label>
  );
  const type = effectiveType(property);
  const isDate = ['date', 'createdTime', 'lastEditedTime'].includes(type);
  const isText = ['title', 'text', 'url', 'email', 'phone'].includes(type);
  const range = groupBy.numberRange ?? { start: 0, end: 100, step: 10 };
  return (
    <div className="flex flex-col">
      {isDate &&
        row(
          'Date by',
          <select
            aria-label="Date by"
            value={groupBy.dateBucket ?? 'relative'}
            onChange={(e) =>
              onChange({ ...groupBy, dateBucket: e.target.value as GroupBy['dateBucket'] })
            }
            className={field}
          >
            {DATE_BUCKETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>,
        )}
      {isText &&
        row(
          'Text by',
          <select
            aria-label="Text by"
            value={groupBy.textBucket ?? 'exact'}
            onChange={(e) =>
              onChange({ ...groupBy, textBucket: e.target.value as GroupBy['textBucket'] })
            }
            className={field}
          >
            <option value="exact">Exact</option>
            <option value="alphabetical">Alphabetical</option>
          </select>,
        )}
      {property.type === 'status' &&
        row(
          'Group by',
          <select
            aria-label="Status by"
            value={groupBy.statusBucket ?? 'option'}
            onChange={(e) =>
              onChange({ ...groupBy, statusBucket: e.target.value as GroupBy['statusBucket'] })
            }
            className={field}
          >
            <option value="option">Option</option>
            <option value="group">Group</option>
          </select>,
        )}
      {type === 'number' && (
        <div className="flex items-center gap-1 py-1 text-muted">
          <span className="flex-1">Range</span>
          {(['start', 'end', 'step'] as const).map((key) => (
            <input
              key={key}
              type="number"
              aria-label={`Range ${key}`}
              value={range[key]}
              onChange={(e) =>
                onChange({
                  ...groupBy,
                  numberRange: {
                    ...range,
                    [key]: Number(e.target.value) || (key === 'step' ? 1 : 0),
                  },
                })
              }
              className={cn(field, 'w-16')}
            />
          ))}
        </div>
      )}
      {row(
        'Sort',
        <select
          aria-label="Group order"
          value={groupBy.sort ?? 'asc'}
          onChange={(e) => onChange({ ...groupBy, sort: e.target.value as 'asc' | 'desc' })}
          className={field}
        >
          <option value="asc">Ascending</option>
          <option value="desc">Descending</option>
        </select>,
      )}
      {row(
        'Hide empty groups',
        <input
          type="checkbox"
          aria-label="Hide empty groups"
          checked={groupBy.hideEmpty ?? false}
          onChange={(e) => onChange({ ...groupBy, hideEmpty: e.target.checked })}
        />,
      )}
    </div>
  );
}

export function GroupEditor({
  properties,
  groupBy,
  subGroupBy,
  groups,
  onChange,
}: {
  properties: Property[];
  groupBy: GroupBy | null;
  subGroupBy: GroupBy | null;
  groups: ViewGroup[] | null;
  onChange(changes: { groupBy?: GroupBy | null; subGroupBy?: GroupBy | null }): void;
}) {
  const groupable = properties.filter((p) => GROUPABLE_TYPES.includes(p.type));
  const byId = new Map(properties.map((p) => [p.id, p]));
  const groupProperty = groupBy ? byId.get(groupBy.propertyId) : undefined;
  const subProperty = subGroupBy ? byId.get(subGroupBy.propertyId) : undefined;
  const hidden = (groups ?? []).filter((g) => g.hidden);

  const picker = (
    label: string,
    value: GroupBy | null,
    exclude: string | undefined,
    set: (g: GroupBy | null) => void,
  ) => (
    <label className="flex h-8 items-center justify-between gap-2">
      <span className="font-medium">{label}</span>
      <select
        aria-label={label}
        value={value?.propertyId ?? ''}
        onChange={(e) => set(e.target.value ? { propertyId: e.target.value } : null)}
        className={cn(field, 'max-w-44')}
      >
        <option value="">None</option>
        {groupable
          .filter((p) => p.id !== exclude)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
      </select>
    </label>
  );

  return (
    <div className="flex w-72 flex-col gap-1 p-2 text-sm" data-testid="group-editor">
      {picker('Group by', groupBy, undefined, (g) =>
        onChange(g ? { groupBy: g } : { groupBy: null, subGroupBy: null }),
      )}
      {groupBy && groupProperty && (
        <GroupOptions
          property={groupProperty}
          groupBy={groupBy}
          onChange={(g) => onChange({ groupBy: g })}
        />
      )}
      {groupBy && (
        <div className="mt-1 border-t border-line pt-1">
          {picker('Sub-group by', subGroupBy, groupBy.propertyId, (g) =>
            onChange({ subGroupBy: g }),
          )}
          {subGroupBy && subProperty && (
            <GroupOptions
              property={subProperty}
              groupBy={subGroupBy}
              onChange={(g) => onChange({ subGroupBy: g })}
            />
          )}
        </div>
      )}
      {groupBy && hidden.length > 0 && (
        <div className="mt-1 border-t border-line pt-1" data-testid="hidden-groups">
          <p className="py-1 text-xs text-muted">Hidden groups</p>
          {hidden.map((g) => (
            <div key={g.info.key} className="flex h-7 items-center justify-between">
              <span className="truncate">{g.info.label}</span>
              <button
                type="button"
                onClick={() =>
                  onChange({
                    groupBy: {
                      ...groupBy,
                      hidden: (groupBy.hidden ?? []).filter((k) => k !== g.info.key),
                    },
                  })
                }
                className="rounded px-1.5 text-xs text-accent hover:bg-hover"
              >
                Show
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
