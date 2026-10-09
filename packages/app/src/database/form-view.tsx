/**
 * The form view (Phase 6 M2): a database's questions, answered as a new row.
 *
 * - Someone who may edit the database builds the form here (title, questions, required,
 *   what's shown after submitting) and previews it.
 * - Everyone who can see it fills it in. On a server, the response goes to the server,
 *   which writes the row (so viewers can respond too) and can tell the form's maker.
 *   In a workspace that isn't synced, the row is added here.
 * - On a server, a form can be shared with anyone who has its link (a page of its own,
 *   `/f/<token>`, for people without an account).
 */
import { roleAllows } from '@workspace/core';
import {
  FORM_QUESTION_TYPES,
  addProperty,
  addRow,
  canAsk,
  formQuestions,
  newPropertyName,
  optionsOf,
  propertyKind,
  updateView,
  validateSubmission,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type FormAudience,
  type FormConfig,
  type FormQuestion,
  type Property,
  type View,
} from '@workspace/database';
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from '@workspace/ui';
import { ArrowDown, ArrowUp, Check, Eye, Link, Pencil, Plus, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../context';
import { teamApi, type TeamApi } from '../team';
import { PropertyIcon } from './cells';
import { useDisplayContext } from './hooks';

const field =
  'w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FormView({
  handle,
  snapshot,
  view,
  structureEditable,
  databaseTitle,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  /** May change the form (the database's views). */
  structureEditable: boolean;
  databaseTitle: string;
}) {
  const { platform, pages } = useApp();
  const team = useMemo(() => (platform.team ? teamApi(platform.team) : null), [platform.team]);
  const [mode, setMode] = useState<'build' | 'fill'>(structureEditable ? 'build' : 'fill');
  const building = structureEditable && mode === 'build';
  const canShare = roleAllows(pages.role(handle.id), 'full');

  return (
    <div className="py-4" data-testid="form-view">
      <div className="mx-auto mb-3 flex max-w-2xl items-center justify-end gap-1">
        {structureEditable && (
          <>
            <Button
              className={cn(building && 'bg-hover')}
              aria-pressed={building}
              onClick={() => setMode('build')}
              data-testid="form-mode-build"
            >
              <Pencil size={14} /> Edit form
            </Button>
            <Button
              className={cn(!building && 'bg-hover')}
              aria-pressed={!building}
              onClick={() => setMode('fill')}
              data-testid="form-mode-fill"
            >
              <Eye size={14} /> Preview
            </Button>
          </>
        )}
        {team && (
          <ShareForm
            team={team}
            databaseId={handle.id}
            view={view}
            canEdit={structureEditable}
            canShare={canShare}
          />
        )}
      </div>
      {building ? (
        <FormBuilder
          handle={handle}
          snapshot={snapshot}
          view={view}
          databaseTitle={databaseTitle}
        />
      ) : (
        <FormFill
          handle={handle}
          snapshot={snapshot}
          view={view}
          team={team}
          databaseTitle={databaseTitle}
        />
      )}
    </div>
  );
}

// --- Building ------------------------------------------------------------------------

