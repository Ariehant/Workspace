import type { WorkspaceRole } from '@workspace/core';
import { Avatar, Button, Dialog, DialogContent, IconButton, cn } from '@workspace/ui';
import { Check, Copy, Loader2, Mail, Trash2, UserMinus, Users, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ROLE_HINTS,
  ROLE_LABELS,
  avatarFromFile,
  parseEmails,
  type CreatedInvite,
  type GroupInfo,
  type InviteRole,
  type MemberInfo,
  type PendingInvite,
  type Profile,
  type TeamApi,
} from './team';

type Tab = 'members' | 'guests' | 'groups' | 'invites';

const input =
  'h-8 rounded-md border border-line bg-transparent px-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';
const select =
  'h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-60';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Settings → Members: who's in the workspace, invites, roles and groups. */
export function MembersDialog({
  team,
  onClose,
  onLeft,
}: {
  team: TeamApi;
  onClose(): void;
  /** Called after leaving the workspace. */
  onLeft(): void;
}) {
  const [tab, setTab] = useState<Tab>('members');
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  /** The signed-in account's id (the server's: the app's user may still be local). */
  const [me, setMe] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberInfo[] | null>(null);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const manager = role === 'owner' || role === 'admin';

  /** Everything the dialog shows, from the server. */
  const load = useCallback(async () => {
    const [list, profile] = await Promise.all([team.members(), team.me()]);
    const canManage = list.role === 'owner' || list.role === 'admin';
    const [g, i] = await Promise.all([
      team.groups(),
      canManage ? team.invites() : Promise.resolve({ invites: [] }),
    ]);
    return {
      me: profile.id,
      role: list.role,
      members: list.members,
      groups: g.groups,
      invites: i.invites,
    };
  }, [team]);
  const show = useCallback((data: Awaited<ReturnType<typeof load>>) => {
    setMe(data.me);
    setRole(data.role);
    setMembers(data.members);
    setGroups(data.groups);
    setInvites(data.invites);
  }, []);
  const reload = async () => {
    try {
      show(await load());
    } catch (e) {
      setError(errorText(e));
    }
  };
  useEffect(() => {
    let alive = true;
    load().then(
      (data) => alive && show(data),
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [load, show]);

  /** Run a change, then show the server's view of things. */
  const act = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  };

  const people = (members ?? []).filter((m) =>
    tab === 'guests' ? m.role === 'guest' : m.role !== 'guest',
  );
  const tabs: [Tab, string, number | null][] = [
    ['members', 'Members', (members ?? []).filter((m) => m.role !== 'guest').length],
    ['guests', 'Guests', (members ?? []).filter((m) => m.role === 'guest').length],
    ['groups', 'Groups', groups.length],
    ...(manager ? ([['invites', 'Invites', invites.length]] as [Tab, string, number][]) : []),
  ];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Members"
        className="top-[10vh] w-[min(680px,calc(100vw-32px))]"
        data-testid="members-dialog"
      >
        <div className="flex max-h-[75vh] flex-col gap-3 p-4 pt-2">
          {manager && <InviteForm team={team} onInvited={() => void reload()} />}
          <div role="tablist" aria-label="Members" className="flex gap-1 border-b border-line">
            {tabs.map(([id, label, count]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-2 pb-1.5 text-sm',
                  tab === id
                    ? 'border-fg font-medium text-fg'
                    : 'border-transparent text-muted hover:text-fg',
                )}
              >
                {label}
                {count !== null && count > 0 && <span className="ml-1 text-faint">{count}</span>}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger" data-testid="members-error">
              {error}
            </p>
          )}
          <div className="min-h-40 overflow-y-auto">
            {members === null && !error && <Loader2 className="m-4 animate-spin text-muted" />}
            {members !== null && (tab === 'members' || tab === 'guests') && (
              <PeopleList
                people={people}
                me={me}
                myRole={role}
                empty={tab === 'guests' ? 'No guests.' : 'No members.'}
                onRole={(id, next) => void act(() => team.setRole(id, next))}
                onRemove={(person) => {
                  const self = person.id === me;
                  const question = self
                    ? 'Leave this workspace? You’ll need a new invite to come back.'
                    : `Remove ${person.name} from this workspace?`;
                  if (!window.confirm(question)) return;
                  void act(async () => {
                    await team.remove(person.id);
                    if (self) onLeft();
                  });
                }}
              />
            )}
            {members !== null && tab === 'groups' && (
              <Groups groups={groups} members={members} manager={manager} act={act} team={team} />
            )}
            {tab === 'invites' && manager && (
              <Invites invites={invites} onRevoke={(id) => void act(() => team.revokeInvite(id))} />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RoleSelect({
  value,
  onChange,
  label,
  allowOwner,
  disabled,
}: {
  value: WorkspaceRole;
  onChange(role: WorkspaceRole): void;
  label: string;
  allowOwner: boolean;
  disabled?: boolean;
}) {
  const roles: WorkspaceRole[] = allowOwner
    ? ['owner', 'admin', 'member', 'guest']
    : ['admin', 'member', 'guest'];
  return (
    <select
      aria-label={label}
      className={select}
      value={value}
      disabled={disabled}
      title={ROLE_HINTS[value]}
      onChange={(e) => onChange(e.target.value as WorkspaceRole)}
    >
      {roles.map((r) => (
        <option key={r} value={r} title={ROLE_HINTS[r]}>
          {ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}

function InviteForm({ team, onInvited }: { team: TeamApi; onInvited(): void }) {
  const [text, setText] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ invites: CreatedInvite[]; skipped: string[] } | null>(null);
  const emails = parseEmails(text);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (emails.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setSent(await team.invite(emails, role));
      setText('');
      onInvited();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form className="flex gap-2" onSubmit={(e) => void submit(e)}>
        <input
          className={cn(input, 'min-w-0 flex-1')}
          placeholder="Emails, separated by commas"
          aria-label="Emails to invite"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label="Invite as"
          className={cn(select, 'h-8')}
          value={role}
          onChange={(e) => setRole(e.target.value as InviteRole)}
        >
          {(['admin', 'member', 'guest'] as const).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <Button
          variant="primary"
          type="submit"
          className="h-8"
          disabled={busy || emails.length === 0}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
          Invite
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {sent && (
        <div
          className="flex flex-col gap-1.5 rounded-md bg-hover p-2 text-sm"
          data-testid="invite-links"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-muted">
              {sent.invites.length === 0
                ? 'Everyone is already in the workspace.'
                : sent.invites.every((i) => i.emailed)
                  ? 'Invites sent by email. The links work once, for 7 days:'
                  : 'Send each person their link. It works once, for 7 days:'}
            </p>
            <IconButton label="Dismiss" size="sm" onClick={() => setSent(null)}>
              <X size={14} />
            </IconButton>
          </div>
          {sent.invites.map((invite) => (
            <InviteLink key={invite.id} invite={invite} />
          ))}
          {sent.skipped.length > 0 && (
            <p className="text-xs text-faint">Already members: {sent.skipped.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  );
}

function InviteLink({ invite }: { invite: CreatedInvite }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-40 shrink-0 truncate" title={invite.email}>
        {invite.email}
      </span>
      <input
        readOnly
        aria-label={`Invite link for ${invite.email}`}
        value={invite.link}
        onFocus={(e) => e.currentTarget.select()}
        className={cn(input, 'h-7 min-w-0 flex-1 font-mono text-xs')}
      />
      <Button
        className="h-7"
        onClick={() => {
          void navigator.clipboard?.writeText(invite.link).then(() => setCopied(true));
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

function PeopleList({
  people,
  me,
  myRole,
  empty,
  onRole,
  onRemove,
}: {
  people: MemberInfo[];
  me: string | null;
  myRole: WorkspaceRole | null;
  empty: string;
  onRole(id: string, role: WorkspaceRole): void;
  onRemove(person: MemberInfo): void;
}) {
  const manager = myRole === 'owner' || myRole === 'admin';
  if (people.length === 0) return <p className="px-1 py-3 text-sm text-faint">{empty}</p>;
  return (
    <ul className="flex flex-col" aria-label="People">
      {people.map((person) => {
        const self = person.id === me;
        // Only owners touch owners (and make new ones).
        const editable = manager && (myRole === 'owner' || person.role !== 'owner');
        return (
          <li
            key={person.id}
            data-testid="member-row"
            className="flex h-11 items-center gap-3 rounded-md px-1 hover:bg-hover"
          >
            <Avatar name={person.name} src={person.avatar} id={person.id} size={28} />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">
                {person.name}
                {self && <span className="ml-1 font-normal text-faint">(you)</span>}
                {person.disabled && <span className="ml-1 font-normal text-faint">(disabled)</span>}
              </div>
              <div className="truncate text-xs text-muted">{person.email}</div>
            </div>
            {editable ? (
              <RoleSelect
                label={`Role of ${person.name}`}
                value={person.role}
                allowOwner={myRole === 'owner'}
                onChange={(role) => onRole(person.id, role)}
              />
            ) : (
              <span className="text-sm text-muted" data-testid="member-role">
                {ROLE_LABELS[person.role]}
              </span>
            )}
            {(self || editable) && (
              <IconButton
                label={self ? 'Leave workspace' : `Remove ${person.name}`}
                size="sm"
                onClick={() => onRemove(person)}
              >
                <UserMinus size={14} />
              </IconButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Invites({ invites, onRevoke }: { invites: PendingInvite[]; onRevoke(id: string): void }) {
  if (invites.length === 0) {
    return <p className="px-1 py-3 text-sm text-faint">No pending invites.</p>;
  }
  return (
    <ul className="flex flex-col" aria-label="Pending invites">
      {invites.map((invite) => (
        <li
          key={invite.id}
          data-testid="invite-row"
          className="flex h-10 items-center gap-3 rounded-md px-1 hover:bg-hover"
        >
          <Mail size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1 truncate">{invite.email}</span>
          <span className="text-sm text-muted">{ROLE_LABELS[invite.role]}</span>
          <span className="w-36 text-right text-xs text-faint">
            Expires {new Date(invite.expiresAt).toLocaleDateString()}
          </span>
          <Button className="h-7" onClick={() => onRevoke(invite.id)}>
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Groups({
  groups,
  members,
  manager,
  team,
  act,
}: {
  groups: GroupInfo[];
  members: MemberInfo[];
  manager: boolean;
  team: TeamApi;
  act(change: () => Promise<unknown>): Promise<void>;
}) {
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const byId = new Map(members.map((m) => [m.id, m]));
  return (
    <div className="flex flex-col gap-2">
      {manager && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const next = name.trim();
            if (!next) return;
            setName('');
            void act(() => team.createGroup(next));
          }}
        >
          <input
            className={cn(input, 'flex-1')}
            placeholder="New group name"
            aria-label="New group name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" className="h-8" disabled={!name.trim()}>
            <Users size={14} /> Create group
          </Button>
        </form>
      )}
      {groups.length === 0 && (
        <p className="px-1 py-3 text-sm text-faint">
          No groups yet. Groups let you share pages with several people at once.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {groups.map((group) => (
          <li key={group.id} className="rounded-md border border-line" data-testid="group-row">
            <div className="flex h-10 items-center gap-2 px-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={open === group.id}
                onClick={() => setOpen(open === group.id ? null : group.id)}
              >
                <Users size={16} className="shrink-0 text-muted" />
                <span className="truncate font-medium">{group.name}</span>
                <span className="text-xs text-faint">
                  {group.members.length} {group.members.length === 1 ? 'person' : 'people'}
                </span>
              </button>
              {manager && (
                <>
                  <Button
                    className="h-7"
                    onClick={() => {
                      const next = window.prompt('Rename group', group.name)?.trim();
                      if (next && next !== group.name) {
                        void act(() => team.renameGroup(group.id, next));
                      }
                    }}
                  >
                    Rename
                  </Button>
                  <IconButton
                    label={`Delete ${group.name}`}
                    size="sm"
                    onClick={() => {
                      if (window.confirm(`Delete the group ${group.name}?`)) {
                        void act(() => team.deleteGroup(group.id));
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                </>
              )}
            </div>
            {open === group.id && (
              <div className="flex flex-col gap-1 border-t border-line p-2">
                {group.members.map((id) => {
                  const person = byId.get(id);
                  return (
                    <div key={id} className="flex h-8 items-center gap-2">
                      <Avatar name={person?.name ?? '?'} src={person?.avatar} id={id} />
                      <span className="flex-1 truncate">{person?.name ?? 'Former member'}</span>
                      {manager && (
                        <IconButton
                          label={`Remove ${person?.name ?? 'person'} from ${group.name}`}
                          size="sm"
                          onClick={() => void act(() => team.removeFromGroup(group.id, id))}
                        >
                          <X size={14} />
                        </IconButton>
                      )}
                    </div>
                  );
                })}
                {group.members.length === 0 && <p className="text-sm text-faint">Nobody yet.</p>}
                {manager && (
                  <select
                    aria-label={`Add to ${group.name}`}
                    className={cn(select, 'mt-1 self-start')}
                    value=""
                    onChange={(e) => {
                      const id = e.target.value;
                      if (id) void act(() => team.addToGroup(group.id, id));
                    }}
                  >
                    <option value="">Add a member…</option>
                    {members
                      .filter((m) => !group.members.includes(m.id))
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </select>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Your name and picture, shown in every workspace you're in. */
export function ProfileDialog({ team, onClose }: { team: TeamApi; onClose(): void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    team.me().then(
      (me) => {
        if (!alive) return;
        setProfile(me);
        setName(me.name);
      },
      (e: unknown) => alive && setError(errorText(e)),
    );
    return () => {
      alive = false;
    };
  }, [team]);

  const save = async (change: { name?: string; avatar?: string | null }) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setProfile(await team.updateMe(change));
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Your profile"
        className="w-[min(440px,calc(100vw-32px))]"
        data-testid="profile-dialog"
      >
        <div className="flex flex-col gap-4 p-4 pt-3">
          {!profile && !error && <Loader2 className="animate-spin text-muted" />}
          {profile && (
            <>
              <div className="flex items-center gap-4">
                <Avatar name={profile.name} src={profile.avatar} id={profile.id} size={64} />
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-2">
                    <Button className="h-7" disabled={busy} onClick={() => file.current?.click()}>
                      Upload picture
                    </Button>
                    {profile.avatar && (
                      <Button
                        className="h-7"
                        disabled={busy}
                        onClick={() => void save({ avatar: null })}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  <span className="text-xs text-muted">{profile.email}</span>
                </div>
                <input
                  ref={file}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  aria-label="Profile picture"
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    e.target.value = '';
                    if (!picked) return;
                    void avatarFromFile(picked).then(
                      (avatar) => save({ avatar }),
                      () => setError('That picture couldn’t be read.'),
                    );
                  }}
                />
              </div>
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (name.trim() && name.trim() !== profile.name) void save({ name: name.trim() });
                }}
              >
                <label className="flex flex-1 flex-col gap-1">
                  <span className="text-xs font-medium text-muted">Name</span>
                  <input
                    className={input}
                    value={name}
                    aria-label="Name"
                    onChange={(e) => {
                      setName(e.target.value);
                      setSaved(false);
                    }}
                  />
                </label>
                <Button
                  variant="primary"
                  type="submit"
                  className="h-8"
                  disabled={busy || !name.trim() || name.trim() === profile.name}
                >
                  Save
                </Button>
              </form>
              <p className="text-xs text-faint">
                Your name and picture show to everyone in the workspaces you’re in.
              </p>
            </>
          )}
          {saved && <p className="text-sm text-success">Saved.</p>}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
