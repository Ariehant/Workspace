import {
  ME,
  TODAY,
  isInTrash,
  listPages,
  listUsers,
  type ButtonConfig,
  type ButtonStep,
  workspaceDataDoc,
} from '@workspace/core';
import {
  OPTION_COLORS,
  addOption,
  cellText,
  isDateValue,
  newFilterRule,
  propertyKind,
  type DateValue,
  type DisplayContext,
  type FilterRule,
  type Property,
  type Row,
} from '@workspace/database';
import { PageEditor } from '@workspace/editor';
import {
  Button,
  Dialog,
  DialogContent,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@workspace/ui';
import { Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useApp } from '../context';
import { SecretReveal } from '../database/automations-dialog';
import { useDatabase, useDisplayContext } from '../database/hooks';
import { RuleFields } from '../database/view-controls';
import { useEditorServices } from '../editor-services';
import { useDoc } from '../hooks';

export interface ButtonEditRequest {
  config: ButtonConfig;
  /** A button block (with template blocks) or a database button property. */
  mode: 'block' | 'property';
  /** Block buttons: the doc holding the template blocks. */
  buttonId?: string;
  /** The page the button is on (for the template editor's services). */
  hostPageId: string;
  /** Button properties: the database the button runs in. */
  databaseId?: string;
}

type Pending = ButtonEditRequest & { resolve(config: ButtonConfig | null): void };
let show: ((request: Pending | null) => void) | null = null;

/** Open the button editor; resolves the new settings, or null when cancelled. */
export function editButton(request: ButtonEditRequest): Promise<ButtonConfig | null> {
  return new Promise((resolve) => {
    if (!show) resolve(null);
    else show({ ...request, resolve });
  });
}

/** Mounted once in the app: shows the button editor when asked. */
export function ButtonEditorHost() {
  const [request, setRequest] = useState<Pending | null>(null);
  useEffect(() => {
    show = setRequest;
    return () => {
      show = null;
    };
  }, []);
  if (!request) return null;
  const close = (config: ButtonConfig | null) => {
    request.resolve(config);
    setRequest(null);
  };
  return <ButtonDialog request={request} onClose={close} />;
}

const STEP_LABELS: Record<ButtonStep['kind'], string> = {
  insertBlocks: 'Insert blocks',
  addPage: 'Add page to…',
  editPages: 'Edit pages in…',
  editThisRow: 'Edit this page',
  openPage: 'Open page',
  confirm: 'Show confirmation',
  webhook: 'Send webhook',
  notify: 'Send notification',
};

const inputClass =
  'h-8 rounded border border-line bg-transparent px-2 text-sm text-fg outline-none focus:border-accent';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-h-9 items-center justify-between gap-3">
      <span className="text-muted">{label}</span>
      {children}
    </label>
  );
}

