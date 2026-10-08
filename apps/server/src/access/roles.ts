/**
 * Who may do what in each scope: a pure function of the workspace's access model.
 *
 * Someone's role in a scope is the highest of:
 * - the scope's entries for them, their groups, and "workspace" (every member but guests)
 * - for a teamspace, "full" if they're a workspace owner or admin (they manage teamspaces;
 *   private pages stay private, even to them)
 * - the parent scope's role, when the scope inherits (a shared page keeps the access of
 *   where it was shared from, plus its own entries)
 */
import type { AccessModel, ScopeRole } from '@workspace/storage-remote';

export const RANK: Record<ScopeRole, number> = { view: 1, comment: 2, edit: 3, full: 4 };

export const atLeast = (role: ScopeRole | undefined, needed: ScopeRole) =>
  role !== undefined && RANK[role] >= RANK[needed];

const higher = (a: ScopeRole | undefined, b: ScopeRole | undefined) =>
  a === undefined ? b : b === undefined ? a : RANK[a] >= RANK[b] ? a : b;

/** Scope id -> role, for the scopes a user has any role in. */
export function rolesFor(model: AccessModel, userId: string): Map<string, ScopeRole> {
  const roles = new Map<string, ScopeRole>();
  const member = model.members.find((m) => m.userId === userId);
  if (!member) return roles;
  const principals = new Set([`user:${userId}`]);
  for (const g of model.groups) if (g.userId === userId) principals.add(`group:${g.groupId}`);
  if (member.role !== 'guest') principals.add('workspace');
  const manager = member.role === 'owner' || member.role === 'admin';

  const own = new Map<string, ScopeRole>();
  for (const entry of model.entries) {
    if (principals.has(entry.principal))
      own.set(entry.scopeId, higher(own.get(entry.scopeId), entry.role)!);
  }
  const byId = new Map(model.scopes.map((s) => [s.id, s]));
  const memo = new Map<string, ScopeRole | undefined>();
  const roleOf = (scopeId: string, seen: Set<string>): ScopeRole | undefined => {
    if (memo.has(scopeId)) return memo.get(scopeId);
    const scope = byId.get(scopeId);
    if (!scope || seen.has(scopeId)) return undefined;
    seen.add(scopeId);
    let role = own.get(scopeId);
    if (scope.kind === 'teamspace' && manager) role = higher(role, 'full');
    if (scope.inherit && scope.parentId) role = higher(role, roleOf(scope.parentId, seen));
    memo.set(scopeId, role);
    return role;
  };
  for (const scope of model.scopes) {
    const role = roleOf(scope.id, new Set());
    if (role) roles.set(scope.id, role);
  }
  return roles;
}
