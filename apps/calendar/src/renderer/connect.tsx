/**
 * Connecting Workspace (HANDOFF.md 3.2): the server and an integration token, then the
 * databases to show, and for each one its date property, an optional calendar view, "only
 * mine" and what to colour by.
 */
import { Button, cn, Dialog, DialogContent } from '@workspace/ui';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { CalendarDraft, ConnectSession, DatabaseChoice, SchemaChoice } from '../shared/ipc';
import { DEFAULT_REMINDER, REMINDER_CHOICES, reminderLabel } from '../shared/reminders';
import { COLOURS } from '../shared/types';
import { api, colourVar, unwrap } from './api';

interface Props {
  /** Add databases to this account (it's already connected), or connect a new one. */
  accountId: string | null;
  onClose: () => void;
}

type Step =
  | { kind: 'server' }
  | { kind: 'pick'; session: ConnectSession }
  | { kind: 'configure'; session: ConnectSession; picked: DatabaseChoice[] };

export function ConnectDialog({ accountId, onClose }: Props) {
  const [step, setStep] = useState<Step>({ kind: 'server' });
  const [error, setError] = useState<string | null>(null);
  const sessionId = step.kind === 'server' ? null : step.session.sessionId;

  // An existing account skips the server step.
  useEffect(() => {
    if (!accountId) return;
    unwrap(api.connect.account(accountId)).then(
      (session) => setStep({ kind: 'pick', session }),
      (e: Error) => setError(e.message),
    );
  }, [accountId]);

  const close = () => {
    if (sessionId) void api.connect.cancel(sessionId);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={accountId ? 'Add databases' : 'Connect Workspace'}
        className="top-[8vh] w-[min(640px,calc(100vw-32px))]"
      >
        <div className="max-h-[78vh] overflow-y-auto px-4 pt-2 pb-4">
          {error && step.kind === 'server' && accountId && <ErrorLine message={error} />}
          {step.kind === 'server' && !accountId && (
            <ServerStep onConnected={(session) => setStep({ kind: 'pick', session })} />
          )}
          {step.kind === 'server' && accountId && !error && <Loading label="Connecting…" />}
          {step.kind === 'pick' && (
            <PickStep
              session={step.session}
              onNext={(picked) => setStep({ kind: 'configure', session: step.session, picked })}
            />
          )}
          {step.kind === 'configure' && (
            <ConfigureStep session={step.session} picked={step.picked} onSaved={onClose} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const inputClass =
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';
const selectClass = cn(inputClass, 'pr-6');

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex gap-1.5 rounded-md bg-hover p-2 text-sm text-danger">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}

function ServerStep({ onConnected }: { onConnected: (session: ConnectSession) => void }) {
  const [server, setServer] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onConnected(await unwrap(api.connect.check(server, token)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        The calendar shows dated rows from Workspace databases. In Workspace, an owner or admin
        makes an integration (Members → Integrations), copies its token, and connects the databases
        to it (a database's Share → Connections).
      </p>
      <Field
        label="Server address"
        hint="The address you open Workspace at, e.g. https://notes.example.com"
      >
        <input
          className={inputClass}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://notes.example.com"
          autoFocus
          spellCheck={false}
          required
        />
      </Field>
      <Field
        label="Integration token"
        hint="It starts with ntn_. It's kept encrypted on this computer."
      >
        <input
          className={inputClass}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </Field>
      {error && <ErrorLine message={error} />}
      <div className="flex justify-end">
        <Button variant="primary" type="submit" disabled={busy}>
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Connect
        </Button>
      </div>
    </form>
  );
}

function PickStep({
  session,
  onNext,
}: {
  session: ConnectSession;
  onNext: (picked: DatabaseChoice[]) => void;
}) {
  const [databases, setDatabases] = useState<DatabaseChoice[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const [attempt, setAttempt] = useState(0);
  const load = () => {
    setDatabases(null);
    setError(null);
    setAttempt((n) => n + 1);
  };
  useEffect(() => {
    let cancelled = false;
    unwrap(api.connect.databases(session.sessionId)).then(
      (list) => !cancelled && setDatabases(list),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [session.sessionId, attempt]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Connected as <span className="font-medium text-fg">{session.botName}</span>
        {session.workspaceName && <> in {session.workspaceName}</>}. Choose the databases to show:
      </p>
      {error && <ErrorLine message={error} />}
      {!databases && !error && <Loading label="Finding databases…" />}
      {databases && databases.length === 0 && (
        <div className="flex flex-col items-start gap-2 rounded-md bg-hover p-3 text-sm">
          <p>
            No databases are connected to this integration yet. In Workspace, open a database (or a
            page above it), choose Share → Connections, and add &ldquo;{session.botName}&rdquo;.
          </p>
          <Button onClick={load}>
            <RefreshCw className="size-4" aria-hidden />
            Look again
          </Button>
        </div>
      )}
      {databases && databases.length > 0 && (
        <ul className="flex flex-col" aria-label="Databases">
          {databases.map((db) => (
            <li key={db.id}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1.5 text-sm hover:bg-hover">
                <input
                  type="checkbox"
                  checked={picked.has(db.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(db.id);
                    else next.delete(db.id);
                    setPicked(next);
                  }}
                />
                {db.title}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={picked.size === 0}
          onClick={() => onNext(databases!.filter((d) => picked.has(d.id)))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

interface Setup {
  database: DatabaseChoice;
  schema: SchemaChoice | null;
  views: { id: string; name: string }[];
  error: string | null;
  draft: CalendarDraft | null;
}

function ConfigureStep({
  session,
  picked,
  onSaved,
}: {
  session: ConnectSession;
  picked: DatabaseChoice[];
  onSaved: () => void;
}) {
  const [setups, setSetups] = useState<Setup[]>(() =>
    picked.map((database) => ({ database, schema: null, views: [], error: null, draft: null })),
  );
  const [people, setPeople] = useState<{ id: string; name: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        picked.map(async (database, i): Promise<Setup> => {
          try {
            const [schema, views] = await Promise.all([
              unwrap(api.connect.schema(session.sessionId, database.id)),
              unwrap(api.connect.views(session.sessionId, database.id)),
            ]);
            const date = schema.properties.find((p) => p.type === 'date');
            const title = schema.properties.find((p) => p.type === 'title');
            return {
              database,
              schema,
              views,
              error: date ? null : 'This database has no date property, so it can’t be a calendar.',
              draft:
                date && title
                  ? {
                      databaseId: database.id,
                      viewId: null,
                      name: schema.title,
                      colour: COLOURS[i % COLOURS.length]!,
                      dateProperty: { id: date.id, name: date.name },
                      titleProperty: { id: title.id, name: title.name },
                      people: null,
                      colourBy: null,
                      reminder: DEFAULT_REMINDER,
                    }
                  : null,
            };
          } catch (e) {
            return { database, schema: null, views: [], error: (e as Error).message, draft: null };
          }
        }),
      );
      if (cancelled) return;
      setSetups(loaded);
      if (loaded.some((s) => s.schema?.properties.some((p) => p.type === 'people'))) {
        unwrap(api.connect.people(session.sessionId)).then(
          (list) => !cancelled && setPeople(list),
          () => !cancelled && setPeople([]),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [picked, session.sessionId]);

  const update = (i: number, patch: Partial<CalendarDraft>) =>
    setSetups((all) =>
      all.map((s, j) => (j === i && s.draft ? { ...s, draft: { ...s.draft, ...patch } } : s)),
    );

  const drafts = setups.map((s) => s.draft).filter((d): d is CalendarDraft => !!d);
  const loading = setups.some((s) => !s.schema && !s.error);
  const incomplete = drafts.some((d) => d.people && !d.people.personId);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await unwrap(api.connect.save(session.sessionId, drafts));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {loading && <Loading label="Reading the databases…" />}
      {setups.map((setup, i) => (
        <section
          key={setup.database.id}
          aria-label={setup.database.title}
          className="flex flex-col gap-3 rounded-lg border border-line p-3"
        >
          <h3 className="text-sm font-semibold">{setup.database.title}</h3>
          {setup.error && <ErrorLine message={setup.error} />}
          {setup.draft && setup.schema && (
            <DatabaseSetup
              draft={setup.draft}
              schema={setup.schema}
              views={setup.views}
              people={people}
              onChange={(patch) => update(i, patch)}
            />
          )}
        </section>
      ))}
      {error && <ErrorLine message={error} />}
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={loading || saving || drafts.length === 0 || incomplete}
          onClick={save}
        >
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {drafts.length > 1 ? `Add ${drafts.length} calendars` : 'Add calendar'}
        </Button>
      </div>
    </div>
  );
}

function DatabaseSetup({
  draft,
  schema,
  views,
  people,
  onChange,
}: {
  draft: CalendarDraft;
  schema: SchemaChoice;
  views: { id: string; name: string }[];
  people: { id: string; name: string }[] | null;
  onChange: (patch: Partial<CalendarDraft>) => void;
}) {
  const of = (type: string) => schema.properties.filter((p) => p.type === type);
  const dates = of('date');
  const peopleProps = of('people');
  const colourProps = schema.properties.filter((p) => p.type === 'select' || p.type === 'status');
  const ref = (id: string) => {
    const p = schema.properties.find((x) => x.id === id)!;
    return { id: p.id, name: p.name };
  };

  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="Calendar name">
        <input
          className={inputClass}
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
        />
      </Field>
      <Field label="Date property">
        <select
          className={selectClass}
          value={draft.dateProperty.id}
          onChange={(e) => onChange({ dateProperty: ref(e.target.value) })}
        >
          {dates.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      {views.length > 0 && (
        <Field label="Rows" hint="A calendar view shows only the rows its filter keeps.">
          <select
            className={selectClass}
            value={draft.viewId ?? ''}
            onChange={(e) => onChange({ viewId: e.target.value || null })}
          >
            <option value="">The whole database</option>
            {views.map((v) => (
              <option key={v.id} value={v.id}>
                View: {v.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Colour by">
        <select
          className={selectClass}
          value={draft.colourBy?.id ?? ''}
          onChange={(e) => onChange({ colourBy: e.target.value ? ref(e.target.value) : null })}
        >
          <option value="">The calendar’s colour</option>
          {colourProps.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Notify">
        <select
          className={selectClass}
          value={String(draft.reminder ?? 'none')}
          onChange={(e) =>
            onChange({ reminder: e.target.value === 'none' ? null : Number(e.target.value) })
          }
        >
          {REMINDER_CHOICES.map((minutes) => (
            <option key={String(minutes)} value={String(minutes ?? 'none')}>
              {reminderLabel(minutes)}
            </option>
          ))}
        </select>
      </Field>
      {peopleProps.length > 0 && (
        <Field label="Only mine" hint="Show only rows with you in a people property.">
          <select
            className={selectClass}
            value={draft.people?.id ?? ''}
            onChange={(e) =>
              onChange({
                people: e.target.value
                  ? { ...ref(e.target.value), personId: draft.people?.personId ?? '' }
                  : null,
              })
            }
          >
            <option value="">Everyone’s rows</option>
            {peopleProps.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {draft.people && (
        <Field label="I am">
          <select
            className={selectClass}
            value={draft.people.personId}
            onChange={(e) => onChange({ people: { ...draft.people!, personId: e.target.value } })}
          >
            <option value="" disabled>
              {people ? 'Choose yourself' : 'Loading people…'}
            </option>
            {(people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="col-span-2 flex items-center gap-2" role="radiogroup" aria-label="Colour">
        <span className="text-xs font-medium text-muted">Colour</span>
        {COLOURS.map((colour) => (
          <button
            type="button"
            key={colour}
            role="radio"
            aria-checked={draft.colour === colour}
            aria-label={colour}
            onClick={() => onChange({ colour })}
            style={colourVar(colour)}
            className={cn(
              'cal-swatch size-5 rounded-full',
              draft.colour === colour && 'ring-2 ring-fg ring-offset-2 ring-offset-menu',
            )}
          />
        ))}
      </div>
    </div>
  );
}
