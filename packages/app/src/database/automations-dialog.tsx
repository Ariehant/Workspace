/**
 * A database's automations (Phase 6 M3): the list (on and off), an editor for one (its
 * trigger and its actions), and its recent runs. They're stored in the database doc;
 * the server runs them, so they're offered in a workspace on a server.
 */
import { newId } from '@workspace/core';
import {
  AUTOMATIONS_MAP,
  deleteAutomation,
  optionsOf,
  propertyKind,
  readAutomations,
  setAutomation,
  type ActionValue,
  type Automation,
  type AutomationAction,
  type AutomationTrigger,
  type DatabaseHandle,
  type Property,
  type Schedule,
} from '@workspace/database';
import { Button, Dialog, DialogContent, IconButton, cn } from '@workspace/ui';
import { Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useApp } from '../context';
import type { TeamApi } from '../team';
import { useDisplayContext } from './hooks';

const field =
  'rounded-md border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-accent';
const COMPUTED = new Set([
  'formula',
  'rollup',
  'createdTime',
  'createdBy',
  'lastEditedTime',
  'lastEditedBy',
  'uniqueId',
  'button',
]);

/** The database's automations, following changes. */
function useAutomations(handle: DatabaseHandle): Automation[] {
  const map = handle.doc.getMap(AUTOMATIONS_MAP);
  const subscribe = useCallback(
    (listener: () => void) => {
      map.observe(listener);
      return () => map.unobserve(listener);
    },
    [map],
  );
  const key = useSyncExternalStore(subscribe, () => JSON.stringify(map.toJSON()));
  return useMemo(() => (key ? readAutomations(handle.doc) : []), [handle, key]);
}

/** What starts it, in words. */
export function triggerText(trigger: AutomationTrigger, properties: readonly Property[]): string {
  if (trigger.kind === 'pageAdded') return 'When a page is added';
  if (trigger.kind === 'propertyEdited') {
    const p = properties.find((x) => x.id === trigger.propertyId);
    const name = p?.name ?? 'a property';
    if (trigger.to === undefined) return `When ${name} is edited`;
    const option = p ? optionsOf(p).find((o) => o.id === trigger.to) : undefined;
    return `When ${name} is set to ${option?.name ?? String(trigger.to)}`;
  }
  const s = trigger.schedule;
  const day =
    s.every === 'week'
      ? ` on ${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][s.weekday ?? 1]}`
      : s.every === 'month'
        ? ` on day ${s.monthDay ?? 1}`
        : '';
  return `Every ${s.every}${day} at ${s.time}`;
}

