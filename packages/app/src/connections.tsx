/**
 * Settings → Connections (Phase 8 N9): Google Drive on this computer. The owner's own Google
 * Cloud project provides the OAuth client and the Picker's key (unless the build brings them);
 * connecting signs in through the browser, and pages can then link Drive files.
 */
import type { GoogleState } from '@workspace/core';
import { Button } from '@workspace/ui';
import { HardDrive } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Platform } from './platform';

/** Why the last Drive pick couldn't happen (shown when Settings opens for it). */
let pickProblem: string | null = null;
export function setDrivePickProblem(problem: string | null): void {
  pickProblem = problem;
}

type Google = NonNullable<Platform['google']>;

const FIELD =
  'h-8 rounded-md border border-line bg-transparent px-2 outline-none focus:border-accent';

export function ConnectionsPanel({ google }: { google: Google }) {
  const [state, setState] = useState<GoogleState | null>(null);
  const [form, setForm] = useState({ clientId: '', clientSecret: '', apiKey: '', appId: '' });
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(() => {
    const problem = pickProblem;
    pickProblem = null;
    return problem;
  });

  const load = useCallback(() => {
    void google.state().then((next) => {
      setState(next);
      setForm((f) => ({ ...f, clientId: next.clientId, appId: next.appId }));
    });
  }, [google]);
  useEffect(() => {
    load();
    return google.onChange(load);
  }, [google, load]);

  if (!state) return <div data-testid="connections" />;
  const showForm = !state.fromEnvironment && (!state.configured || editing);

  const save = async () => {
    setBusy(true);
    setMessage(null);
    const result = await google.configure(form);
    setBusy(false);
    if ('error' in result) setMessage(result.error);
    else {
      setEditing(false);
      setForm((f) => ({ ...f, clientSecret: '', apiKey: '' }));
    }
  };

  const connect = async () => {
    setBusy(true);
    setMessage('Finish signing in in your browser…');
    const result = await google.connect();
    setBusy(false);
    setMessage('error' in result ? result.error : null);
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="connections">
      <section className="flex flex-col gap-3" aria-labelledby="google-drive-heading">
        <h3 id="google-drive-heading" className="flex items-center gap-2 font-medium">
          <HardDrive size={16} aria-hidden /> Google Drive
        </h3>
        <p className="text-muted">
          Link Drive files in a page (<kbd>/google drive</kbd>), picked with Google’s own Picker.
          Workspace sees only the files you pick, and keeps their name and details current.
        </p>

        {showForm ? (
          <form
            className="flex flex-col gap-2"
            aria-label="Google client"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <p className="text-muted">
              From your Google Cloud project (see “Google Drive” in the desktop guide): an OAuth
              client of type Desktop app, an API key for the Picker, and the project number.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">OAuth client ID</span>
              <input
                className={FIELD}
                value={form.clientId}
                onChange={(e) => setForm({ ...form, clientId: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">
                Client secret{state.hasSecret && ' (saved; leave empty to keep it)'}
              </span>
              <input
                className={FIELD}
                type="password"
                autoComplete="off"
                value={form.clientSecret}
                onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">
                Picker API key{state.hasApiKey && ' (saved; leave empty to keep it)'}
              </span>
              <input
                className={FIELD}
                type="password"
                autoComplete="off"
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Project number (app ID)</span>
              <input
                className={FIELD}
                inputMode="numeric"
                value={form.appId}
                onChange={(e) => setForm({ ...form, appId: e.target.value })}
              />
            </label>
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={busy || !form.clientId.trim()}>
                Save
              </Button>
              {state.configured && (
                <Button onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : state.email === null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void connect()} disabled={busy}>
              Connect Google Drive…
            </Button>
            {!state.fromEnvironment && (
              <Button onClick={() => setEditing(true)} disabled={busy}>
                Change the Google client…
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="google-account">
              Connected{state.email ? ` as ${state.email}` : ''}
            </span>
            <Button
              onClick={() => {
                setBusy(true);
                void google.disconnect().finally(() => setBusy(false));
              }}
              disabled={busy}
            >
              Disconnect
            </Button>
          </div>
        )}
        {state.email !== null && !state.secure && (
          <p className="text-xs text-muted">
            There’s no system keyring here, so the sign-in is kept without the OS’s encryption.
          </p>
        )}
        {message && (
          <p role="status" className="text-xs" data-testid="connections-message">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
