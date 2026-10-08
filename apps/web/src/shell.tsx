import { Button, cn } from '@workspace/ui';
import { Cloud, KeyRound, Loader2, Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  ApiError,
  api,
  type InviteInfo,
  type Me,
  type RemoteWorkspace,
  type ServerInfo,
} from './api';

const input =
  'h-9 w-full rounded-md border border-line bg-transparent px-2.5 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';

/** A centered card on the page (sign-in, workspace picker). */
export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-sidebar px-4 pt-[12vh] text-fg">
      <div className="w-full max-w-sm rounded-xl bg-surface p-6 shadow-menu">
        <div className="mb-5 flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded bg-active text-sm font-semibold">
            W
          </span>
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-danger" data-testid="auth-error">
      {error}
    </p>
  ) : null;
}

/**
 * Sign in, or create an account (the first one on a new server becomes its admin).
 * From an invite link, it's for the invited address, with the invite filled in.
 */
export function SignIn({
  onSignedIn,
  invited,
}: {
  onSignedIn(): void;
  invited?: { token: string; email: string; title: string; intro: ReactNode };
}) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState(invited?.email ?? '');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState(
    () => invited?.token ?? new URLSearchParams(location.search).get('invite') ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<ServerInfo>('GET', '/api/auth/config').then(
      (next) => {
        setInfo(next);
        if (next.needsSetup || invite) setCreate(true);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (create) {
        await api('POST', '/api/auth/signup', {
          email,
          name,
          password,
          ...(invite ? { invite } : {}),
        });
      } else {
        await api('POST', '/api/auth/login', { email, password });
      }
      onSignedIn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) {
    return (
      <Card title="Workspace">
        {error ? <ErrorText error={error} /> : <Loader2 className="animate-spin text-muted" />}
      </Card>
    );
  }
  const canCreate = info.needsSetup || info.signup !== 'disabled' || !!invited;
  return (
    <Card title={invited?.title ?? (create ? 'Create your account' : 'Sign in')}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} data-testid="sign-in">
        {invited?.intro}
        {info.needsSetup && (
          <p className="text-sm text-muted">A new server: the first account becomes its admin.</p>
        )}
        {create && (
          <Field label="Name">
            <input
              className={input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              name="name"
              autoFocus
            />
          </Field>
        )}
        <Field label="Email">
          <input
            className={input}
            type="email"
            name="email"
            autoComplete="email"
            autoFocus={!create}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            className={input}
            type="password"
            name="password"
            autoComplete={create ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {create && info.signup === 'invite' && !info.needsSetup && !invited && (
          <Field label="Invite code">
            <input
              className={input}
              name="invite"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
          </Field>
        )}
        <ErrorText error={error} />
        <Button
          variant="primary"
          type="submit"
          className="h-9 justify-center"
          disabled={busy || !email || !password || (create && !name.trim())}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          {create ? 'Create account' : 'Sign in'}
        </Button>
        {info.providers.length > 0 && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            {info.providers.map((p) => (
              <a
                key={p.id}
                href={`/api/auth/oidc/${encodeURIComponent(p.id)}/start?client=web${invite ? `&invite=${encodeURIComponent(invite)}` : ''}`}
                className="flex h-9 items-center justify-center gap-2 rounded-md border border-line text-sm font-medium hover:bg-hover"
              >
                <KeyRound size={14} /> Continue with {p.name}
              </a>
            ))}
          </div>
        )}
        {canCreate && !info.needsSetup && (
          <button
            type="button"
            className="text-sm text-accent hover:underline"
            onClick={() => {
              setCreate(!create);
              setError(null);
            }}
          >
            {create ? 'I have an account' : 'Create an account'}
          </button>
        )}
      </form>
    </Card>
  );
}

/** Choose (or create) the workspace to open. */
export function WorkspacePicker({
  onOpen,
  onSignOut,
  email,
}: {
  onOpen(workspace: RemoteWorkspace): void;
  onSignOut(): void;
  email: string;
}) {
  const [list, setList] = useState<RemoteWorkspace[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api<{ workspaces: RemoteWorkspace[] }>('GET', '/api/workspaces').then(
      (r) => setList(r.workspaces),
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { workspace } = await api<{ workspace: RemoteWorkspace }>('POST', '/api/workspaces', {
        name: name.trim(),
      });
      onOpen(workspace);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Card title="Choose a workspace">
      <div className="flex flex-col gap-3" data-testid="workspace-picker">
        <p className="text-sm text-muted">Signed in as {email}.</p>
        {list === null && !error && <Loader2 className="animate-spin text-muted" />}
        {list && list.length > 0 && (
          <ul className="flex flex-col gap-1">
            {list.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => onOpen(w)}
                  className="flex h-10 w-full items-center gap-2 rounded-md border border-line px-3 text-left text-sm hover:bg-hover"
                >
                  <Cloud size={14} className="text-muted" />
                  <span className="flex-1 truncate font-medium">{w.name}</span>
                  <span className="text-xs text-faint">{w.role}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {list && list.length === 0 && (
          <p className="text-sm text-muted">
            No workspaces yet. Create one, or upload one from the desktop app (Sync).
          </p>
        )}
        <form className="flex gap-2" onSubmit={(e) => void create(e)}>
          <input
            className={cn(input, 'flex-1')}
            placeholder="New workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            name="workspace-name"
          />
          <Button variant="primary" type="submit" className="h-9" disabled={busy || !name.trim()}>
            <Plus size={14} /> Create
          </Button>
        </form>
        <ErrorText error={error} />
        <button
          type="button"
          className="self-start text-sm text-muted hover:underline"
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </Card>
  );
}

const ROLE_NAMES = { admin: 'an admin', member: 'a member', guest: 'a guest' } as const;

/**
 * An invite link (`/invite/<token>`): who invited you where. Signed out, you sign in or
 * create the account for the invited address; signed in as that address, you join.
 */
export function InviteScreen({
  token,
  invite,
  user,
  onSignedIn,
  onSignOut,
}: {
  token: string;
  /** Null: no such invite. */
  invite: InviteInfo | null;
  user: Me | null;
  onSignedIn(): void;
  onSignOut(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!invite) {
    return (
      <Card title="Invite not found">
        <p className="text-sm text-muted">
          This invite link isn’t valid. Check that you have the whole link, or ask for a new one.
        </p>
      </Card>
    );
  }
  const intro = (
    <p className="text-sm text-muted" data-testid="invite-intro">
      {invite.invitedBy ?? 'Someone'} invited <strong className="text-fg">{invite.email}</strong> to
      join <strong className="text-fg">{invite.workspace}</strong> as {ROLE_NAMES[invite.role]}.
    </p>
  );
  const title = `Join ${invite.workspace}`;
  const usedHere = invite.status === 'accepted' && user?.email === invite.email;
  if (invite.status !== 'valid' && !usedHere) {
    return (
      <Card title={title}>
        <p className="text-sm text-muted" data-testid="invite-status">
          {invite.status === 'expired'
            ? 'This invite has expired. Ask whoever invited you for a new one.'
            : invite.status === 'revoked'
              ? 'This invite was withdrawn.'
              : 'This invite has already been used.'}
        </p>
      </Card>
    );
  }
  if (!user) {
    // Signed in (or signed up) from the invite: join right away.
    const signedIn = () => {
      api<{ workspace: RemoteWorkspace }>(
        'POST',
        `/api/invites/${encodeURIComponent(token)}/accept`,
        {},
      ).then(
        ({ workspace }) => location.assign(`/w/${workspace.id}`),
        () => onSignedIn(),
      );
    };
    return <SignIn onSignedIn={signedIn} invited={{ token, email: invite.email, title, intro }} />;
  }
  if (user.email !== invite.email) {
    return (
      <Card title={title}>
        <div className="flex flex-col gap-3">
          {intro}
          <p className="text-sm text-danger" data-testid="invite-wrong-account">
            You’re signed in as {user.email}. Sign out, then open the link again to join as{' '}
            {invite.email}.
          </p>
          <Button className="h-9 justify-center" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </Card>
    );
  }
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await api<{ workspace: RemoteWorkspace }>(
        'POST',
        `/api/invites/${encodeURIComponent(token)}/accept`,
        {},
      );
      location.assign(`/w/${workspace.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Card title={title}>
      <div className="flex flex-col gap-3">
        {intro}
        <ErrorText error={error} />
        <Button
          variant="primary"
          className="h-9 justify-center"
          disabled={busy}
          onClick={() => void join()}
        >
          {busy && <Loader2 size={14} className="animate-spin" />}
          Join {invite.workspace}
        </Button>
      </div>
    </Card>
  );
}
