import { ME, TODAY, newId } from '@workspace/core';
import {
  OPTION_COLORS,
  STATUS_GROUPS,
  addOption,
  cellText,
  cellValue,
  deleteOption,
  effectiveType,
  isDateValue,
  nextOptionColor,
  optionsOf,
  propertyKind,
  readRelation,
  isLiveRow,
  relationIds,
  reminderOptions,
  setCell,
  setRelation,
  addRow,
  updateOption,
  type DatabaseHandle,
  type DateValue,
  type DisplayContext,
  type FileValue,
  type OptionColor,
  type Property,
  type PropertyType,
  type Row,
  type SelectOption,
} from '@workspace/database';
import { Avatar, IconButton, Popover, PopoverAnchor, PopoverContent, cn } from '@workspace/ui';
import {
  AlignLeft,
  ArrowUpRight,
  AtSign,
  Calendar,
  Check,
  CircleChevronDown,
  CircleDot,
  Clock,
  Fingerprint,
  Hash,
  Sigma,
  Link,
  List,
  MoreHorizontal,
  Paperclip,
  Phone,
  SquareCheck,
  Trash2,
  Type,
  Upload,
  UserCircle,
  Users,
  X,
  Search,
  MousePointerClick,
  Plus,
  ArrowUpRight as RelationIcon,
  type LucideIcon,
} from 'lucide-react';
import { PageIcon } from '@workspace/editor';
import { useRef, useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { useNavigation } from '../navigation';
import { useCanEditProperties, useDatabase } from './hooks';
import { runButton } from '../buttons/run-button';

// --- Icons and pills -------------------------------------------------------------------

const ICONS: Record<PropertyType, LucideIcon> = {
  title: Type,
  text: AlignLeft,
  number: Hash,
  select: CircleChevronDown,
  multiSelect: List,
  status: CircleDot,
  date: Calendar,
  checkbox: SquareCheck,
  url: Link,
  email: AtSign,
  phone: Phone,
  files: Paperclip,
  person: Users,
  createdTime: Clock,
  createdBy: UserCircle,
  lastEditedTime: Clock,
  lastEditedBy: UserCircle,
  uniqueId: Fingerprint,
  formula: Sigma,
  relation: RelationIcon,
  rollup: Search,
  button: MousePointerClick,
};

export function PropertyIcon({ type, size = 14 }: { type: PropertyType; size?: number }) {
  const Icon = ICONS[type];
  return <Icon size={size} className="shrink-0 text-faint" aria-hidden />;
}

export function OptionPill({
  option,
  status,
  onRemove,
}: {
  option: SelectOption;
  status?: boolean;
  onRemove?(): void;
}) {
  return (
    <span
      className="ws-option"
      data-color={option.color}
      data-status={status || undefined}
      data-testid="option"
    >
      <span className="truncate">{option.name || 'Untitled'}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${option.name}`}
          className="-mr-0.5 ml-0.5 opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={12} />
        </button>
      )}
    </span>
  );
}

const linkHref = (type: PropertyType, value: string) =>
  type === 'email'
    ? `mailto:${value}`
    : type === 'phone'
      ? `tel:${value.replace(/[^\d+]/g, '')}`
      : /^[a-z][a-z\d+.-]*:/i.test(value)
        ? value
        : `https://${value}`;

// --- Display ---------------------------------------------------------------------------

export interface CellDisplayProps {
  row: Row;
  property: Property;
  ctx: DisplayContext;
  wrap?: boolean;
  /** Toggle a checkbox (checkboxes change on click, without an editor). */
  onToggle?(): void;
  /** Table cells right-align numbers; the row page's property list doesn't. */
  variant?: 'cell' | 'panel';
}

/** A property value as shown in a table cell or the row page's property list. */
export function CellDisplay({
  row,
  property,
  ctx,
  wrap,
  onToggle,
  variant = 'cell',
}: CellDisplayProps) {
  const { platform } = useApp();
  const value = cellValue(row, property);
  const kind = propertyKind(property.type);
  const lines = wrap ? 'whitespace-pre-wrap break-words' : 'truncate';

  if (property.type === 'button') return <ButtonCell row={row} property={property} />;

  if (property.type === 'formula' || property.type === 'rollup') {
    // A computed value, shown as its result type (and not editable).
    const type = effectiveType(property);
    if (type === 'checkbox') {
      return (
        <span
          role="checkbox"
          aria-checked={value === true}
          aria-readonly
          aria-label={property.name}
          className={cn(
            'flex size-4 items-center justify-center rounded-[3px] border opacity-80',
            value === true ? 'border-accent bg-accent text-accent-fg' : 'border-faint',
          )}
        >
          {value === true && <Check size={12} strokeWidth={3} />}
        </span>
      );
    }
    if (kind.isEmpty(value)) return null;
    return (
      <span
        data-testid="formula-value"
        className={cn(lines, type === 'number' && variant === 'cell' && 'ml-auto tabular-nums')}
      >
        {cellText(row, property, ctx)}
      </span>
    );
  }

  if (property.type === 'checkbox') {
    const on = value === true;
    return (
      <button
        type="button"
        role="checkbox"
        aria-checked={on}
        aria-label={property.name}
        onClick={(e) => {
          e.stopPropagation();
          onToggle?.();
        }}
        className={cn(
          'flex size-4 items-center justify-center rounded-[3px] border',
          on ? 'border-accent bg-accent text-accent-fg' : 'border-faint',
        )}
      >
        {on && <Check size={12} strokeWidth={3} />}
      </button>
    );
  }
  if (kind.isEmpty(value)) return null;

  switch (property.type) {
    case 'select':
    case 'status': {
      const option = optionsOf(property).find((o) => o.id === value);
      return option ? <OptionPill option={option} status={property.type === 'status'} /> : null;
    }
    case 'multiSelect': {
      const options = (value as string[])
        .map((id) => optionsOf(property).find((o) => o.id === id))
        .filter((o): o is SelectOption => o !== undefined);
      return (
        <span className={cn('flex min-w-0 gap-1.5', wrap ? 'flex-wrap' : 'overflow-hidden')}>
          {options.map((o) => (
            <OptionPill key={o.id} option={o} />
          ))}
        </span>
      );
    }
    case 'person':
      return (
        <span className={cn('flex min-w-0 gap-2', wrap ? 'flex-wrap' : 'overflow-hidden')}>
          {(value as string[]).map((id) => (
            <span key={id} className="flex min-w-0 items-center gap-1.5">
              <Avatar
                name={id === ME ? 'Me' : (ctx.users.get(id) ?? '?')}
                src={ctx.avatars?.get(id)}
                id={id}
              />
              <span className="truncate">
                {id === ME ? 'Me (when used)' : (ctx.users.get(id) ?? 'Unknown')}
              </span>
            </span>
          ))}
        </span>
      );
    case 'createdBy':
    case 'lastEditedBy': {
      const name = ctx.users.get(value as string) ?? 'Unknown';
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar name={name} src={ctx.avatars?.get(value as string)} id={value as string} />
          <span className="truncate">{name}</span>
        </span>
      );
    }
    case 'relation':
      return <RelationPages ids={relationIds(value)} property={property} ctx={ctx} wrap={wrap} />;
    case 'files':
      return (
        <span className={cn('flex min-w-0 gap-1.5', wrap ? 'flex-wrap' : 'overflow-hidden')}>
          {(value as FileValue[]).map((file, i) => (
            <button
              key={`${file.id ?? file.url}-${i}`}
              type="button"
              title={`Open ${file.name}`}
              onClick={(e) => {
                e.stopPropagation();
                if (file.id) platform.openFile(file.id);
                else if (file.url) window.open(file.url, '_blank', 'noopener');
              }}
              className="flex max-w-40 shrink-0 items-center gap-1 rounded bg-hover px-1.5 text-sm hover:bg-active"
            >
              {file.id && file.mime?.startsWith('image/') ? (
                <img
                  src={platform.fileUrl(file.id)}
                  alt=""
                  className="size-4 rounded-sm object-cover"
                />
              ) : (
                <Paperclip size={12} className="shrink-0 text-muted" />
              )}
              <span className="truncate">{file.name}</span>
            </button>
          ))}
        </span>
      );
    case 'url':
    case 'email':
    case 'phone': {
      const text = String(value);
      return (
        <span className="group/link flex min-w-0 items-center gap-1">
          <span className={cn('min-w-0 underline decoration-faint underline-offset-2', lines)}>
            {text}
          </span>
          <IconButton
            label={`Open ${text}`}
            size="sm"
            className="invisible shrink-0 group-hover/link:visible"
            onClick={(e) => {
              e.stopPropagation();
              window.open(linkHref(property.type, text), '_blank', 'noopener');
            }}
          >
            <ArrowUpRight size={12} />
          </IconButton>
        </span>
      );
    }
    case 'number':
      return (
        <span className={cn('truncate tabular-nums', variant === 'cell' && 'ml-auto')}>
          {cellText(row, property, ctx)}
        </span>
      );
    case 'createdTime':
    case 'lastEditedTime':
    case 'uniqueId':
      return <span className={cn('text-muted', lines)}>{cellText(row, property, ctx)}</span>;
    default:
      return <span className={lines}>{cellText(row, property, ctx)}</span>;
  }
}

// --- Editing ---------------------------------------------------------------------------

/** Where to go after an edit, from the keyboard (tables move the selection). */
export type EditExit = 'down' | 'right' | 'left' | null;

/** Types edited as text in place; the rest use a popover. */
export const TEXT_TYPES: readonly PropertyType[] = [
  'title',
  'text',
  'number',
  'url',
  'email',
  'phone',
];
export const POPOVER_TYPES: readonly PropertyType[] = [
  'select',
  'multiSelect',
  'status',
  'date',
  'person',
  'files',
  'relation',
];

export const isEditable = (type: PropertyType) =>
  TEXT_TYPES.includes(type) || POPOVER_TYPES.includes(type);

export interface CellEditorProps {
  handle: DatabaseHandle;
  row: Row;
  property: Property;
  ctx: DisplayContext;
  /** Text typed to start editing (replaces the value), if any. */
  initialText?: string;
  onDone(exit: EditExit): void;
}

/** In-place text input for title, text, number, URL, email and phone. */
export function TextCellEditor({
  handle,
  row,
  property,
  ctx,
  initialText,
  onDone,
  className,
}: CellEditorProps & { className?: string }) {
  const { user } = useApp();
  const [text, setText] = useState(() => initialText ?? cellText(row, property, ctx));
  const done = useRef(false);
  const multiline = property.type === 'text';

  const commit = (exit: EditExit) => {
    if (done.current) return;
    done.current = true;
    const kind = propertyKind(property.type);
    const value =
      property.type === 'title' || multiline ? text : kind.parse(text, property, ctx).value;
    if (value !== cellValue(row, property)) {
      setCell(handle.doc, row.id, property.id, value, user.id);
    }
    onDone(exit);
  };

  return (
    <textarea
      autoFocus
      rows={1}
      value={text}
      aria-label={property.name}
      data-testid="cell-editor"
      onFocus={(e) => {
        const end = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(end, end);
      }}
      onChange={(e) => setText(multiline ? e.target.value : e.target.value.replace(/\n/g, ''))}
      onBlur={() => commit(null)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !(multiline && e.shiftKey) && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit('down');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          commit(null);
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(e.shiftKey ? 'left' : 'right');
        }
      }}
      className={cn(
        'w-full resize-none bg-menu px-2 py-1.5 text-sm leading-5 text-fg outline-none [field-sizing:content]',
        property.type === 'number' && 'text-right tabular-nums',
        className,
      )}
    />
  );
}