function FormBuilder({
  handle,
  snapshot,
  view,
  databaseTitle,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  databaseTitle: string;
}) {
  const { user } = useApp();
  const form = view.form;
  const setForm = (changes: Partial<FormConfig>) =>
    updateView(handle.doc, view.id, { form: { ...form, ...changes } });
  const asked = formQuestions(snapshot.properties, form);
  const askedIds = new Set(asked.map((q) => q.property.id));
  const unasked = snapshot.properties.filter((p) => canAsk(p.type) && !askedIds.has(p.id));
  const setQuestions = (questions: FormQuestion[]) => setForm({ questions });
  const questions = asked.map((q) => q.question);
  const change = (index: number, changes: Partial<FormQuestion>) =>
    setQuestions(questions.map((q, i) => (i === index ? { ...q, ...changes } : q)));
  const move = (index: number, by: number) => {
    const next = [...questions];
    const [q] = next.splice(index, 1);
    next.splice(index + by, 0, q!);
    setQuestions(next);
  };
  const ask = (propertyId: string) =>
    setQuestions([...questions, { propertyId, label: '', description: '', required: false }]);

  return (
    <div className="mx-auto max-w-2xl space-y-3" data-testid="form-builder">
      <input
        aria-label="Form title"
        value={form.title}
        placeholder={databaseTitle || 'Form title'}
        onChange={(e) => setForm({ title: e.target.value })}
        className="w-full bg-transparent text-2xl font-bold outline-none placeholder:text-faint"
      />
      <textarea
        aria-label="Form description"
        value={form.description}
        placeholder="Add a description"
        onChange={(e) => setForm({ description: e.target.value })}
        rows={2}
        className="w-full resize-none bg-transparent text-sm text-muted outline-none placeholder:text-faint"
      />
      {asked.map(({ question, property }, i) => (
        <div
          key={property.id}
          className="rounded-lg border border-line p-3"
          data-testid="form-question"
        >
          <div className="flex items-center gap-2">
            <PropertyIcon type={property.type} />
            <input
              aria-label={`Question for ${property.name}`}
              value={question.label}
              placeholder={property.name}
              onChange={(e) => change(i, { label: e.target.value })}
              className="min-w-0 flex-1 bg-transparent font-medium outline-none placeholder:text-fg"
            />
            <label className="flex items-center gap-1 text-xs text-muted">
              <input
                type="checkbox"
                checked={question.required}
                onChange={(e) => change(i, { required: e.target.checked })}
                aria-label={`${property.name} is required`}
              />
              Required
            </label>
            <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={14} />
            </IconButton>
            <IconButton
              label="Move down"
              size="sm"
              disabled={i === asked.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown size={14} />
            </IconButton>
            <IconButton
              label={`Remove ${property.name}`}
              size="sm"
              onClick={() => setQuestions(questions.filter((_, j) => j !== i))}
            >
              <X size={14} />
            </IconButton>
          </div>
          <input
            aria-label={`Description for ${property.name}`}
            value={question.description}
            placeholder="Description (optional)"
            onChange={(e) => change(i, { description: e.target.value })}
            className="mt-1 w-full bg-transparent text-sm text-muted outline-none placeholder:text-faint"
          />
        </div>
      ))}
      <Menu>
        <MenuTrigger asChild>
          <Button data-testid="form-add-question">
            <Plus size={14} /> Add a question
          </Button>
        </MenuTrigger>
        <MenuContent className="max-h-96 w-56 overflow-y-auto">
          {unasked.map((p) => (
            <MenuItem key={p.id} icon={<PropertyIcon type={p.type} />} onSelect={() => ask(p.id)}>
              {p.name}
            </MenuItem>
          ))}
          {unasked.length > 0 && <MenuSeparator />}
          {FORM_QUESTION_TYPES.filter((t) => t !== 'title').map((type) => (
            <MenuItem
              key={type}
              icon={<PropertyIcon type={type} />}
              onSelect={() => {
                const label = propertyKind(type).label;
                const id = addProperty(handle.doc, {
                  name: newPropertyName(handle.doc, label),
                  type,
                });
                ask(id);
              }}
            >
              New {propertyKind(type).label.toLowerCase()} question
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>
      <div className="space-y-2 border-t border-line pt-3 text-sm">
        <label className="block text-muted">
          After submitting, show
          <input
            aria-label="Message after submitting"
            value={form.submittedMessage}
            onChange={(e) => setForm({ submittedMessage: e.target.value })}
            className={cn(field, 'mt-1')}
          />
        </label>
        <label className="flex items-center gap-2 text-muted">
          <input
            type="checkbox"
            checked={form.notify && form.createdBy === user.id}
            onChange={(e) => setForm({ notify: e.target.checked, createdBy: user.id })}
          />
          Notify me of each response
        </label>
      </div>
    </div>
  );
}

// --- Sharing -------------------------------------------------------------------------

function ShareForm({
  team,
  databaseId,
  view,
  canEdit,
  canShare,
}: {
  team: TeamApi;
  databaseId: string;
  view: View;
  canEdit: boolean;
  canShare: boolean;
}) {
  const { databases } = useApp();
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const audience = view.form.audience;
  useEffect(() => {
    if (!open) return;
    team.formLink(databaseId, view.id).then(
      (r) => setLink(r.link),
      (e: unknown) => setError(errorText(e)),
    );
  }, [open, team, databaseId, view.id]);
  const act = (call: () => Promise<{ link: string | null }>) => {
    setError(null);
    call().then(
      (r) => setLink(r.link),
      (e: unknown) => setError(errorText(e)),
    );
  };
  const setAudience = (value: FormAudience) => {
    const handle = databases.get(databaseId);
    if (handle) updateView(handle.doc, view.id, { form: { ...view.form, audience: value } });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button data-testid="form-share">
          <Share2 size={14} /> Share form
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-3" data-testid="form-share-panel">
        <label className="block text-sm">
          Who can fill it in
          <select
            aria-label="Who can fill it in"
            value={audience}
            disabled={!canEdit}
            onChange={(e) => setAudience(e.target.value as FormAudience)}
            className={cn(field, 'mt-1')}
          >
            <option value="access">People who can see this database</option>
            <option value="public">Anyone with the link</option>
          </select>
        </label>
        {audience === 'public' && (
          <div className="space-y-2 text-sm">
            {link ? (
              <>
                <div className="flex items-center gap-1">
                  <a
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                    data-testid="form-link"
                    className="min-w-0 flex-1 truncate text-accent hover:underline"
                  >
                    {link}
                  </a>
                  <IconButton
                    label="Copy link"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(link);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? <Check size={14} /> : <Link size={14} />}
                  </IconButton>
                </div>
                {canShare && (
                  <div className="flex gap-1">
                    <Button onClick={() => act(() => team.newFormLink(databaseId, view.id))}>
                      New link
                    </Button>
                    <Button
                      className="text-danger"
                      onClick={() => act(() => team.removeFormLink(databaseId, view.id))}
                    >
                      Turn off link
                    </Button>
                  </div>
                )}
              </>
            ) : link === null ? (
              canShare ? (
                <Button
                  variant="primary"
                  onClick={() => act(() => team.newFormLink(databaseId, view.id))}
                >
                  Create link
                </Button>
              ) : (
                <p className="text-muted">Only someone with full access can make a link.</p>
              )
            ) : null}
            <p className="text-xs text-faint">
              Anyone with the link can respond, without an account. Their responses are anonymous.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

// --- Filling in ----------------------------------------------------------------------

function FormFill({
  handle,
  snapshot,
  view,
  team,
  databaseTitle,
}: {
  handle: DatabaseHandle;
  snapshot: DatabaseSnapshot;
  view: View;
  team: TeamApi | null;
  databaseTitle: string;
}) {
  const { user } = useApp();
  const ctx = useDisplayContext();
  const form = view.form;
  const questions = formQuestions(snapshot.properties, form);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Map<string | null, string>>(new Map());
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const people = ctx.people ?? [...ctx.users.keys()];
  const set = (id: string, value: unknown) => setAnswers((a) => ({ ...a, [id]: value }));

  const submit = async () => {
    // Blank answers aren't sent.
    const sent = Object.fromEntries(
      Object.entries(answers).filter(
        ([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length),
      ),
    );
    const checked = validateSubmission(snapshot.properties, form, sent, {
      members: new Set(people),
    });
    if (!checked.ok) {
      setErrors(new Map(checked.errors.map((e) => [e.propertyId, e.message])));
      return;
    }
    setErrors(new Map());
    setBusy(true);
    try {
      // On a server, the server writes the row (and may tell the form's maker).
      if (team) await team.submitForm(handle.id, view.id, sent);
      else addRow(handle.doc, { actor: user.id, title: checked.title, values: checked.values });
      setDone(true);
      setAnswers({});
    } catch (e) {
      setErrors(new Map([[null, errorText(e)]]));
    }
    setBusy(false);
  };

  if (done) {
    return (
      <div className="mx-auto max-w-2xl" data-testid="form-submitted">
        <h2 className="text-2xl font-bold">{form.title || databaseTitle || 'Form'}</h2>
        <p className="mt-2 text-muted" role="status">
          {form.submittedMessage || 'Thanks! Your response was recorded.'}
        </p>
        <Button className="mt-4" onClick={() => setDone(false)}>
          Submit another response
        </Button>
      </div>
    );
  }

  return (
    <form
      className="mx-auto max-w-2xl space-y-4"
      data-testid="form-fill"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 className="text-2xl font-bold">{form.title || databaseTitle || 'Form'}</h2>
        {form.description && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{form.description}</p>
        )}
      </div>
      {questions.length === 0 && <p className="text-muted">This form has no questions yet.</p>}
      {questions.map(({ question, property }) => (
        <div key={property.id} data-testid="form-field">
          <label className="block text-sm font-medium" htmlFor={`form-${property.id}`}>
            {question.label || property.name}
            {question.required && <span className="ml-0.5 text-danger">*</span>}
          </label>
          {question.description && <p className="text-xs text-muted">{question.description}</p>}
          <div className="mt-1">
            <Answer
              property={property}
              value={answers[property.id]}
              onChange={(v) => set(property.id, v)}
              people={people}
              names={ctx.users}
            />
          </div>
          {errors.get(property.id) && (
            <p className="mt-1 text-xs text-danger">{errors.get(property.id)}</p>
          )}
        </div>
      ))}
      {errors.get(null) && <p className="text-sm text-danger">{errors.get(null)}</p>}
      <Button type="submit" variant="primary" disabled={busy} data-testid="form-submit">
        Submit
      </Button>
    </form>
  );
}

function Answer({
  property,
  value,
  onChange,
  people,
  names,
}: {
  property: Property;
  value: unknown;
  onChange(value: unknown): void;
  people: readonly string[];
  names: ReadonlyMap<string, string>;
}) {
  const id = `form-${property.id}`;
  const text = typeof value === 'string' ? value : '';
  const list = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (item: string, on: boolean) =>
    onChange(on ? [...list, item] : list.filter((x) => x !== item));
  switch (property.type) {
    case 'text':
      return (
        <textarea
          id={id}
          value={text}
          rows={3}
          maxLength={2000}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
      );
    case 'number':
      return (
        <input
          id={id}
          type="number"
          step="any"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          className={field}
        />
      );
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 text-sm">
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          Yes
        </label>
      );
    case 'date':
      return (
        <input
          id={id}
          type="date"
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
      );
    case 'select':
    case 'status':
      return (
        <select id={id} value={text} onChange={(e) => onChange(e.target.value)} className={field}>
          <option value="">Choose…</option>
          {optionsOf(property).map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      );
    case 'multiSelect':
      return (
        <div id={id} className="space-y-1">
          {optionsOf(property).map((o) => (
            <label key={o.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={list.includes(o.id)}
                onChange={(e) => toggle(o.id, e.target.checked)}
              />
              {o.name}
            </label>
          ))}
        </div>
      );
    case 'person':
      return (
        <div id={id} className="space-y-1">
          {people.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={list.includes(p)}
                onChange={(e) => toggle(p, e.target.checked)}
              />
              {names.get(p) ?? 'Someone'}
            </label>
          ))}
        </div>
      );
    default:
      return (
        <input
          id={id}
          type={
            property.type === 'email'
              ? 'email'
              : property.type === 'url'
                ? 'url'
                : property.type === 'phone'
                  ? 'tel'
                  : 'text'
          }
          value={text}
          maxLength={2000}
          onChange={(e) => onChange(e.target.value)}
          className={field}
        />
      );
  }
}
