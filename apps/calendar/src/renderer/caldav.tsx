/**
 * Connecting a CalDAV account (HANDOFF.md 5): Nextcloud, Fastmail, Radicale, iCloud. The
 * server's address, the username and an app password, then the account's calendars to show.
 */
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import type { CalDavConnect } from '../shared/ipc';
import { api, colourVar, unwrap } from './api';

const inputClass =
  'h-8 w-full rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';

export function CalDavDialog({
  accountId,
  onClose,
}: {
  /** Add calendars of this account (already connected), or connect one. */
  accountId: string | null;
  onClose: () => void;
}) {
  const [session, setSession] = useState<CalDavConnect | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!accountId);

  useEffect(() => {
    if (!accountId) return;
    unwrap(api.caldav.account(accountId)).then(
      (s) => {
        setSession(s);
        setLoading(false);
      },
      (e: Error) => {
        setError(e.message);
        setLoading(false);
      },
    );
  }, [accountId]);

  const close = () => {
    if (session) void api.caldav.cancel(session.sessionId);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={accountId ? 'Add CalDAV calendars' : 'Connect CalDAV'}
        className="top-[8vh] w-[min(540px,calc(100vw-32px))]"
      >
        <div className="flex max-h-[78vh] flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4">
          {error && (
            <p role="alert" className="flex gap-1.5 rounded-md bg-hover p-2 text-sm text-danger">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
          {loading && (
            <p className="flex items-center gap-2 py-6 text-sm text-muted" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Reading your calendars…
            </p>
          )}
          {!session && !loading && !accountId && (
            <ServerForm onConnected={setSession} onError={setError} />
          )}
          {session && <PickCalendars session={session} onSaved={onClose} onError={setError} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ServerForm({
  onConnected,
  onError,
}: {
  onConnected: (session: CalDavConnect) => void;
  onError: (message: string | null) => void;
}) {
  const [server, setServer] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onError(null);
    try {
      onConnected(await unwrap(api.caldav.connect(server, username, password)));
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Calendars on a CalDAV server (Nextcloud, Fastmail, Radicale, iCloud, and others) show here
        and can be changed here. Use an <em>app password</em> made for this calendar in your
        account&apos;s security settings, rather than your main password.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Server address</span>
        <input
          className={inputClass}
          value={server}
          onChange={(e) => setServer(e.target.value)}
          placeholder="https://cloud.example.com"
          spellCheck={false}
          autoFocus
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">Username</span>
        <input
          className={inputClass}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          spellCheck={false}
          autoComplete="username"
          required
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">App password</span>
        <input
          className={inputClass}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !server.trim() || !username.trim() || !password}
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Connect
        </Button>
      </div>
    </form>
  );
}

function PickCalendars({
  session,
  onSaved,
  onError,
}: {
  session: CalDavConnect;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [chosen, setChosen] = useState(
    () =>
      new Set(
        session.calendars
          .filter((c) => c.added || !session.calendars.some((x) => x.added))
          .map((c) => c.url),
      ),
  );
  const [busy, setBusy] = useState(false);
  const toAdd = session.calendars.filter((c) => chosen.has(c.url) && !c.added);
  const existing = session.calendars.some((c) => c.added);

  const save = async () => {
    setBusy(true);
    try {
      await unwrap(api.caldav.save(session.sessionId, [...chosen]));
      onSaved();
    } catch (e) {
      onError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Connected as <strong className="text-fg">{session.name}</strong>. Choose the calendars to
        show.
      </p>
      {session.calendars.length === 0 && (
        <p className="text-sm text-muted">This account has no event calendars.</p>
      )}
      <ul className="flex flex-col gap-1" aria-label="CalDAV calendars">
        {session.calendars.map((c) => (
          <li key={c.url}>
            <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-hover">
              <input
                type="checkbox"
                checked={chosen.has(c.url)}
                disabled={c.added}
                onChange={(e) =>
                  setChosen((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(c.url);
                    else next.delete(c.url);
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
              {c.added && <span className="text-xs text-faint">Shown</span>}
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
