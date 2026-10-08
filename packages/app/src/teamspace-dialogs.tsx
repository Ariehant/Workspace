/**
 * Teamspaces: making one, its settings (name, icon, description, who can find it, its
 * members), and finding and joining the workspace's others.
 */
import { Avatar, Button, Dialog, DialogContent, IconButton } from '@workspace/ui';
import { Loader2, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  SCOPE_ROLE_LABELS,
  type AccessEntry,
  type GroupInfo,
  type MemberInfo,
  type ScopeDetails,
  type ScopeRole,
  type ScopeVisibility,
  type TeamApi,
  type TeamspaceListing,
} from './team';

const input =
  'h-8 rounded-md border border-line bg-transparent px-2 text-sm text-fg outline-none placeholder:text-faint focus:border-accent';
const select =
  'h-7 rounded-md border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-60';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const VISIBILITY_LABELS: Record<ScopeVisibility, string> = {
  open: 'Open: anyone in the workspace can join',
  closed: 'Closed: anyone can see it, members add people',
  private: 'Private: only its members see it',
};

const ROLES: ScopeRole[] = ['full', 'edit', 'comment', 'view'];

/** Make a teamspace. */
export function NewTeamspaceDialog({
  team,
  onClose,
  onCreated,
}: {
  team: TeamApi;
  onClose(): void;
  onCreated(scope: ScopeDetails): void;
}) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<ScopeVisibility>('open');
  const [everyone, setEveryone] = useState<ScopeRole | 'none'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { scope } = await team.createTeamspace({
        name: name.trim(),
        icon: icon.trim() || null,
        description: description.trim(),
        visibility,
        everyone: everyone === 'none' ? null : everyone,
      });
      onCreated(scope);
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="New teamspace" data-testid="new-teamspace-dialog">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 p-4 pt-3">
          <div className="flex gap-2">
            <input
              aria-label="Teamspace icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="🚀"
              maxLength={8}
              className={`${input} w-12 text-center`}
            />
            <input
              aria-label="Teamspace name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
              maxLength={100}
              autoFocus
              className={`${input} flex-1`}
            />
          </div>
          <textarea
            aria-label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this teamspace is for (optional)"
            maxLength={1000}
            rows={2}
            className={`${input} h-auto py-1.5`}
          />
          <label className="flex items-center gap-2 text-sm">
            <span className="w-40 text-muted">Who can find it</span>
            <select
              aria-label="Who can find it"
              value={visibility}
              onChange={(e) => setVisibility(e.target.value as ScopeVisibility)}
              className={`${select} flex-1`}
            >
              {(Object.keys(VISIBILITY_LABELS) as ScopeVisibility[]).map((v) => (
                <option key={v} value={v}>
                  {VISIBILITY_LABELS[v]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="w-40 text-muted">Everyone in the workspace</span>
            <select
              aria-label="Everyone in the workspace"
              value={everyone}
              onChange={(e) => setEveryone(e.target.value as ScopeRole | 'none')}
              className={`${select} flex-1`}
            >
              <option value="none">Only people added or joining</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {SCOPE_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
              {busy && <Loader2 size={14} className="animate-spin" />}
              Create teamspace
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A principal's name and picture, for access lists. */
export function usePrincipals(team: TeamApi) {
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  useEffect(() => {
    let alive = true;
    void team
      .members()
      .then((m) => alive && setMembers(m.members))
      .catch(() => {});
    void team
      .groups()
      .then((g) => alive && setGroups(g.groups))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [team]);
  const describe = useCallback(
    (principal: string) => {
      if (principal === 'workspace')
        return { name: 'Everyone in the workspace', avatar: null, id: principal };
      if (principal.startsWith('group:')) {
        const group = groups.find((g) => `group:${g.id}` === principal);
        return { name: group ? `${group.name} (group)` : 'A group', avatar: null, id: principal };
      }
      const member = members.find((m) => `user:${m.id}` === principal);
      return { name: member?.name ?? 'Someone', avatar: member?.avatar ?? null, id: principal };
    },
    [members, groups],
  );
  return { members, groups, describe };
}

/** One person, group or everyone, with their role (changeable with full access). */
export function AccessRow({
  entry,
  name,
  avatar,
  canChange,
  note,
  onRole,
  onRemove,
}: {
  entry: AccessEntry;
  name: string;
  avatar: string | null;
  canChange: boolean;
  note?: string;
  onRole(role: ScopeRole): void;
  onRemove(): void;
}) {
  return (
    <li className="flex h-9 items-center gap-2" data-testid="access-row">
      <Avatar id={entry.principal} name={name} src={avatar} size={22} />
      <span className="min-w-0 flex-1 truncate">
        {name}
        {note && <span className="ml-1.5 text-xs text-faint">{note}</span>}
      </span>
      <select
        aria-label={`Access for ${name}`}
        value={entry.role}
        disabled={!canChange}
        onChange={(e) => onRole(e.target.value as ScopeRole)}
        className={select}
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {SCOPE_ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      {canChange && (
        <IconButton label={`Remove ${name}`} size="sm" onClick={onRemove}>
          <Trash2 size={14} />
        </IconButton>
      )}
    </li>
  );
}

/** A teamspace's settings and members. */
export function TeamspaceSettingsDialog({
  team,
  scopeId,
  onClose,
}: {
  team: TeamApi;
  scopeId: string;
  onClose(): void;
}) {
  const [scope, setScope] = useState<ScopeDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const { members, describe } = usePrincipals(team);

  const load = useCallback(async () => {
    const { scopes } = await team.scopes();
    const found = scopes.find((s) => s.id === scopeId);
    if (!found) throw new Error('This teamspace is gone, or you’re no longer in it.');
    return found;
  }, [team, scopeId]);
  const reload = useCallback(
    () => load().then(setScope, (e: unknown) => setError(errorText(e))),
    [load],
  );
  useEffect(() => void reload(), [reload]);

  const act = async (change: () => Promise<unknown>) => {
    setError(null);
    try {
      await change();
    } catch (e) {
      setError(errorText(e));
    }
    await reload();
  };

  const full = scope?.role === 'full';
  const entries = scope?.access ?? [];
  const candidates = members.filter(
    (m) => m.role !== 'guest' && !entries.some((e) => e.principal === `user:${m.id}`),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={scope ? `${scope.icon ? `${scope.icon} ` : ''}${scope.name}` : 'Teamspace'}
        data-testid="teamspace-settings"
      >
        {!scope ? (
          <div className="p-4 text-sm text-muted">{error ?? 'Loading…'}</div>
        ) : (
          <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto p-4 pt-3">
            <div className="flex gap-2">
              <input
                aria-label="Teamspace icon"
                defaultValue={scope.icon ?? ''}
                disabled={!full}
                maxLength={8}
                className={`${input} w-12 text-center`}
                onBlur={(e) => {
                  const icon = e.target.value.trim() || null;
                  if (icon !== scope.icon) void act(() => team.updateScope(scope.id, { icon }));
                }}
              />
              <input
                aria-label="Teamspace name"
                defaultValue={scope.name}
                disabled={!full}
                maxLength={100}
                className={`${input} flex-1`}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== scope.name)
                    void act(() => team.updateScope(scope.id, { name }));
                }}
              />
            </div>
            <textarea
              aria-label="Description"
              defaultValue={scope.description}
              disabled={!full}
              rows={2}
              maxLength={1000}
              className={`${input} h-auto py-1.5`}
              onBlur={(e) => {
                const description = e.target.value.trim();
                if (description !== scope.description)
                  void act(() => team.updateScope(scope.id, { description }));
              }}
            />
            <label className="flex items-center gap-2 text-sm">
              <span className="w-32 text-muted">Who can find it</span>
              <select
                aria-label="Who can find it"
                value={scope.visibility}
                disabled={!full}
                onChange={(e) =>
                  void act(() =>
                    team.updateScope(scope.id, { visibility: e.target.value as ScopeVisibility }),
                  )
                }
                className={`${select} flex-1`}
              >
                {(Object.keys(VISIBILITY_LABELS) as ScopeVisibility[]).map((v) => (
                  <option key={v} value={v}>
                    {VISIBILITY_LABELS[v]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <span className="w-32 text-muted">Joining gives</span>
              <select
                aria-label="Joining gives"
                value={scope.joinRole}
                disabled={!full}
                onChange={(e) =>
                  void act(() =>
                    team.updateScope(scope.id, { joinRole: e.target.value as ScopeRole }),
                  )
                }
                className={`${select} flex-1`}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {SCOPE_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-1 text-xs font-medium text-muted">Members</div>
            {full && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!adding) return;
                  void act(() => team.setAccess(scope.id, `user:${adding}`, 'edit'));
                  setAdding('');
                }}
              >
                <select
                  aria-label="Add a member"
                  value={adding}
                  onChange={(e) => setAdding(e.target.value)}
                  className={`${select} h-8 flex-1`}
                >
                  <option value="">Add someone…</option>
                  {candidates.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name} ({m.email})
                    </option>
                  ))}
                </select>
                <Button type="submit" variant="primary" disabled={!adding}>
                  Add
                </Button>
              </form>
            )}
            <ul>
              {entries.map((entry) => {
                const who = describe(entry.principal);
                return (
                  <AccessRow
                    key={entry.principal}
                    entry={entry}
                    name={who.name}
                    avatar={who.avatar}
                    canChange={full}
                    onRole={(role) =>
                      void act(() => team.setAccess(scope.id, entry.principal, role))
                    }
                    onRemove={() => void act(() => team.setAccess(scope.id, entry.principal, null))}
                  />
                );
              })}
            </ul>
            <p className="text-xs text-faint">
              Workspace owners and admins have full access to every teamspace.
            </p>
            {error && <p className="text-sm text-red-600">{error}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The workspace's teamspaces, to join the open ones. */
export function BrowseTeamspacesDialog({ team, onClose }: { team: TeamApi; onClose(): void }) {
  const [list, setList] = useState<TeamspaceListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(
    () =>
      team.teamspaces().then(
        (r) => setList(r.teamspaces),
        (e: unknown) => setError(errorText(e)),
      ),
    [team],
  );
  useEffect(() => void reload(), [reload]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Teamspaces" data-testid="browse-teamspaces">
        <div className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto p-4 pt-3">
          {!list && <p className="text-sm text-muted">{error ?? 'Loading…'}</p>}
          {list?.length === 0 && <p className="text-sm text-muted">No teamspaces yet.</p>}
          {list?.map((t) => (
            <div
              key={t.id}
              data-testid="teamspace-listing"
              className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded bg-active text-sm">
                {t.icon ?? t.name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{t.name}</div>
                <div className="truncate text-xs text-muted">
                  {t.description ||
                    (t.everyone ? 'Everyone in the workspace' : `${t.members} members`)}
                </div>
              </div>
              {t.role ? (
                <span className="text-xs text-muted">Joined</span>
              ) : t.visibility === 'open' ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void team
                      .joinTeamspace(t.id)
                      .then(reload, (e: unknown) => setError(errorText(e)))
                  }
                >
                  Join
                </Button>
              ) : (
                <span className="text-xs text-muted">Ask to be added</span>
              )}
            </div>
          ))}
          {list && error && <p className="text-sm text-red-600">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
