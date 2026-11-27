/**
 * Share a page: invite people or groups with a role, see who has access and why, and
 * the page's general access. Sharing a page that has the access of where it is (a
 * teamspace, your private pages) first makes it its own scope, which keeps that access
 * (inherited) and adds the people invited.
 */
import { getPage, getPagesMap, pageUrl, type Forest, type PageId } from '@workspace/core';
import { Button, Dialog, DialogContent } from '@workspace/ui';
import { Check, Copy, Link } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { sectionName } from './scope-actions';
import { AccessRow, usePrincipals } from './teamspace-dialogs';
import { notifyShared, OnlinePeople, usePublishedCheck } from './online-check-ui';
import {
  parseEmails,
  SCOPE_ROLE_LABELS,
  type AccessRequestInfo,
  type CreatedInvite,
  type PendingInvite,
  type RequestedRole,
  type IntegrationInfo,
  type ScopeDetails,
  type ScopeRole,
  type TeamApi,
} from './team';
import { PublishSection } from './publish-section';
import { ShareLinkSection } from './share-link-section';

const select =
  'h-8 rounded-md border border-line bg-surface px-1.5 text-sm text-fg outline-none focus:border-accent disabled:opacity-60';
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const ROLES: ScopeRole[] = ['full', 'edit', 'comment', 'view'];
const REQUEST_VERBS: Record<RequestedRole, string> = {
  view: 'view',
  comment: 'comment',
  edit: 'edit',
};
/** A database also offers "can edit content" (its rows, not its properties or views). */
const DATABASE_ROLES: ScopeRole[] = ['full', 'edit', 'content', 'create', 'comment', 'view'];

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
  const [entry, setEntry] = useState('');
  const [sent, setSent] = useState<CreatedInvite[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
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

  // Pending invites to this page (sent from here, not yet accepted).
  const [pending, setPending] = useState<PendingInvite[]>([]);
  const loadPending = useCallback(
    (scopeId: string) =>
      team.invites(scopeId).then(
        (r) => setPending(r.invites),
        () => setPending([]),
      ),
    [team],
  );
  const ownId = own?.id ?? null;
  useEffect(() => {
    if (ownId && canShare) void loadPending(ownId);
  }, [ownId, canShare, loadPending]);

  /**
   * Share with what's typed: groups and people by name get access now; emails go to the
   * server, which gives the page at once to people in the workspace and emails an invite to
   * everyone else (a guest invite that gives this page).
   */
  const invite = () =>
    act(async () => {
      if (!here) return;
      const parts = entry
        .split(/[,;\n]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (parts.length === 0) return;
      const principals: string[] = [];
      const emails: string[] = [];
      const unknown: string[] = [];
      for (const part of parts) {
        const name = part.toLowerCase();
        const group = groups.find((g) => g.name.toLowerCase() === name);
        const member = members.find((m) => m.name.toLowerCase() === name);
        const email = parseEmails(part)[0];
        if (group) principals.push(`group:${group.id}`);
        else if (email) emails.push(email);
        else if (member) principals.push(`user:${member.id}`);
        else unknown.push(part);
      }
      if (unknown.length > 0) {
        throw new Error(`No one here is called ${unknown.join(', ')}: type their email instead.`);
      }
      const target = own ?? (await team.sharePage(pageId, here.id)).scope;
      for (const principal of principals) await team.setAccess(target.id, principal, role);
      let message: string[] = [];
      if (emails.length > 0) {
        const result = await team.invite(emails, 'guest', { scopeId: target.id, role });
        setSent(result.invites.filter((i) => !i.emailed));
        const emailed = result.invites.filter((i) => i.emailed).map((i) => i.email);
        message = [
          emailed.length > 0 ? `Invite sent to ${emailed.join(', ')}.` : '',
          result.invites.some((i) => !i.emailed)
            ? 'The server can’t send email: copy the invite link below and send it yourself.'
            : '',
          result.skipped.length > 0 ? `${result.skipped.join(', ')} can’t be added.` : '',
        ].filter(Boolean);
        await loadPending(target.id);
      }
      setNotice(message.join(' ') || null);
      setEntry('');
      notifyShared(pageId);
    });

  // Suggestions for what's being typed (after the last comma): people and groups.
  const typing = entry.split(/[,;]/).pop()!.trim().toLowerCase();
  const suggestions =
    typing.length === 0
      ? []
      : [
          ...members
            .filter((m) => !taken.has(`user:${m.id}`))
            .filter((m) => m.name.toLowerCase().includes(typing) || m.email.includes(typing))
            .map((m) => ({ key: m.id, label: `${m.name} (${m.email})`, value: m.email })),
          ...groups
            .filter((g) => !taken.has(`group:${g.id}`))
            .filter((g) => g.name.toLowerCase().includes(typing))
            .map((g) => ({ key: g.id, label: `${g.name} (group)`, value: g.name })),
        ].slice(0, 6);
  const shown = suggestions.some((s) => s.value.toLowerCase() === typing) ? [] : suggestions;
  const [active, setActive] = useState(-1);
  const pick = (value: string) => {
    const before = entry.includes(',') ? entry.slice(0, entry.lastIndexOf(',') + 1) + ' ' : '';
    setEntry(`${before}${value}, `);
    setActive(-1);
  };
  const online = usePublishedCheck(pageId);

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

  // Requests for access to this page (Phase 8 N4), for people who can share it.
  const [requests, setRequests] = useState<AccessRequestInfo[]>([]);
  const loadRequests = useCallback(
    () =>
      team.accessRequests(pageId).then(
        (r) => setRequests(r.requests),
        () => setRequests([]),
      ),
    [team, pageId],
  );
  useEffect(() => {
    if (canShare) void loadRequests();
  }, [canShare, loadRequests]);
  const answer = (request: AccessRequestInfo, approve: boolean) =>
    act(async () => {
      await (approve
        ? team.approveRequest(request.id, request.role)
        : team.declineRequest(request.id));
      await loadRequests();
    });

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
              {canShare && requests.length > 0 && (
                <section aria-label="Requests" data-testid="share-requests" className="text-sm">
                  <h3 className="mb-1 text-xs font-medium text-muted">Requests</h3>
                  <ul className="flex flex-col gap-1">
                    {requests.map((r) => (
                      <li
                        key={r.id}
                        className="flex flex-wrap items-center gap-2 rounded-md bg-hover/50 px-2 py-1.5"
                        data-testid="share-request"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">
                            {describe(`user:${r.requesterId}`).name}
                          </span>{' '}
                          <span className="text-muted">
                            asks to {REQUEST_VERBS[r.role]}
                            {r.message ? `: “${r.message}”` : ''}
                          </span>
                        </span>
                        <Button
                          variant="primary"
                          disabled={busy}
                          onClick={() => void answer(r, true)}
                        >
                          Share
                        </Button>
                        <Button disabled={busy} onClick={() => void answer(r, false)}>
                          Decline
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {canShare ? (
                <form
                  className="relative flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void invite();
                  }}
                >
                  <input
                    aria-label="Email or group"
                    data-testid="share-entry"
                    value={entry}
                    onChange={(e) => {
                      setEntry(e.target.value);
                      setActive(-1);
                    }}
                    onKeyDown={(e) => {
                      if (shown.length === 0) return;
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault();
                        const step = e.key === 'ArrowDown' ? 1 : -1;
                        setActive((i) => (i + step + shown.length) % shown.length);
                      } else if (e.key === 'Enter' && shown[active]) {
                        e.preventDefault();
                        pick(shown[active].value);
                      }
                    }}
                    role="combobox"
                    aria-expanded={shown.length > 0}
                    aria-controls="share-suggestions"
                    aria-activedescendant={
                      shown[active] ? `share-suggestion-${shown[active].key}` : undefined
                    }
                    placeholder="Email or group, separated by commas"
                    autoComplete="off"
                    className={`${select} min-w-0 flex-1 px-2`}
                  />
                  {shown.length > 0 && (
                    <ul
                      id="share-suggestions"
                      role="listbox"
                      aria-label="Suggestions"
                      className="absolute top-9 left-0 z-10 w-[min(360px,100%)] rounded-md bg-menu p-1 shadow-menu"
                    >
                      {shown.map((s, i) => (
                        <li
                          key={s.key}
                          id={`share-suggestion-${s.key}`}
                          role="option"
                          aria-selected={i === active}
                        >
                          <button
                            type="button"
                            tabIndex={-1}
                            data-testid="share-suggestion"
                            className={`w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-hover ${i === active ? 'bg-hover' : ''}`}
                            onClick={() => pick(s.value)}
                          >
                            {s.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
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
                  <Button type="submit" variant="primary" disabled={!entry.trim() || busy}>
                    Invite
                  </Button>
                </form>
              ) : (
                <p className="text-sm text-muted">
                  Only people with full access can share this page.
                </p>
              )}

              {notice && (
                <p className="text-sm text-muted" role="status" data-testid="share-notice">
                  {notice}
                </p>
              )}
              {sent.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center gap-2 text-sm"
                  data-testid="share-invite-link"
                >
                  <span className="min-w-0 flex-1 truncate text-muted">
                    {i.email}: {i.link}
                  </span>
                  <Button onClick={() => void navigator.clipboard.writeText(i.link)}>
                    <Copy size={14} /> Copy
                  </Button>
                </div>
              ))}
              {online && <OnlinePeople check={online} />}

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
                      onRole={(r) =>
                        void act(async () => {
                          await team.setAccess(target.id, entry.principal, r);
                          notifyShared(pageId);
                        })
                      }
                      onRemove={() =>
                        void act(async () => {
                          await team.setAccess(target.id, entry.principal, null);
                          notifyShared(pageId);
                        })
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

              {pending.length > 0 && (
                <>
                  <div className="text-xs font-medium text-muted">Invited</div>
                  <ul data-testid="share-pending">
                    {pending.map((i) => (
                      <li
                        key={i.id}
                        data-testid="share-pending-invite"
                        className="flex items-center gap-2 py-1 text-sm"
                      >
                        <span className="min-w-0 flex-1 truncate">{i.email}</span>
                        <span className="text-xs text-muted">
                          {i.page ? SCOPE_ROLE_LABELS[i.page.role] : ''} · pending
                        </span>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              await team.revokeInvite(i.id);
                              if (own) await loadPending(own.id);
                            })
                          }
                        >
                          Revoke
                        </Button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

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
          {here && canShare && (
            <ShareLinkSection team={team} pageId={pageId} onChanged={() => void reload()} />
          )}
          {here && (
            <PublishSection
              team={team}
              pageId={pageId}
              title={page?.title ?? ''}
              canPublish={canShare}
            />
          )}
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