/** Popover editor for select-like, date, person and files properties. */
export function PopoverCellEditor({ anchor, ...props }: CellEditorProps & { anchor: ReactNode }) {
  return (
    <Popover open onOpenChange={(open) => !open && props.onDone(null)}>
      <PopoverAnchor asChild>{anchor}</PopoverAnchor>
      <PopoverContent
        className="w-[300px]"
        data-testid="cell-popover"
        onKeyDown={(e) => e.stopPropagation()}
        // Clicks bubble through the portal to the cell, which would take focus back.
        onClick={(e) => e.stopPropagation()}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <PopoverBody {...props} />
      </PopoverContent>
    </Popover>
  );
}

function PopoverBody(props: CellEditorProps) {
  switch (props.property.type) {
    case 'select':
    case 'multiSelect':
    case 'status':
      return <OptionsEditor {...props} />;
    case 'date':
      return <DateEditor {...props} />;
    case 'person':
      return <PersonEditor {...props} />;
    case 'files':
      return <FilesEditor {...props} />;
    case 'relation':
      return <RelationEditor {...props} />;
    default:
      return null;
  }
}

// --- Options ---------------------------------------------------------------------------

function OptionsEditor({ handle, row, property, initialText, onDone }: CellEditorProps) {
  const { user } = useApp();
  // New options and option settings change the property, not just the row.
  const canEditOptions = useCanEditProperties(handle);
  const multi = property.type === 'multiSelect';
  const status = property.type === 'status';
  const [query, setQuery] = useState(initialText ?? '');
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const options = optionsOf(property);
  const value = cellValue(row, property);
  const selected: string[] = multi
    ? ((value as string[] | null) ?? [])
    : value
      ? [value as string]
      : [];

  const q = query.trim().toLowerCase();
  const matches = options.filter((o) => o.name.toLowerCase().includes(q));
  const exact = options.some((o) => o.name.toLowerCase() === q);
  const items: ({ kind: 'option'; option: SelectOption } | { kind: 'create' })[] = [
    ...matches.map((option) => ({ kind: 'option' as const, option })),
    ...(q && !exact && canEditOptions ? [{ kind: 'create' as const }] : []),
  ];
  const index = Math.min(active, Math.max(items.length - 1, 0));

  const write = (ids: string[]) =>
    setCell(
      handle.doc,
      row.id,
      property.id,
      multi ? (ids.length ? ids : null) : (ids[0] ?? null),
      user.id,
    );

  const choose = (id: string) => {
    if (multi) {
      write(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
      setQuery('');
    } else {
      write(selected[0] === id ? [] : [id]);
      onDone(null);
    }
  };

  const create = () => {
    const option: SelectOption = {
      id: newId(),
      name: query.trim(),
      color: nextOptionColor(options),
    };
    if (status) option.group = 'todo';
    handle.doc.transact(() => {
      addOption(handle.doc, property.id, option);
      choose(option.id);
    });
    setQuery('');
  };

  const pick = (i: number) => {
    const item = items[i];
    if (!item) return;
    if (item.kind === 'create') create();
    else choose(item.option.id);
  };

  const renderOption = (option: SelectOption) => {
    const i = items.findIndex((it) => it.kind === 'option' && it.option.id === option.id);
    return (
      <div
        key={option.id}
        role="option"
        aria-selected={i === index}
        data-testid="option-choice"
        onMouseMove={() => i !== index && setActive(i)}
        onClick={() => choose(option.id)}
        className={cn(
          'group flex h-8 cursor-pointer items-center gap-2 rounded px-2',
          i === index && 'bg-hover',
        )}
      >
        <span className="min-w-0 flex-1">
          <OptionPill option={option} status={status} />
        </span>
        {selected.includes(option.id) && <Check size={14} className="text-muted" />}
        {canEditOptions && (
          <IconButton
            label={`Edit ${option.name}`}
            size="sm"
            className="invisible group-hover:visible"
            onClick={(e) => {
              e.stopPropagation();
              setEditing(option.id);
            }}
          >
            <MoreHorizontal size={14} />
          </IconButton>
        )}
      </div>
    );
  };

  const editingOption = canEditOptions ? options.find((o) => o.id === editing) : undefined;
  if (editingOption) {
    return (
      <OptionSettings
        option={editingOption}
        onChange={(changes) => updateOption(handle.doc, property.id, editingOption.id, changes)}
        onDelete={() => {
          deleteOption(handle.doc, property.id, editingOption.id);
          setEditing(null);
        }}
        onBack={() => setEditing(null)}
      />
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 border-b border-line bg-hover/50 px-2 py-1.5">
        {selected.map((id) => {
          const option = options.find((o) => o.id === id);
          return option ? (
            <OptionPill
              key={id}
              option={option}
              status={status}
              onRemove={() => write(selected.filter((s) => s !== id))}
            />
          ) : null;
        })}
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setActive(Math.min(index + 1, items.length - 1));
            else if (e.key === 'ArrowUp') setActive(Math.max(index - 1, 0));
            else if (e.key === 'Enter') pick(index);
            else if (e.key === 'Escape') onDone(null);
            else if (e.key === 'Backspace' && !query && selected.length) {
              write(selected.slice(0, -1));
            } else return;
            e.preventDefault();
          }}
          placeholder={selected.length ? '' : 'Search for an option…'}
          aria-label="Search for an option"
          className="h-6 min-w-20 flex-1 bg-transparent outline-none"
        />
      </div>
      <div role="listbox" aria-label="Options" className="max-h-72 overflow-y-auto p-1">
        <p className="px-2 py-1 text-xs text-muted">
          {!canEditOptions
            ? options.length
              ? 'Select an option'
              : 'No options yet'
            : options.length
              ? 'Select an option or create one'
              : 'Type to create an option'}
        </p>
        {status
          ? STATUS_GROUPS.map((group) => {
              const inGroup = matches.filter((o) => (o.group ?? 'todo') === group.id);
              return inGroup.length ? (
                <div key={group.id}>
                  <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-faint">{group.label}</p>
                  {inGroup.map(renderOption)}
                </div>
              ) : null;
            })
          : matches.map(renderOption)}
        {q && !exact && canEditOptions && (
          <div
            role="option"
            aria-selected={index === items.length - 1}
            onMouseMove={() => setActive(items.length - 1)}
            onClick={create}
            className={cn(
              'flex h-8 cursor-pointer items-center gap-2 rounded px-2',
              index === items.length - 1 && 'bg-hover',
            )}
          >
            <span className="text-muted">Create</span>
            <OptionPill
              option={{ id: 'new', name: query.trim(), color: nextOptionColor(options) }}
              status={status}
            />
          </div>
        )}
      </div>
    </div>
  );
}