function ButtonDialog({
  request,
  onClose,
}: {
  request: Pending;
  onClose(config: ButtonConfig | null): void;
}) {
  const [config, setConfig] = useState<ButtonConfig>(request.config);
  const set = (changes: Partial<ButtonConfig>) => setConfig((c) => ({ ...c, ...changes }));
  const setStep = (i: number, step: ButtonStep | null) =>
    set({
      steps: step
        ? config.steps.map((s, j) => (j === i ? step : s))
        : config.steps.filter((_, j) => j !== i),
    });
  const { team, platform } = useApp();
  // Webhooks and notifications go out through the server, or the desktop that runs them.
  const outward: ButtonStep['kind'][] = team || platform.automations ? ['webhook', 'notify'] : [];
  const kinds: ButtonStep['kind'][] =
    request.mode === 'block'
      ? ['insertBlocks', 'addPage', 'editPages', 'openPage', ...outward, 'confirm']
      : ['editThisRow', 'addPage', 'editPages', 'openPage', ...outward, 'confirm'];
  const newStep = (kind: ButtonStep['kind']): ButtonStep => {
    switch (kind) {
      case 'insertBlocks':
        return { kind, placement: 'below' };
      case 'addPage':
        return { kind, databaseId: '', title: '', values: {}, open: false };
      case 'editPages':
        return { kind, databaseId: '', filter: null, values: {} };
      case 'editThisRow':
        return { kind, values: {} };
      case 'openPage':
        return { kind, pageId: '' };
      case 'confirm':
        return { kind, message: 'Are you sure?' };
      case 'webhook':
        return { kind, url: '', headers: {} };
      case 'notify':
        return { kind, people: [], message: '' };
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose(null)}>
      <DialogContent
        title="Edit button"
        className="top-[8vh] w-[min(620px,calc(100vw-32px))]"
        data-testid="button-editor"
      >
        <div className="max-h-[70vh] space-y-2 overflow-y-auto px-4 py-3">
          <Field label="Label">
            <input
              aria-label="Button label"
              value={config.label}
              onChange={(e) => set({ label: e.target.value })}
              className={`${inputClass} w-64`}
            />
          </Field>
          <Field label="Color">
            <select
              aria-label="Button color"
              value={config.color}
              onChange={(e) => set({ color: e.target.value })}
              className={`${inputClass} w-64 capitalize`}
            >
              {OPTION_COLORS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>
          <p className="pt-2 text-xs font-medium text-muted uppercase">When clicked</p>
          {config.steps.map((step, i) => (
            <div key={i} className="rounded-md border border-line p-3" data-testid="button-step">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">
                  {i + 1}. {STEP_LABELS[step.kind]}
                </span>
                <IconButton
                  label={`Remove step ${i + 1}`}
                  size="sm"
                  onClick={() => setStep(i, null)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
              <StepFields step={step} request={request} onChange={(s) => setStep(i, s)} />
            </div>
          ))}
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded px-2 text-muted hover:bg-hover"
              >
                <Plus size={14} /> Add a step
              </button>
            </MenuTrigger>
            <MenuContent align="start" data-testid="add-step-menu">
              {kinds.map((kind) => (
                <MenuItem
                  key={kind}
                  onSelect={() => set({ steps: [...config.steps, newStep(kind)] })}
                >
                  {STEP_LABELS[kind]}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <Button onClick={() => onClose(null)}>Cancel</Button>
          <Button variant="primary" onClick={() => onClose(config)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepFields({
  step,
  request,
  onChange,
}: {
  step: ButtonStep;
  request: Pending;
  onChange(step: ButtonStep): void;
}) {
  switch (step.kind) {
    case 'insertBlocks':
      return (
        <>
          <Field label="Insert">
            <select
              aria-label="Where to insert"
              value={step.placement}
              onChange={(e) =>
                onChange({ ...step, placement: e.target.value as 'above' | 'below' })
              }
              className={inputClass}
            >
              <option value="below">Below the button</option>
              <option value="above">Above the button</option>
            </select>
          </Field>
          {request.buttonId && (
            <TemplateEditor buttonId={request.buttonId} hostPageId={request.hostPageId} />
          )}
        </>
      );
    case 'addPage':
      return (
        <>
          <DatabaseSelect
            value={step.databaseId}
            onChange={(databaseId) => onChange({ ...step, databaseId, values: {} })}
          />
          <Field label="Title">
            <input
              aria-label="Page title"
              value={step.title}
              onChange={(e) => onChange({ ...step, title: e.target.value })}
              className={`${inputClass} w-64`}
            />
          </Field>
          {step.databaseId && (
            <ValuesEditor
              databaseId={step.databaseId}
              values={step.values}
              onChange={(values) => onChange({ ...step, values })}
            />
          )}
          <Field label="Open the page">
            <input
              type="checkbox"
              aria-label="Open the page"
              checked={step.open}
              onChange={(e) => onChange({ ...step, open: e.target.checked })}
              className="size-4 accent-[var(--ws-accent)]"
            />
          </Field>
        </>
      );
    case 'editPages':
      return (
        <>
          <DatabaseSelect
            value={step.databaseId}
            onChange={(databaseId) => onChange({ ...step, databaseId, filter: null, values: {} })}
          />
          {step.databaseId && (
            <>
              <FilterEditor
                databaseId={step.databaseId}
                filter={step.filter as FilterRule | null}
                onChange={(filter) => onChange({ ...step, filter })}
              />
              <ValuesEditor
                databaseId={step.databaseId}
                values={step.values}
                onChange={(values) => onChange({ ...step, values })}
              />
            </>
          )}
        </>
      );
    case 'editThisRow':
      return request.databaseId ? (
        <ValuesEditor
          databaseId={request.databaseId}
          values={step.values}
          onChange={(values) => onChange({ ...step, values })}
        />
      ) : null;
    case 'openPage':
      return (
        <PageSelect value={step.pageId} onChange={(pageId) => onChange({ ...step, pageId })} />
      );
    case 'confirm':
      return (
        <Field label="Message">
          <input
            aria-label="Confirmation message"
            value={step.message}
            onChange={(e) => onChange({ ...step, message: e.target.value })}
            className={`${inputClass} w-64`}
          />
        </Field>
      );
    case 'webhook':
      return <WebhookFields step={step} onChange={onChange} />;
    case 'notify':
      return <NotifyFields step={step} onChange={onChange} />;
  }
}

function WebhookFields({
  step,
  onChange,
}: {
  step: Extract<ButtonStep, { kind: 'webhook' }>;
  onChange(step: ButtonStep): void;
}) {
  const { team, platform } = useApp();
  const secret = team
    ? async () => (await team.buttonSecret()).secret
    : platform.automations?.buttonSecret;
  return (
    <>
      <Field label="URL">
        <input
          aria-label="Webhook URL"
          placeholder="https://"
          value={step.url}
          onChange={(e) => onChange({ ...step, url: e.target.value.trim() })}
          className={`${inputClass} w-80`}
        />
      </Field>
      <p className="text-xs text-muted">
        A POST of the page as JSON, signed with the workspace’s button secret (X-Notion-Signature).
      </p>
      {secret && <SecretReveal secret={secret} />}
    </>
  );
}

function NotifyFields({
  step,
  onChange,
}: {
  step: Extract<ButtonStep, { kind: 'notify' }>;
  onChange(step: ButtonStep): void;
}) {
  const people = useDisplayContext();
  const ids = people.people ?? [...people.users.keys()];
  return (
    <>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {ids.map((id) => (
          <label key={id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={step.people.includes(id)}
              onChange={(e) =>
                onChange({
                  ...step,
                  people: e.target.checked
                    ? [...step.people, id]
                    : step.people.filter((p) => p !== id),
                })
              }
            />
            {people.users.get(id) ?? 'Someone'}
          </label>
        ))}
      </div>
      <Field label="Message">
        <input
          aria-label="Notification message"
          value={step.message}
          onChange={(e) => onChange({ ...step, message: e.target.value })}
          className={`${inputClass} w-64`}
        />
      </Field>
    </>
  );
}

/** The button's template blocks, edited like a page. */
function TemplateEditor({ buttonId, hostPageId }: { buttonId: string; hostPageId: string }) {
  const { client } = useApp();
  const doc = useDoc(client, buttonId);
  const services = useEditorServices(hostPageId);
  return (
    <div
      className="mt-1 rounded border border-dashed border-line px-3 py-1"
      data-testid="button-template"
    >
      {doc ? (
        <PageEditor doc={doc} services={services} />
      ) : (
        <div className="h-8" aria-busy="true" />
      )}
    </div>
  );
}

function DatabaseSelect({ value, onChange }: { value: string; onChange(id: string): void }) {
  const { workspace } = useApp();
  const databases = listPages(workspace).filter(
    (p) => p.kind === 'database' && !isInTrash(workspace, p.id),
  );
  return (
    <Field label="Database">
      <select
        aria-label="Database"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} w-64`}
      >
        <option value="" disabled>
          Select a database
        </option>
        {databases.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title || 'Untitled'}
          </option>
        ))}
      </select>
    </Field>
  );
}

function PageSelect({ value, onChange }: { value: string; onChange(id: string): void }) {
  const { pages } = useApp();
  const list = pages.list().filter((p) => !p.inTrash);
  return (
    <Field label="Page">
      <select
        aria-label="Page to open"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${inputClass} w-64`}
      >
        <option value="" disabled>
          Select a page
        </option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title || 'Untitled'}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Properties a button can set (computed ones and relations aside). */
const settable = (p: Property) =>
  p.id !== 'title' && !propertyKind(p.type).computed && p.type !== 'relation' && p.type !== 'files';

/** "Only pages where …": an optional single filter rule. */
function FilterEditor({
  databaseId,
  filter,
  onChange,
}: {
  databaseId: string;
  filter: FilterRule | null;
  onChange(filter: FilterRule | null): void;
}) {
  const loaded = useDatabase(databaseId);
  const ctx = useDisplayContext();
  if (!loaded) return null;
  const properties = loaded.snapshot.properties.filter((p) => p.type !== 'button');
  const property = filter && properties.find((p) => p.id === filter.propertyId);
  return (
    <div className="space-y-1">
      <Field label="Pages">
        <select
          aria-label="Which pages"
          value={filter?.propertyId ?? ''}
          onChange={(e) => {
            const p = properties.find((x) => x.id === e.target.value);
            onChange(p ? newFilterRule(p) : null);
          }}
          className={`${inputClass} w-64`}
        >
          <option value="">All pages</option>
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              Where {p.name}…
            </option>
          ))}
        </select>
      </Field>
      {filter && property && (
        <div className="flex flex-wrap items-center gap-2 pl-2" data-testid="button-filter">
          <RuleFields rule={filter} property={property} ctx={ctx} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

/** A value as text in the editor (`@today` and `@me` stay as written). */
function valueText(value: unknown, property: Property, ctx: DisplayContext): string {
  if (property.type === 'date' && value && typeof value === 'object') {
    const d = value as DateValue;
    return d.end ? `${d.start} → ${d.end}` : d.start;
  }
  if (property.type === 'person' && Array.isArray(value)) {
    return value.map((id) => (id === ME ? ME : (ctx.users.get(id as string) ?? ''))).join(', ');
  }
  if (property.type === 'checkbox') return value === true ? 'true' : 'false';
  const row = { id: '', title: '', values: { [property.id]: value } } as unknown as Row;
  return cellText(row, property, ctx);
}

/** Read a typed value: `@today` for dates, `@me` and names for people, else the type's parser. */
function parseValue(
  text: string,
  property: Property,
  ctx: DisplayContext,
  addOptions: (
    options: NonNullable<ReturnType<ReturnType<typeof propertyKind>['parse']>['newOptions']>,
  ) => void,
): unknown {
  const t = text.trim();
  if (!t) return null;
  if (property.type === 'date') {
    if (t.toLowerCase() === TODAY || t.toLowerCase() === 'today') return { start: TODAY };
    const parsed = propertyKind('date').parse(t, property, ctx).value;
    return isDateValue(parsed) ? parsed : null;
  }
  if (property.type === 'person') {
    const ids = t.split(',').flatMap((name) => {
      const n = name.trim().toLowerCase();
      if (n === ME || n === 'me') return [ME];
      const found = [...ctx.users].find(([, label]) => label.toLowerCase() === n);
      return found ? [found[0]] : [];
    });
    return ids.length ? ids : null;
  }
  if (property.type === 'checkbox')
    return ['true', 'yes', 'checked', '1'].includes(t.toLowerCase());
  const parsed = propertyKind(property.type).parse(t, property, ctx);
  if (parsed.newOptions) addOptions(parsed.newOptions);
  return parsed.value;
}

function ValuesEditor({
  databaseId,
  values,
  onChange,
}: {
  databaseId: string;
  values: Record<string, unknown>;
  onChange(values: Record<string, unknown>): void;
}) {
  const loaded = useDatabase(databaseId);
  const { workspace } = useApp();
  const ctx: DisplayContext = {
    users: new Map(listUsers(workspaceDataDoc(workspace)).map((u) => [u.id, u.name])),
  };
  if (!loaded) return null;
  const properties = loaded.snapshot.properties.filter(settable);
  const unused = properties.filter((p) => !(p.id in values));
  return (
    <div className="space-y-1" data-testid="button-values">
      {Object.entries(values).map(([id, value]) => {
        const property = properties.find((p) => p.id === id);
        if (!property) return null;
        return (
          <div key={id} className="flex items-center gap-2">
            <span className="w-32 truncate text-muted">Set {property.name}</span>
            <input
              aria-label={`Value of ${property.name}`}
              defaultValue={valueText(value, property, ctx)}
              placeholder={
                property.type === 'date'
                  ? `${TODAY} or 2026-10-06`
                  : property.type === 'person'
                    ? `${ME} or a name`
                    : ''
              }
              onBlur={(e) =>
                onChange({
                  ...values,
                  [id]: parseValue(e.target.value, property, ctx, (options) =>
                    options.forEach((o) => addOption(loaded.handle.doc, property.id, o)),
                  ),
                })
              }
              className={`${inputClass} flex-1`}
            />
            <IconButton
              label={`Don't set ${property.name}`}
              size="sm"
              onClick={() => {
                const next = { ...values };
                delete next[id];
                onChange(next);
              }}
            >
              <X size={13} />
            </IconButton>
          </div>
        );
      })}
      {unused.length > 0 && (
        <select
          aria-label="Set a property"
          value=""
          onChange={(e) => e.target.value && onChange({ ...values, [e.target.value]: null })}
          className={`${inputClass} text-muted`}
        >
          <option value="">+ Set a property…</option>
          {unused.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
