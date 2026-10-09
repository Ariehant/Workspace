/**
 * Share a page: invite people or groups with a role, see who has access and why, and
 * the page's general access. Sharing a page that has the access of where it is (a
 * teamspace, your private pages) first makes it its own scope, which keeps that access
 * (inherited) and adds the people invited.
 */
import { getPage, getPagesMap, pageUrl, type Forest, type PageId } from '@workspace/core';
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { Check, Link } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { sectionName } from './scope-actions';
import { AccessRow, usePrincipals } from './teamspace-dialogs';
import {
  SCOPE_ROLE_LABELS,
  type IntegrationInfo,
  type ScopeDetails,
  type ScopeRole,
  type TeamApi,
} from './team';
import { PublishSection } from './publish-section';

const select =
  'h-8 rounded-md border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-60';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ROLES: ScopeRole[] = ['full', 'edit', 'comment', 'view'];
/** A database also offers "can edit content" (its rows, not its properties or views). */
const DATABASE_ROLES: ScopeRole[] = ['full', 'edit', 'content', 'comment', 'view'];

export function ShareDialog({
  team,
  forest,
  pageId,
  onClose,
}: {
  team: TeamApi;
  forest: Forest;
  pageId: PageId;
  onClose(): void;
}) {
  const [scopes, setScopes] = useState<ScopeDetails[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [principal, setPrincipal] = useState('');
  const [role, setRole] = useState<ScopeRole>('edit');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const { members, groups, describe: describePerson } = usePrincipals(team);
  const [integrations, setIntegrations] = useState<IntegrationInfo[]>([]);
  const [connection, setConnection] = useState('');
  const [connectionRole, setConnectionRole] = useState<ScopeRole>('edit');
  useEffect(() => {
    let alive = true;
    team.integrations().then(
      (r) => alive && setIntegrations(r.integrations),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [team]);
  const bots = new Map(integrations.map((i) => [`user:${i.id}`, i]));
  const describe = (principal: string) => {
    const bot = bots.get(principal);
    return bot ? { name: bot.name, avatar: null, id: principal } : describePerson(principal);
  };

  const reload = useCallback(
    () =>
      team.scopes().then(
        (r) => setScopes(r.scopes),
        (e: unknown) => setError(errorText(e)),
      ),
    [team],
  );
  useEffect(() => void reload(), [reload]);

  const page = getPage(forest, pageId);
  const roles = page?.kind === 'database' ? DATABASE_ROLES : ROLES;
  const tree = forest.treeOf(pageId);
  const here = scopes?.find((s) => s.id === tree?.info.scope) ?? null;
  // Shared on its own: the top page of its own scope (its parent is somewhere else).
  const parentId = tree ? getPagesMap(tree.doc).get(pageId)?.get('parentId') : null;
  const isTop = !parentId || !getPagesMap(tree!.doc).has(parentId as string);
  const own = here && here.kind === 'shared' && isTop ? here : null;
  const parent = own?.parentId ? (scopes?.find((s) => s.id === own.parentId) ?? null) : null;
  const canShare = here?.role === 'full';
  const entries = (own ?? here)?.access ?? [];
  const taken = new Set(entries.map((e) => e.principal));

  const act = async (change: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await change();
    } catch (e) {
      setError(errorText(e));
    }
    setBusy(false);
    await reload();
  };

  const invite = () =>
    act(async () => {
      if (!principal || !here) return;
      const target = own ?? (await team.sharePage(pageId, here.id)).scope;
      await team.setAccess(target.id, principal, role);
      setPrincipal('');
    });

  const connect = () =>
    act(async () => {
      if (!connection || !here) return;
      const target = own ?? (await team.sharePage(pageId, here.id)).scope;
      await team.setAccess(target.id, connection, connectionRole);
      setConnection('');
    });
  // People and groups above; integrations (their bots) under Connections.
  const peopleEntries = entries.filter((e) => !bots.has(e.principal));
  const connected = entries.filter((e) => bots.has(e.principal));

  const everyone = own?.access?.find((e) => e.principal === 'workspace')?.role ?? null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title={`Share “${page?.title || 'Untitled'}”`}
        data-testid="share-dialog"
        className="w-[min(520px,calc(100vw-32px))]"
      >
        <div className="flex max-h-[75vh] flex-col gap-3 overflow-y-auto p-4 pt-3">
          {!scopes ? (
            <p className="text-sm text-muted">{error ?? 'Loading…'}</p>
          ) : !here ? (
            <p className="text-sm text-muted">
              This page isn’t on the server yet. Try again once it has synced.
            </p>
          ) : (
            <>
              {canShare ? (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void invite();
                  }}
                >
                  <select
                    aria-label="Person or group"
                    value={principal}
                    onChange={(e) => setPrincipal(e.target.value)}
                    className={`${select} min-w-0 flex-1`}
                  >
                    <option value="">Add people or groups…</option>
                    {members
                      .filter((m) => !taken.has(`user:${m.id}`))
                      .map((m) => (
                        <option key={m.id} value={`user:${m.id}`}>
                          {m.name} ({m.email}){m.role === 'guest' ? ' · guest' : ''}
                        </option>
                      ))}
                    {groups
                      .filter((g) => !taken.has(`group:${g.id}`))
                      .map((g) => (
                        <option key={g.id} value={`group:${g.id}`}>
                          {g.name} (group)
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label="Role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as ScopeRole)}
                    className={select}
                  >
                    {roles.map((r) => (
                      <option key={r} value={r}>
                        {SCOPE_ROLE_LABELS[r]}
                      </option>
                    ))}
                  </select>
                  <Button type="submit" variant="primary" disabled={!principal || busy}>
                    Invite
                  </Button>
                </form>
              ) : (
                <p className="text-sm text-muted">
                  Only people with full access can share this page.
                </p>
              )}

              <div className="text-xs font-medium text-muted">Who has access</div>
              <ul>
                {peopleEntries.map((entry) => {
                  const who = describe(entry.principal);
                  const target = own ?? here;
                  return (
                    <AccessRow
                      roles={roles}
                      key={entry.principal}
                      entry={entry}
                      name={who.name}
                      avatar={who.avatar}
                      note={own ? undefined : `from ${sectionTitle(here, tree?.info.name)}`}
                      canChange={!!own && own.role === 'full'}
                      onRole={(r) => void act(() => team.setAccess(target.id, entry.principal, r))}
                      onRemove={() =>
                        void act(() => team.setAccess(target.id, entry.principal, null))
                      }
                    />
                  );
                })}
                {peopleEntries.length === 0 && (
                  <li className="py-1 text-sm text-faint">
                    {own ? 'Only people with access to where it was shared from.' : 'Just you.'}
                  </li>
                )}
              </ul>

              <div className="text-xs font-medium text-muted">Connections</div>
              <ul data-testid="connections">
                {connected.map((entry) => (
                  <AccessRow
                    roles={['edit', 'view']}
                    key={entry.principal}
                    entry={entry}
                    name={describe(entry.principal).name}
                    avatar={null}
                    note={own ? undefined : `from ${sectionTitle(here, tree?.info.name)}`}
                    canChange={!!own && own.role === 'full'}
                    onRole={(r) =>
                      void act(() => team.setAccess((own ?? here).id, entry.principal, r))
                    }
                    onRemove={() =>
                      void act(() => team.setAccess((own ?? here).id, entry.principal, null))
                    }
                  />
                ))}
              </ul>
              {canShare && integrations.some((i) => !taken.has(`user:${i.id}`)) && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect();
                  }}
                >
                  <select
                    aria-label="Integration"
                    value={connection}
                    onChange={(e) => setConnection(e.target.value)}
                    className={`${select} min-w-0 flex-1`}
                  >
                    <option value="">Connect an integration…</option>
                    {integrations
                      .filter((i) => !taken.has(`user:${i.id}`))
                      .map((i) => (
                        <option key={i.id} value={`user:${i.id}`}>
                          {i.icon ? `${i.icon} ` : ''}
                          {i.name}
                        </option>
                      ))}
                  </select>
                  <select
                    aria-label="Integration access"
                    value={connectionRole}
                    onChange={(e) => setConnectionRole(e.target.value as ScopeRole)}
                    className={select}
                  >
                    <option value="edit">{SCOPE_ROLE_LABELS.edit}</option>
                    <option value="view">{SCOPE_ROLE_LABELS.view}</option>
                  </select>
                  <Button
                    type="submit"
                    disabled={!connection || busy}
                    data-testid="connect-integration"
                  >
                    Connect
                  </Button>
                </form>
              )}
              {connected.length === 0 && integrations.length === 0 && (
                <p className="text-xs text-faint">
                  No integrations yet: owners and admins add them in Members → Integrations.
                </p>
              )}

              {own && (
                <>
                  <div className="text-xs font-medium text-muted">General access</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={own.inherit}
                      disabled={own.role !== 'full'}
                      onChange={(e) =>
                        void act(() => team.updateScope(own.id, { inherit: e.target.checked }))
                      }
                    />
                    <span className="flex-1">
                      Everyone with access to{' '}
                      {parent ? sectionTitle(parent, parent.name) : 'where it was shared from'}
                    </span>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <span className="flex-1">Everyone in the workspace</span>
                    <select
                      aria-label="Everyone in the workspace"
                      value={everyone ?? 'none'}
                      disabled={own.role !== 'full'}
                      onChange={(e) =>
                        void act(() =>
                          team.setAccess(
                            own.id,
                            'workspace',
                            e.target.value === 'none' ? null : (e.target.value as ScopeRole),
                          ),
                        )
                      }
                      className={select}
                    >
                      <option value="none">No access</option>
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {SCOPE_ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {!own && tree && (
                <p className="text-xs text-faint">
                  This page has the access of {sectionName(tree.info)}. Inviting someone shares it
                  on its own, keeping that access.
                </p>
              )}
            </>
          )}
          {error && scopes && <p className="text-sm text-red-600">{error}</p>}
          {here && <PublishSection team={team} pageId={pageId} canPublish={canShare} />}
          <div className="flex justify-end border-t border-line pt-3">
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(pageUrl(pageId));
                setCopied(true);
              }}
            >
              {copied ? <Check size={14} /> : <Link size={14} />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A scope's name in "from …": teamspaces by name, private pages and shared pages by kind. */
function sectionTitle(scope: ScopeDetails, fallback?: string): string {
  if (scope.kind === 'teamspace') return scope.name || fallback || 'the teamspace';
  if (scope.kind === 'private') return scope.role === 'full' ? 'your private pages' : 'its owner';
  return 'a shared page';
}
