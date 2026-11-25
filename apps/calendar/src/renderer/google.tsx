/**
 * Connecting Google Calendar (HANDOFF.md 4): the OAuth client if none is set up yet, then
 * "Sign in with Google" (in the system browser), then the account's calendars to show.
 */
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { GoogleConnect, GoogleSetup } from '../shared/ipc';
import { api, colourVar, unwrap } from './api';

interface Props {
  setup: GoogleSetup;
  /** Add calendars of this account (already signed in), or sign in to one. */
  accountId: string | null;
  onClose: () => void;
}

type Step =
  | { kind: 'start' }
  | { kind: 'waiting' }
  | { kind: 'loading' }
  | { kind: 'pick'; connect: GoogleConnect };

const inputClass =
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';

export function GoogleDialog({ setup, accountId, onClose }: Props) {
  const [step, setStep] = useState<Step>(accountId ? { kind: 'loading' } : { kind: 'start' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId) return;
    unwrap(api.google.account(accountId)).then(
      (connect) => setStep({ kind: 'pick', connect }),
      (e: Error) => {
        setError(e.message);
        setStep({ kind: 'start' });
      },
    );
  }, [accountId]);

  const close = () => {
    if (step.kind === 'waiting') void api.google.cancel();
    if (step.kind === 'pick') void api.google.cancel(step.connect.sessionId);
    onClose();
  };

  const signIn = async () => {
    setError(null);
    setStep({ kind: 'waiting' });
    try {
      setStep({ kind: 'pick', connect: await unwrap(api.google.signIn()) });
    } catch (e) {
      setError((e as Error).message);
      setStep({ kind: 'start' });
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={accountId ? 'Add Google calendars' : 'Connect Google Calendar'}
        className="top-[8vh] w-[min(560px,calc(100vw-32px))]"
      >
        <div className="flex max-h-[78vh] flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4">
          {error && (
            <p role="alert" className="flex gap-1.5 rounded-md bg-hover p-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          {step.kind === 'start' &&
            (setup.configured ? (
              <>
                <p className="text-sm text-muted">
                  Your browser opens Google&apos;s sign-in page. The calendar asks to see your
                  calendars and to read and change their events; it keeps the sign-in on this
                  computer only.
                </p>
                <div className="flex justify-end">
                  <Button variant="primary" onClick={() => void signIn()}>
                    Sign in with Google
                  </Button>
                </div>
              </>
            ) : (
              <ClientForm onSaved={() => setError(null)} onError={setError} />
            ))}
          {step.kind === 'waiting' && (
            <div className="flex flex-col gap-3" role="status">
              <p className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Finish signing in in your browser…
              </p>
              <div className="flex justify-end">
                <Button onClick={() => void api.google.cancel()}>Cancel</Button>
              </div>
            </div>
          )}
          {step.kind === 'loading' && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Reading your calendars…
            </p>
          )}
          {step.kind === 'pick' && (
            <PickCalendars connect={step.connect} onSaved={onClose} onError={setError} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The owner's own OAuth client (a Google Cloud "Desktop app" client). */
export function ClientForm({
  onSaved,
  onError,
  setup,
}: {
  onSaved: () => void;
  onError: (message: string) => void;
  setup?: GoogleSetup;
}) {
  const [clientId, setClientId] = useState(setup?.clientId ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await unwrap(api.google.setClient(clientId, secret));
      setSecret('');
      onSaved();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        The calendar signs in with your own Google Cloud project&apos;s OAuth client. In the Google
        Cloud console, turn on the Google Calendar API, set up the consent screen, and make an OAuth
        client of type <em>Desktop app</em>; then paste its ID and secret here.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">OAuth client ID</span>
        <input
          className={inputClass}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="1234-abc.apps.googleusercontent.com"
          spellCheck={false}
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Client secret</span>
        <input
          className={inputClass}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={setup?.hasSecret ? 'Saved (leave empty to keep it)' : ''}
          spellCheck={false}
        />
      </label>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !clientId.trim()}>
          Save client
        </Button>
      </div>
    </form>
  );
}

function PickCalendars({
  connect,
  onSaved,
  onError,
}: {
  connect: GoogleConnect;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  // The account's own calendar to start with (or what's shown already).
  const [chosen, setChosen] = useState(
    () =>
      new Set(
        connect.calendars
          .filter((c) => c.added || (c.primary && !connect.calendars.some((x) => x.added)))
          .map((c) => c.googleId),
      ),
  );
  const [busy, setBusy] = useState(false);
  const toAdd = connect.calendars.filter((c) => chosen.has(c.googleId) && !c.added);
  // An account already here (signed in again): saving keeps the new sign-in.
  const existing = connect.calendars.some((c) => c.added);

  const save = async () => {
    setBusy(true);
    try {
      await unwrap(api.google.save(connect.sessionId, [...chosen]));
      onSaved();
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Signed in as <strong className="text-fg">{connect.email}</strong>. Choose the calendars to
        show.
      </p>
      <ul className="flex flex-col gap-1" aria-label="Google calendars">
        {connect.calendars.map((c) => (
          <li key={c.googleId}>
            <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-hover">
              <input
                type="checkbox"
                checked={chosen.has(c.googleId)}
                disabled={c.added}
                onChange={(e) =>
                  setChosen((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(c.googleId);
                    else next.delete(c.googleId);
                    return next;
                  })
                }
              />
              <span
                style={colourVar(c.colour ?? 'blue')}
                className="cal-swatch size-3 shrink-0 rounded-full"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs text-faint">
                {c.added
                  ? 'Shown'
                  : c.accessRole === 'reader'
                    ? 'View only'
                    : c.accessRole === 'freeBusyReader'
                      ? 'Free/busy only'
                      : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={busy || (toAdd.length === 0 && !existing)}
          onClick={() => void save()}
        >
          {toAdd.length > 1
            ? `Add ${toAdd.length} calendars`
            : toAdd.length === 1
              ? 'Add calendar'
              : 'Done'}
        </Button>
      </div>
    </div>
  );
}
