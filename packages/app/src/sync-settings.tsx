import { Button, Dialog, DialogContent, cn } from '@workspace/ui';
import {
  AlertTriangle,
  Cloud,
  CloudOff,
  CloudUpload,
  KeyRound,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { SyncInfo, SyncPlatform, SyncServerInfo } from './platform';

/** The live sync status from the host. */
export function useSyncInfo(sync: SyncPlatform | undefined): SyncInfo | null {
  const [info, setInfo] = useState<SyncInfo | null>(null);
  useEffect(() => {
    if (!sync) return;
    let alive = true;
    void sync.status().then((next) => alive && setInfo(next));
    const off = sync.onChange(setInfo);
    return () => {
      alive = false;
      off();
    };
  }, [sync]);
  return info;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** One line for the sidebar: what sync is doing now. */
export function syncLabel(info: SyncInfo): string {
  switch (info.state) {
    case 'off':
      return info.mode === 'account' ? 'Choose a workspace to sync' : 'Sync is off';
    case 'connecting':
      return 'Connecting…';
    case 'catching-up':
      return 'Syncing…';
    case 'live':
      if (info.pending > 0) return `Syncing ${plural(info.pending, 'change')}`;
      if (info.files > 0) return `Uploading ${plural(info.files, 'file')}`;
      return 'Synced';
    case 'offline':
      return info.pending > 0 ? `Offline · ${plural(info.pending, 'change')} to sync` : 'Offline';
    case 'unauthorized':
      return 'Signed out of sync';
    case 'error':
      return 'Sync error';
    case 'stopped':
      return 'Sync paused';
  }
}

function SyncIcon({ info, size = 14 }: { info: SyncInfo; size?: number }) {
  const busy =
    info.state === 'connecting' ||
    info.state === 'catching-up' ||
    (info.state === 'live' && (info.pending > 0 || info.files > 0));
  if (busy) return <RefreshCw size={size} className="animate-spin text-accent" />;
  if (info.state === 'live') return <Cloud size={size} className="text-success" />;
  if (info.state === 'unauthorized' || info.state === 'error') {
    return <AlertTriangle size={size} className="text-danger" />;
  }
  if (info.state === 'offline') return <CloudOff size={size} className="text-warning" />;
  return <CloudOff size={size} className="text-faint" />;
}

/** The sidebar's sync line: opens Settings → Sync. */
export function SyncIndicator({ info, onOpen }: { info: SyncInfo; onOpen(): void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="sync-indicator"
      data-state={info.state}
      title={info.reason ?? undefined}
      className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-sm text-muted hover:bg-hover"
    >
      <SyncIcon info={info} size={16} />
      <span className="min-w-0 flex-1 truncate text-left">{syncLabel(info)}</span>
    </button>
  );
}

const input =
  'h-8 w-full rounded-md border border-line bg-transparent px-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" data-testid="sync-error" className="text-sm text-danger">
      {error}
    </p>
  );
}