const COLOR_LABEL = (c: OptionColor) => c.charAt(0).toUpperCase() + c.slice(1);

function OptionSettings({
  option,
  onChange,
  onDelete,
  onBack,
}: {
  option: SelectOption;
  onChange(changes: Partial<SelectOption>): void;
  onDelete(): void;
  onBack(): void;
}) {
  const [name, setName] = useState(option.name);
  return (
    <div className="p-1" data-testid="option-settings">
      <input
        autoFocus
        value={name}
        aria-label="Option name"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== option.name && onChange({ name: name.trim() })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            e.preventDefault();
            if (name.trim() && name !== option.name) onChange({ name: name.trim() });
            onBack();
          }
        }}
        className="m-1 h-7 w-[calc(100%-8px)] rounded border border-line bg-surface px-2 outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={onDelete}
        className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover"
      >
        <Trash2 size={14} /> Delete
      </button>
      <p className="px-2 pt-2 pb-1 text-xs text-muted">Colors</p>
      {OPTION_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange({ color })}
          className="flex h-7 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover"
        >
          <span className="ws-option size-4 p-0" data-color={color} />
          <span className="flex-1">{COLOR_LABEL(color)}</span>
          {option.color === color && <Check size={14} className="text-muted" />}
        </button>
      ))}
      <button
        type="button"
        onClick={onBack}
        className="mt-1 h-8 w-full rounded px-2 text-left text-muted hover:bg-hover"
      >
        ← Back
      </button>
    </div>
  );
}