export function AutomationsDialog({
  handle,
  properties,
  team,
  onClose,
}: {
  handle: DatabaseHandle;
  properties: readonly Property[];
  team: TeamApi | null;
  onClose(): void;
}) {
  const { user } = useApp();
  const automations = useAutomations(handle);
  const [editing, setEditing] = useState<Automation | null>(null);

  const blank = (): Automation => ({
    id: newId(),
    name: 'New automation',
    enabled: true,
    trigger: { kind: 'pageAdded' },
    condition: null,
    actions: [],
    createdBy: user.id,
    createdAt: Date.now(),
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Automations"
        className="w-[min(640px,calc(100vw-32px))]"
        data-testid="automations-dialog"
      >
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4 pt-2 text-sm">
          {editing ? (
            <AutomationEditor
              key={editing.id}
              initial={editing}
              properties={properties}
              team={team}
              databaseId={handle.id}
              onSave={(a) => {
                setAutomation(handle.doc, a);
                setEditing(null);
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <>
              {automations.length === 0 && (
                <p className="text-muted">
                  Automations do things when pages change, or on a schedule: set properties, add
                  pages, notify people, call a webhook.
                </p>
              )}
              {automations.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center gap-2 rounded-md border border-line p-2"
                  data-testid="automation-row"
                >
                  <label className="flex items-center" title={a.enabled ? 'On' : 'Off'}>
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      aria-label={`${a.name} is on`}
                      onChange={(e) =>
                        setAutomation(handle.doc, { ...a, enabled: e.target.checked })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => setEditing(a)}
                  >
                    <div className="truncate font-medium">{a.name}</div>
                    <div className="truncate text-xs text-muted">
                      {triggerText(a.trigger, properties)} · {a.actions.length} action
                      {a.actions.length === 1 ? '' : 's'}
                    </div>
                  </button>
                  <IconButton
                    label={`Delete ${a.name}`}
                    size="sm"
                    onClick={() => deleteAutomation(handle.doc, a.id)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button variant="primary" onClick={() => setEditing(blank())}>
                  <Plus size={14} /> New automation
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- One automation ------------------------------------------------------------------

function AutomationEditor({
  initial,
  properties,
  team,
  databaseId,
  onSave,
  onCancel,
}: {
  initial: Automation;
  properties: readonly Property[];
  team: TeamApi | null;
  databaseId: string;
  onSave(a: Automation): void;
  onCancel(): void;
}) {
  const [a, setA] = useState<Automation>(initial);
  const set = (changes: Partial<Automation>) => setA((x) => ({ ...x, ...changes }));
  const writable = properties.filter((p) => !COMPUTED.has(p.type));
  const people = useDisplayContext();
  const personIds = people.people ?? [...people.users.keys()];
  const scheduled = a.trigger.kind === 'schedule';

  const setTrigger = (kind: AutomationTrigger['kind']) => {
    if (kind === 'pageAdded') set({ trigger: { kind } });
    else if (kind === 'propertyEdited') {
      set({ trigger: { kind, propertyId: properties[0]?.id ?? '' } });
    } else {
      const schedule: Schedule = {
        every: 'day',
        time: '09:00',
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      };
      set({ trigger: { kind, schedule } });
    }
  };
  const setAction = (i: number, action: AutomationAction) =>
    set({ actions: a.actions.map((x, j) => (j === i ? action : x)) });
  const addAction = (kind: AutomationAction['kind']) => {
    const action: AutomationAction =
      kind === 'setProperties'
        ? { kind, values: {} }
        : kind === 'addPage'
          ? { kind, title: 'New page', values: {} }
          : kind === 'notify'
            ? { kind, people: [], peopleProperty: null, message: '' }
            : { kind, url: 'https://', headers: {} };
    set({ actions: [...a.actions, action] });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="automation-editor">
      <input
        aria-label="Automation name"
        value={a.name}
        onChange={(e) => set({ name: e.target.value })}
        className="bg-transparent text-lg font-semibold outline-none"
      />

      <section className="flex flex-col gap-2 rounded-md bg-hover/50 p-2">
        <span className="text-xs font-medium text-muted">Trigger</span>
        <select
          aria-label="Trigger"
          value={a.trigger.kind}
          onChange={(e) => setTrigger(e.target.value as AutomationTrigger['kind'])}
          className={field}
        >
          <option value="pageAdded">When a page is added</option>
          <option value="propertyEdited">When a property is edited</option>
          <option value="schedule">On a schedule</option>
        </select>
        {a.trigger.kind === 'propertyEdited' && (
          <PropertyTrigger
            trigger={a.trigger}
            properties={properties}
            onChange={(trigger) => set({ trigger })}
          />
        )}
        {a.trigger.kind === 'schedule' && (
          <ScheduleEditor
            schedule={a.trigger.schedule}
            onChange={(schedule) => set({ trigger: { kind: 'schedule', schedule } })}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted">Do</span>
        {a.actions.map((action, i) => (
          <div
            key={i}
            className="flex gap-2 rounded-md border border-line p-2"
            data-testid="automation-action"
          >
            <div className="min-w-0 flex-1">
              <ActionEditor
                action={action}
                properties={writable}
                personIds={personIds}
                names={people.users}
                scheduled={scheduled}
                onChange={(next) => setAction(i, next)}
              />
            </div>
            <IconButton
              label="Remove action"
              size="sm"
              onClick={() => set({ actions: a.actions.filter((_, j) => j !== i) })}
            >
              <X size={14} />
            </IconButton>
          </div>
        ))}
        <select
          aria-label="Add an action"
          value=""
          onChange={(e) => e.target.value && addAction(e.target.value as AutomationAction['kind'])}
          className={cn(field, 'self-start')}
        >
          <option value="">Add an action…</option>
          {!scheduled && <option value="setProperties">Edit property</option>}
          <option value="addPage">Add a page</option>
          <option value="notify">Send notification</option>
          <option value="webhook">Send webhook</option>
        </select>
      </section>

      {team && <RunLog team={team} databaseId={databaseId} automationId={a.id} />}

      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => onSave(a)} data-testid="automation-save">
          Save
        </Button>
      </div>
    </div>
  );
}

function PropertyTrigger({
  trigger,
  properties,
  onChange,
}: {
  trigger: Extract<AutomationTrigger, { kind: 'propertyEdited' }>;
  properties: readonly Property[];
  onChange(t: AutomationTrigger): void;
}) {
  const property = properties.find((p) => p.id === trigger.propertyId);
  const options = property ? optionsOf(property) : [];
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Property"
        value={trigger.propertyId}
        onChange={(e) => onChange({ kind: 'propertyEdited', propertyId: e.target.value })}
        className={field}
      >
        {properties.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {(options.length > 0 || property?.type === 'checkbox') && (
        <select
          aria-label="Set to"
          value={trigger.to === undefined ? '' : JSON.stringify(trigger.to)}
          onChange={(e) =>
            onChange({
              kind: 'propertyEdited',
              propertyId: trigger.propertyId,
              ...(e.target.value !== '' && { to: JSON.parse(e.target.value) as unknown }),
            })
          }
          className={field}
        >
          <option value="">changed to anything</option>
          {property?.type === 'checkbox' ? (
            <>
              <option value="true">checked</option>
              <option value="false">unchecked</option>
            </>
          ) : (
            options.map((o) => (
              <option key={o.id} value={JSON.stringify(o.id)}>
                set to {o.name}
              </option>
            ))
          )}
        </select>
      )}
    </div>
  );
}

function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: Schedule;
  onChange(s: Schedule): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        aria-label="Every"
        value={schedule.every}
        onChange={(e) => {
          const every = e.target.value as Schedule['every'];
          onChange({
            ...schedule,
            every,
            weekday: every === 'week' ? (schedule.weekday ?? 1) : undefined,
            monthDay: every === 'month' ? (schedule.monthDay ?? 1) : undefined,
          });
        }}
        className={field}
      >
        <option value="day">Every day</option>
        <option value="week">Every week</option>
        <option value="month">Every month</option>
      </select>
      {schedule.every === 'week' && (
        <select
          aria-label="Day of the week"
          value={schedule.weekday ?? 1}
          onChange={(e) => onChange({ ...schedule, weekday: Number(e.target.value) })}
          className={field}
        >
          {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
            (d, i) => (
              <option key={d} value={i}>
                on {d}
              </option>
            ),
          )}
        </select>
      )}
      {schedule.every === 'month' && (
        <input
          aria-label="Day of the month"
          type="number"
          min={1}
          max={31}
          value={schedule.monthDay ?? 1}
          onChange={(e) => onChange({ ...schedule, monthDay: Number(e.target.value) })}
          className={cn(field, 'w-16')}
        />
      )}
      <input
        aria-label="Time"
        type="time"
        value={schedule.time}
        onChange={(e) => onChange({ ...schedule, time: e.target.value })}
        className={field}
      />
      <span className="text-xs text-muted">{schedule.timeZone}</span>
    </div>
  );
}

function ActionEditor({
  action,
  properties,
  personIds,
  names,
  scheduled,
  onChange,
}: {
  action: AutomationAction;
  properties: readonly Property[];
  personIds: readonly string[];
  names: ReadonlyMap<string, string>;
  scheduled: boolean;
  onChange(a: AutomationAction): void;
}) {
  switch (action.kind) {
    case 'setProperties':
    case 'addPage':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">
            {action.kind === 'setProperties' ? 'Edit property' : 'Add a page'}
          </span>
          {action.kind === 'addPage' && (
            <input
              aria-label="Page title"
              value={action.title}
              onChange={(e) => onChange({ ...action, title: e.target.value })}
              className={field}
            />
          )}
          <ValuesEditor
            values={action.values}
            properties={properties.filter(
              (p) => p.type !== 'title' || action.kind === 'setProperties',
            )}
            scheduled={scheduled}
            onChange={(values) => onChange({ ...action, values })}
          />
        </div>
      );
    case 'notify':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">Send notification</span>
          <div className="flex flex-wrap gap-2">
            {personIds.map((id) => (
              <label key={id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={action.people.includes(id)}
                  onChange={(e) =>
                    onChange({
                      ...action,
                      people: e.target.checked
                        ? [...action.people, id]
                        : action.people.filter((p) => p !== id),
                    })
                  }
                />
                {names.get(id) ?? 'Someone'}
              </label>
            ))}
          </div>
          {!scheduled && (
            <select
              aria-label="And the people in"
              value={action.peopleProperty ?? ''}
              onChange={(e) => onChange({ ...action, peopleProperty: e.target.value || null })}
              className={field}
            >
              <option value="">and nobody else</option>
              {properties
                .filter((p) => p.type === 'person')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    and the people in {p.name}
                  </option>
                ))}
            </select>
          )}
          <input
            aria-label="Message"
            placeholder="Message"
            value={action.message}
            onChange={(e) => onChange({ ...action, message: e.target.value })}
            className={field}
          />
        </div>
      );
    case 'webhook':
      return (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium">Send webhook</span>
          <input
            aria-label="Webhook URL"
            value={action.url}
            onChange={(e) => onChange({ ...action, url: e.target.value })}
            className={field}
          />
          <span className="text-xs text-muted">
            A POST of the page as JSON, signed with this automation’s secret (X-Notion-Signature).
          </span>
        </div>
      );
  }
}

/** Values to set, property by property. */
function ValuesEditor({
  values,
  properties,
  scheduled,
  onChange,
}: {
  values: Record<string, ActionValue>;
  properties: readonly Property[];
  scheduled: boolean;
  onChange(v: Record<string, ActionValue>): void;
}) {
  const ctx = useDisplayContext();
  const unset = properties.filter((p) => !(p.id in values));
  return (
    <div className="flex flex-col gap-1">
      {Object.entries(values).map(([id, value]) => {
        const property = properties.find((p) => p.id === id);
        if (!property) return null;
        return (
          <div key={id} className="flex items-center gap-2">
            <span className="w-28 truncate text-muted">{property.name}</span>
            <ValueInput
              property={property}
              value={value}
              scheduled={scheduled}
              ctxParse={(text) => propertyKind(property.type).parse(text, property, ctx).value}
              onChange={(v) => onChange({ ...values, [id]: v })}
            />
            <IconButton
              label={`Don’t set ${property.name}`}
              size="sm"
              onClick={() =>
                onChange(Object.fromEntries(Object.entries(values).filter(([k]) => k !== id)))
              }
            >
              <X size={12} />
            </IconButton>
          </div>
        );
      })}
      {unset.length > 0 && (
        <select
          aria-label="Set a property"
          value=""
          onChange={(e) => {
            const p = properties.find((x) => x.id === e.target.value);
            if (!p) return;
            const initial: ActionValue =
              p.type === 'date' ? { kind: 'now' } : { kind: 'fixed', value: null };
            onChange({ ...values, [p.id]: initial });
          }}
          className={cn(field, 'self-start')}
        >
          <option value="">Set a property…</option>
          {unset.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function ValueInput({
  property,
  value,
  scheduled,
  ctxParse,
  onChange,
}: {
  property: Property;
  value: ActionValue;
  scheduled: boolean;
  ctxParse(text: string): unknown;
  onChange(v: ActionValue): void;
}) {
  const options = optionsOf(property);
  const fixed = value.kind === 'fixed' ? value.value : null;
  if (property.type === 'date') {
    return (
      <select
        aria-label={`${property.name} value`}
        value={value.kind === 'now' ? 'now' : 'none'}
        onChange={(e) =>
          onChange(e.target.value === 'now' ? { kind: 'now' } : { kind: 'fixed', value: null })
        }
        className={field}
      >
        <option value="now">Today</option>
        <option value="none">Empty</option>
      </select>
    );
  }
  if (property.type === 'person') {
    return (
      <select
        aria-label={`${property.name} value`}
        value={value.kind === 'triggeredBy' ? 'by' : 'none'}
        onChange={(e) =>
          onChange(
            e.target.value === 'by' ? { kind: 'triggeredBy' } : { kind: 'fixed', value: null },
          )
        }
        className={field}
      >
        {!scheduled && <option value="by">Person who triggered it</option>}
        <option value="none">Empty</option>
      </select>
    );
  }
  if (property.type === 'checkbox') {
    return (
      <input
        aria-label={`${property.name} value`}
        type="checkbox"
        checked={fixed === true}
        onChange={(e) => onChange({ kind: 'fixed', value: e.target.checked })}
      />
    );
  }
  if (options.length > 0) {
    return (
      <select
        aria-label={`${property.name} value`}
        value={typeof fixed === 'string' ? fixed : ''}
        onChange={(e) =>
          onChange({
            kind: 'fixed',
            value: e.target.value
              ? property.type === 'multiSelect'
                ? [e.target.value]
                : e.target.value
              : null,
          })
        }
        className={field}
      >
        <option value="">Empty</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <TextValue
      label={`${property.name} value`}
      initial={fixed === null || fixed === undefined ? '' : String(fixed)}
      onChange={(text) => onChange({ kind: 'fixed', value: text === '' ? null : ctxParse(text) })}
    />
  );
}

function TextValue({
  label,
  initial,
  onChange,
}: {
  label: string;
  initial: string;
  onChange(text: string): void;
}) {
  const [text, setText] = useState(initial);
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text)}
      className={cn(field, 'min-w-0 flex-1')}
    />
  );
}

// --- Runs ----------------------------------------------------------------------------

interface Run {
  id: string;
  at: number;
  status: 'done' | 'failed' | 'pending';
  error: string | null;
  result: unknown;
}

function RunLog({
  team,
  databaseId,
  automationId,
}: {
  team: TeamApi;
  databaseId: string;
  automationId: string;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  useEffect(() => {
    team.automationRuns(databaseId, automationId).then(
      (r) => setRuns(r.runs),
      () => setRuns([]),
    );
  }, [team, databaseId, automationId]);
  if (!runs || runs.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" data-testid="automation-runs">
      <span className="text-xs font-medium text-muted">Recent runs</span>
      {runs.slice(0, 10).map((r) => (
        <div key={r.id} className="flex gap-2 text-xs">
          <span className="w-36 shrink-0 text-muted">{new Date(r.at).toLocaleString()}</span>
          <span className={cn(r.status === 'failed' && 'text-danger')}>
            {r.status === 'failed'
              ? `Failed: ${r.error ?? ''}`
              : r.status === 'pending'
                ? 'Running…'
                : (skipped(r.result) ?? 'Done')}
          </span>
        </div>
      ))}
    </section>
  );
}

const skipped = (result: unknown) => {
  const reason = (result as { skipped?: string } | null)?.skipped;
  return reason === 'paused'
    ? 'Paused: its maker can’t edit this database'
    : reason
      ? `Skipped (${reason})`
      : null;
};