/** Settings → Sync: connect to a server, sign in, choose a workspace, then the status. */
export function SyncDialog({
  sync,
  info,
  onClose,
  onBackup,
}: {
  sync: SyncPlatform;
  info: SyncInfo;
  onClose(): void;
  onBackup(): void;
}) {
  const signedOut = info.mode === 'on' && info.state === 'unauthorized';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Sync"
        className="w-[min(520px,calc(100vw-32px))]"
        data-testid="sync-dialog"
      >
        <div className="flex flex-col gap-4 p-4 pt-2">
          {info.mode === 'off' && <SignIn sync={sync} />}
          {info.mode === 'account' && (
            <ChooseWorkspace sync={sync} info={info} onBackup={onBackup} onDone={onClose} />
          )}
          {info.mode === 'on' && (
            <>
              <Status sync={sync} info={info} />
              {signedOut && <SignIn sync={sync} server={info.server ?? undefined} />}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SignIn({ sync, server: known }: { sync: SyncPlatform; server?: string }) {
  const [address, setAddress] = useState(known ?? '');
  const [server, setServer] = useState<SyncServerInfo | null>(null);
  const [create, setCreate] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async (event?: FormEvent) => {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    const result = await sync.serverInfo(address);
    setBusy(false);
    if ('error' in result) return setError(result.error);
    setServer(result.ok);
    // A brand-new server: the first account made here becomes its admin.
    setCreate(result.ok.needsSetup);
  };
  // Signing in again (the session ended): the server is known, skip asking for it.
  useEffect(() => {
    if (!known) return;
    let alive = true;
    void sync.serverInfo(known).then((result) => {
      if (!alive) return;
      if ('error' in result) setError(result.error);
      else setServer(result.ok);
    });
    return () => {
      alive = false;
    };
  }, [known, sync]);

  const run = async (request: Parameters<SyncPlatform['signIn']>[0]) => {
    setBusy(true);
    setError(null);
    const result = await sync.signIn(request);
    setBusy(false);
    if ('error' in result) setError(result.error);
  };

  if (!server) {
    return (
      <form className="flex flex-col gap-3" onSubmit={connect}>
        <p className="text-muted">
          Keep this workspace on a server you run, and on every device you sign in on. Your pages
          stay on this computer too, and work offline.
        </p>
        <Field label="Server address">
          <input
            className={input}
            data-testid="sync-server"
            autoFocus
            placeholder="https://notes.example.com"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <div className="flex justify-end">
          <Button variant="primary" type="submit" disabled={busy || !address.trim()}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            Continue
          </Button>
        </div>
      </form>
    );
  }

  const canCreate = server.needsSetup || server.signup !== 'disabled';
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          create
            ? {
                kind: 'signup',
                server: server.server,
                email,
                name,
                password,
                invite: invite || undefined,
              }
            : { kind: 'password', server: server.server, email, password },
        );
      }}
    >
      <p className="text-muted">
        {create ? 'Create an account on ' : 'Sign in to '}
        <span className="font-medium text-fg">{server.server}</span>
        {server.needsSetup && ' (a new server: this account becomes its admin)'}
      </p>
      {create && (
        <Field label="Name">
          <input
            className={input}
            data-testid="sync-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      )}
      <Field label="Email">
        <input
          className={input}
          data-testid="sync-email"
          type="email"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <input
          className={input}
          data-testid="sync-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {create && server.signup === 'invite' && !server.needsSetup && (
        <Field label="Invite code">
          <input
            className={input}
            data-testid="sync-invite"
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
          />
        </Field>
      )}
      <ErrorText error={error} />
      <div className="flex items-center justify-between gap-2">
        {canCreate && !server.needsSetup ? (
          <button
            type="button"
            className="text-sm text-accent hover:underline"
            onClick={() => setCreate(!create)}
          >
            {create ? 'I have an account' : 'Create an account'}
          </button>
        ) : (
          <span />
        )}
        <Button
          variant="primary"
          type="submit"
          data-testid="sync-sign-in"
          disabled={busy || !email || !password || (create && !name.trim())}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {create ? 'Create account' : 'Sign in'}
        </Button>
      </div>
      {server.providers.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          {server.providers.map((provider) => (
            <Button
              key={provider.id}
              className="justify-center border border-line"
              disabled={busy}
              onClick={() =>
                void run({
                  kind: 'sso',
                  server: server.server,
                  provider: provider.id,
                  invite: invite || undefined,
                })
              }
            >
              <KeyRound size={14} />
              Continue with {provider.name}
            </Button>
          ))}
          {busy && (
            <p className="text-xs text-muted">Finish signing in in your browser, then come back.</p>
          )}
        </div>
      )}
    </form>
  );
}