// --- Date ------------------------------------------------------------------------------

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange(on: boolean): void;
}) {
  return (
    <label className="flex h-8 cursor-pointer items-center justify-between rounded px-2 hover:bg-hover">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--ws-accent)]"
      />
    </label>
  );
}

function DateEditor({ handle, row, property }: CellEditorProps) {
  const { user } = useApp();
  const stored = cellValue(row, property);
  const value: DateValue | null = isDateValue(stored) ? stored : null;
  const withTime = value?.start.includes('T') ?? false;
  const today = new Date().toISOString().slice(0, 10);

  const write = (next: DateValue | null) => setCell(handle.doc, row.id, property.id, next, user.id);
  const setTime = (on: boolean) => {
    if (!value) return;
    const convert = (s: string) => (on ? (s.includes('T') ? s : `${s}T09:00`) : s.slice(0, 10));
    write({ start: convert(value.start), ...(value.end ? { end: convert(value.end) } : {}) });
  };
  const input = (part: 'start' | 'end') => (
    <input
      type={withTime ? 'datetime-local' : 'date'}
      aria-label={part === 'start' ? 'Start date' : 'End date'}
      value={(part === 'start' ? value?.start : value?.end) ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        if (part === 'start') write({ ...value, start: v });
        else if (value) write({ ...value, end: v });
      }}
      className="h-8 w-full rounded border border-line bg-surface px-2 outline-none focus:border-accent"
    />
  );

  const relative = (stored as DateValue | null)?.start === TODAY;
  return (
    <div className="flex flex-col gap-1 p-2" data-testid="date-editor">
      {row.isTemplate && (
        <button
          type="button"
          aria-pressed={relative}
          onClick={() => write(relative ? null : { start: TODAY })}
          className="flex h-8 items-center justify-between rounded px-2 text-left hover:bg-hover"
        >
          Today (when used){relative && <Check size={14} className="text-muted" />}
        </button>
      )}
      {input('start')}
      {value?.end !== undefined && value.end !== null && input('end')}
      <div className="mt-1 border-t border-line pt-1">
        <Toggle
          label="End date"
          on={Boolean(value?.end)}
          onChange={(on) => {
            const start = value?.start ?? today;
            const reminder = value?.reminder ? { reminder: value.reminder } : {};
            write(on ? { start, end: start, ...reminder } : { start, ...reminder });
          }}
        />
        <Toggle label="Include time" on={withTime} onChange={setTime} />
        {value && (
          <label className="flex h-8 items-center justify-between gap-2 rounded px-2 hover:bg-hover">
            <span>Remind</span>
            <select
              aria-label="Remind"
              value={value.reminder ?? ''}
              onChange={(e) =>
                write({ ...value, reminder: (e.target.value || null) as DateValue['reminder'] })
              }
              className="h-7 max-w-40 rounded border border-line bg-surface px-1 text-sm outline-none"
            >
              <option value="">None</option>
              {reminderOptions(withTime).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={() => write(null)}
          className="flex h-8 w-full items-center rounded px-2 text-left text-muted hover:bg-hover"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// --- Person ----------------------------------------------------------------------------

/** People a picker offers, as [id, name], by name. */
export function pickablePeople(ctx: DisplayContext): [string, string][] {
  const ids = ctx.people ?? [...ctx.users.keys()];
  return ids
    .map((id): [string, string] => [id, ctx.users.get(id) ?? 'Unknown'])
    .sort((a, b) => a[1].localeCompare(b[1]));
}

function PersonEditor({ handle, row, property, ctx }: CellEditorProps) {
  const { user } = useApp();
  const [query, setQuery] = useState('');
  const selected = (cellValue(row, property) as string[] | null) ?? [];
  const people = [
    // Templates can pick whoever uses them.
    ...(row.isTemplate ? ([[ME, 'Me (when used)']] as [string, string][]) : []),
    ...pickablePeople(ctx).filter(([, name]) =>
      name.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  ];
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id];
    setCell(handle.doc, row.id, property.id, next.length ? next : null, user.id);
  };
  return (
    <div>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search for a person…"
        aria-label="Search for a person"
        className="h-9 w-full border-b border-line bg-transparent px-3 outline-none"
      />
      <div className="p-1">
        {people.map(([id, name]) => (
          <button
            key={id}
            type="button"
            onClick={() => toggle(id)}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover"
          >
            <Avatar name={name} src={ctx.avatars?.get(id)} id={id} />
            <span className="flex-1 truncate">{name}</span>
            {selected.includes(id) && <Check size={14} className="text-muted" />}
          </button>
        ))}
        {people.length === 0 && <p className="px-2 py-1.5 text-muted">No people found</p>}
      </div>
    </div>
  );
}

// --- Files -----------------------------------------------------------------------------

function FilesEditor({ handle, row, property }: CellEditorProps) {
  const { user, platform } = useApp();
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const files = (cellValue(row, property) as FileValue[] | null) ?? [];
  const write = (next: FileValue[]) =>
    setCell(handle.doc, row.id, property.id, next.length ? next : null, user.id);

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const added: FileValue[] = [];
      for (const file of Array.from(list)) {
        const ref = await platform.importFile(file);
        added.push({ id: ref.id, name: ref.name, mime: ref.mime });
      }
      // Re-read: the row may have changed while uploading.
      const current = (cellValue(handle.row(row.id) ?? row, property) as FileValue[] | null) ?? [];
      write([...current, ...added]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-1" data-testid="files-editor">
      {files.map((file, i) => (
        <div
          key={`${file.id ?? file.url}-${i}`}
          className="flex h-8 items-center gap-2 rounded px-2 hover:bg-hover"
        >
          <Paperclip size={14} className="shrink-0 text-muted" />
          <span className="flex-1 truncate">{file.name}</span>
          <IconButton
            label={`Remove ${file.name}`}
            size="sm"
            onClick={() => write(files.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
      <label className="flex h-8 cursor-pointer items-center gap-2 rounded px-2 hover:bg-hover">
        <Upload size={14} className="text-muted" />
        {busy ? 'Uploading…' : 'Upload a file'}
        <input
          type="file"
          multiple
          aria-label="Upload a file"
          className="sr-only"
          onChange={(e) => void upload(e.target.files)}
        />
      </label>
      <form
        className="flex gap-1 border-t border-line p-1 pt-2"
        onSubmit={(e) => {
          e.preventDefault();
          const url = link.trim();
          if (!/^https?:\/\/\S+$/.test(url)) return;
          const name =
            url
              .replace(/[?#].*$/, '')
              .split('/')
              .pop() || url;
          write([...files, { url, name }]);
          setLink('');
        }}
      >
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="Paste a link…"
          aria-label="Paste a link"
          className="h-7 flex-1 rounded border border-line bg-surface px-2 outline-none focus:border-accent"
        />
        <button type="submit" className="rounded bg-accent px-2 text-sm text-accent-fg">
          Add
        </button>
      </form>
    </div>
  );
}

// --- Relations -------------------------------------------------------------------------

/** Linked pages as chips (icon and underlined title); a chip opens its page. */
function RelationPages({
  ids,
  property,
  ctx,
  wrap,
}: {
  ids: string[];
  property: Property;
  ctx: DisplayContext;
  wrap?: boolean;
}) {
  const { platform } = useApp();
  const { openRow } = useNavigation();
  return (
    <span className={cn('flex min-w-0 gap-2', wrap ? 'flex-wrap' : 'overflow-hidden')}>
      {ids.map((id) => {
        const page = ctx.pages?.get(id);
        return (
          <button
            key={id}
            type="button"
            data-testid="relation-page"
            onClick={(e) => {
              e.stopPropagation();
              openRow(id, page?.databaseId ?? property.config.databaseId ?? '', 'sidePeek');
            }}
            className="flex max-w-60 shrink-0 items-center gap-1 rounded px-0.5 hover:bg-hover"
          >
            <PageIcon
              icon={page?.icon ?? null}
              size={14}
              fileUrl={platform.fileUrl}
              className="shrink-0 text-muted"
            />
            <span className="truncate underline decoration-faint underline-offset-2">
              {page?.title || 'Untitled'}
            </span>
          </button>
        );
      })}
    </span>
  );
}

/** Pick the pages a row links to: search the related database, add, remove, create. */
function RelationEditor({ handle, row, property }: CellEditorProps) {
  const { databases, user, platform } = useApp();
  const targetId = property.config.databaseId ?? '';
  const target = useDatabase(targetId);
  const [query, setQuery] = useState('');
  if (!databases.exists(targetId)) {
    return <p className="px-3 py-2 text-muted">The related database no longer exists.</p>;
  }
  if (!target) return <div className="h-16" aria-busy="true" />;
  const live = new Map(target.snapshot.rows.filter(isLiveRow).map((r) => [r.id, r]));
  const linked = readRelation(handle.doc, row.id, property.id).filter((id) => live.has(id));
  const q = query.trim().toLowerCase();
  const candidates = [...live.values()].filter(
    (r) =>
      !linked.includes(r.id) &&
      // A page doesn't link to itself.
      r.id !== row.id &&
      (r.title || 'Untitled').toLowerCase().includes(q),
  );
  const write = (ids: string[]) =>
    setRelation(databases.resolveDoc, handle.id, row.id, property.id, ids, user.id);
  const add = (id: string) => {
    write(property.config.limitOne ? [id] : [...linked, id]);
    setQuery('');
  };
  const create = () => {
    const id = addRow(target.handle.doc, { actor: user.id, title: query.trim() });
    add(id);
  };
  const exact = [...live.values()].some((r) => r.title.toLowerCase() === q);
  const pageRow = (r: Row, action: ReactNode, onClick?: () => void) => (
    <div
      key={r.id}
      role={onClick ? 'option' : undefined}
      aria-selected={onClick ? false : undefined}
      onClick={onClick}
      // Keep focus in the search box (the list changes under the pointer).
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'group/page flex h-8 items-center gap-2 rounded px-2',
        onClick && 'cursor-pointer hover:bg-hover',
      )}
    >
      <PageIcon icon={r.icon} size={16} fileUrl={platform.fileUrl} className="text-muted" />
      <span className="flex-1 truncate">{r.title || 'Untitled'}</span>
      {action}
    </div>
  );
  return (
    <div data-testid="relation-editor">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q) {
            e.preventDefault();
            if (candidates[0]) add(candidates[0].id);
            else if (!exact) create();
          }
        }}
        placeholder="Search for a page…"
        aria-label="Search pages"
        className="h-9 w-full border-b border-line bg-transparent px-3 outline-none"
      />
      <div className="max-h-80 overflow-y-auto p-1">
        {linked.length > 0 && (
          <>
            <p className="px-2 py-1 text-xs text-muted">
              {property.config.limitOne ? 'Linked page' : `${linked.length} linked`}
            </p>
            {linked.map((id) =>
              pageRow(
                live.get(id)!,
                <IconButton
                  label={`Remove ${live.get(id)!.title || 'Untitled'}`}
                  size="sm"
                  onClick={() => write(linked.filter((l) => l !== id))}
                >
                  <X size={12} />
                </IconButton>,
              ),
            )}
          </>
        )}
        <p className="px-2 py-1 text-xs text-muted">
          {property.config.limitOne && linked.length ? 'Replace with' : 'Link another page'}
        </p>
        <div role="listbox" aria-label="Pages">
          {candidates.slice(0, 50).map((r) => pageRow(r, null, () => add(r.id)))}
        </div>
        {q && !exact && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={create}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-left hover:bg-hover"
          >
            <Plus size={14} className="text-muted" /> New page “{query.trim()}”
          </button>
        )}
        {!q && candidates.length === 0 && (
          <p className="px-2 py-1.5 text-muted">No more pages to link</p>
        )}
      </div>
    </div>
  );
}

// --- Buttons ---------------------------------------------------------------------------

/** A database button property: runs its steps for this row. */
function ButtonCell({ row, property }: { row: Row; property: Property }) {
  const app = useApp();
  const { navigate, openRow } = useNavigation();
  const [running, setRunning] = useState(false);
  const config = property.config.button ?? { label: '', color: 'default', steps: [] };
  const databaseId = app.databases.databaseOf(row.id)?.id;
  return (
    <button
      type="button"
      disabled={running || !databaseId}
      data-color={config.color}
      data-testid="button-cell"
      onClick={(e) => {
        e.stopPropagation();
        if (!databaseId) return;
        setRunning(true);
        void runButton(config, {
          app,
          navigate,
          openRow: (rowId, db) => openRow(rowId, db, 'sidePeek'),
          row: { databaseId, rowId: row.id },
        }).finally(() => setRunning(false));
      }}
      className="ws-button inline-flex h-6 max-w-full items-center truncate rounded border border-line px-2 text-xs font-medium hover:bg-hover disabled:opacity-60"
    >
      {config.label || property.name}
    </button>
  );
}