function ChooseWorkspace({
  sync,
  info,
  onBackup,
  onDone,
}: {
  sync: SyncPlatform;
  info: SyncInfo;
  onBackup(): void;
  onDone(): void;
}) {
  const [remote, setRemote] = useState<{ id: string; name: string }[] | null>(null);
  const [choice, setChoice] = useState<string>('upload');
  const [name, setName] = useState('My workspace');
  const [replace, setReplace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sync.workspaces().then((result) => {
      if ('error' in result) setError(result.error);
      else setRemote(result.ok);
    });
  }, [sync]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const result = await sync.enable(
      choice === 'upload'
        ? { mode: 'upload', name }
        : { mode: replace ? 'replace' : 'merge', workspaceId: choice },
    );
    setBusy(false);
    if ('error' in result) setError(result.error);
    else onDone();
  };

  const option = (value: string, title: ReactNode, detail: ReactNode, testId: string) => (
    <label
      data-testid={testId}
      className={cn(
        'flex cursor-pointer gap-3 rounded-lg border p-3',
        choice === value ? 'border-accent bg-accent/5' : 'border-line hover:bg-hover',
      )}
    >
      <input
        type="radio"
        name="sync-choice"
        className="mt-1"
        checked={choice === value}
        onChange={() => setChoice(value)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted">{detail}</span>
      </span>
    </label>
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted">
        Signed in as <span className="font-medium text-fg">{info.account?.email}</span> on{' '}
        {info.server}. What should this device sync?
      </p>
      {option(
        'upload',
        <span className="flex items-center gap-2">
          <CloudUpload size={14} /> Upload this workspace
        </span>,
        choice === 'upload' ? (
          <input
            className={cn(input, 'mt-1')}
            data-testid="sync-workspace-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          'Creates a workspace on the server with everything on this device.'
        ),
        'sync-upload',
      )}
      {remote === null && !error && (
        <p className="flex items-center gap-2 text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading the server’s workspaces…
        </p>
      )}
      {remote?.map((w) =>
        option(
          w.id,
          <span className="flex items-center gap-2">
            <Cloud size={14} /> {w.name}
          </span>,
          'Use this workspace from the server on this device.',
          `sync-remote-${w.name}`,
        ),
      )}
      {choice !== 'upload' && (
        <div className="flex flex-col gap-2 rounded-lg bg-hover p-3 text-xs">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="sync-join"
              checked={!replace}
              onChange={() => setReplace(false)}
            />
            <span>
              <span className="font-medium">Merge with this device’s pages.</span> Both sets of
              pages end up on every device.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="sync-join"
              data-testid="sync-replace"
              checked={replace}
              onChange={() => setReplace(true)}
            />
            <span>
              <span className="font-medium">Replace this device’s pages</span> with the server’s.
              The current ones are set aside in the data folder, and the app restarts.
            </span>
          </label>
          <button
            type="button"
            className="self-start text-accent hover:underline"
            onClick={onBackup}
          >
            Back up this device first…
          </button>
        </div>
      )}
      <ErrorText error={error} />
      <div className="flex items-center justify-between">
        <Button onClick={() => void sync.disable()}>Sign out</Button>
        <Button
          variant="primary"
          data-testid="sync-start"
          disabled={busy || (choice === 'upload' && !name.trim())}
          onClick={() => void start()}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Start syncing
        </Button>
      </div>
    </div>
  );
}

function Status({ sync, info }: { sync: SyncPlatform; info: SyncInfo }) {
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const rows: [string, ReactNode][] = [
    ['Server', info.server],
    ['Account', info.account ? `${info.account.name} (${info.account.email})` : '—'],
    ['Workspace', info.workspace?.name],
    ['Changes to send', info.pending],
    ['Files to upload', info.files],
    ['Last synced', info.lastSyncedAt ? new Date(info.lastSyncedAt).toLocaleString() : 'Not yet'],
  ];
  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex items-center gap-2 rounded-lg bg-hover p-3"
        data-testid="sync-status"
        data-state={info.state}
      >
        <SyncIcon info={info} size={18} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{syncLabel(info)}</span>
          {info.reason && <span className="text-xs text-muted">{info.reason}</span>}
          {info.retryAt && info.retryAt > now && (
            <span className="text-xs text-muted">
              Retrying in {Math.ceil((info.retryAt - now) / 1000)} s
            </span>
          )}
        </div>
        {(info.state === 'offline' || info.state === 'error') && (
          <Button onClick={() => sync.retry()}>Retry now</Button>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted">{label}</dt>
            <dd
              className="min-w-0 truncate"
              data-testid={`sync-${label.toLowerCase().replace(/ /g, '-')}`}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {!info.secureStorage && (
        <p className="text-xs text-warning">
          No system keyring was found, so the sign-in is stored without encryption on this computer.
        </p>
      )}
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        {confirm ? (
          <>
            <span className="mr-auto self-center text-xs text-muted">
              Stop syncing and sign out? Your pages stay on this device.
            </span>
            <Button onClick={() => setConfirm(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="sync-stop-confirm"
              onClick={() => void sync.disable()}
            >
              Stop syncing
            </Button>
          </>
        ) : (
          <Button data-testid="sync-stop" onClick={() => setConfirm(true)}>
            Stop syncing
          </Button>
        )}
      </div>
    </div>
  );
}
