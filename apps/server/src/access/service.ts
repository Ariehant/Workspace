/**
 * Access in memory, per workspace: the access model (scopes, entries, members, groups)
 * and every doc's placement, loaded once and kept current by this process. Sync
 * connections ask it per row, so it answers without touching the database (except to
 * place a new doc).
 *
 * One server process is assumed: another process's changes aren't seen until a reload
 * (Postgres LISTEN/NOTIFY would be the way to run several).
 */
import { MEMBERS_DOC_ID } from '@workspace/core';
import type { AccessModel, PgStore, Scope, ScopeRole } from '@workspace/storage-remote';
import type { AccessScope, DocPolicy } from '@workspace/sync';
import { atLeast, rolesFor } from './roles';

export type Roles = ReadonlyMap<string, ScopeRole>;

/** What changed in a workspace's access (for the connections to catch up). */
export type AccessEvent =
  | { kind: 'model'; workspaceId: string }
  | { kind: 'moved'; workspaceId: string; docIds: string[]; from: string; to: string };

/** The role needed to write a doc: comments need "comment", everything else "edit". */
export const roleToWrite = (docId: string): ScopeRole =>
  docId.startsWith('comments:') ? 'comment' : 'edit';

export class WorkspaceAccess {
  private model: AccessModel;
  private readonly roleCache = new Map<string, Map<string, ScopeRole>>();
  /** scope id -> its docs */
  private readonly docsOf = new Map<string, Set<string>>();

  constructor(
    readonly workspaceId: string,
    model: AccessModel,
    /** doc id -> scope id */
    private readonly placements: Map<string, string>,
    private readonly store: PgStore,
  ) {
    this.model = model;
    for (const [docId, scopeId] of placements) this.docSet(scopeId).add(docId);
  }

  setModel(model: AccessModel) {
    this.model = model;
    this.roleCache.clear();
    // A new scope's tree doc is placed in it (in the database already).
    for (const scope of model.scopes) {
      if (!this.placements.has(scope.treeDoc)) this.setPlacement(scope.treeDoc, scope.id);
    }
  }

  scope(id: string): Scope | undefined {
    return this.model.scopes.find((s) => s.id === id);
  }

  get defaultScopeId(): string | null {
    return this.model.defaultScopeId;
  }

  isMember(userId: string): boolean {
    return this.model.members.some((m) => m.userId === userId);
  }

  roles(userId: string): Roles {
    let roles = this.roleCache.get(userId);
    if (!roles) this.roleCache.set(userId, (roles = rolesFor(this.model, userId)));
    return roles;
  }

  placementOf(docId: string): string | undefined {
    return this.placements.get(docId);
  }

  docsIn(scopeId: string): string[] {
    return [...(this.docsOf.get(scopeId) ?? [])];
  }

  canRead(roles: Roles, docId: string): boolean {
    if (docId === MEMBERS_DOC_ID) return true;
    const scope = this.placements.get(docId);
    // Not placed yet: nothing is stored (a doc is placed by its first accepted write), so
    // opening it shows nothing; a new page's doc is opened before anyone writes to it.
    if (scope === undefined) return true;
    return atLeast(roles.get(scope), 'view');
  }

  /**
   * May someone with `roles` write this doc? A doc not placed yet goes to `hint` (a
   * scope of this workspace), else the workspace's default scope, if they may write there.
   */
  async canWrite(roles: Roles, docId: string, hint: string | null): Promise<boolean> {
    if (docId === MEMBERS_DOC_ID) return false;
    const needed = roleToWrite(docId);
    let scope = this.placements.get(docId);
    if (scope === undefined) {
      const target = hint && this.scope(hint) ? hint : this.model.defaultScopeId;
      if (!target || !atLeast(roles.get(target), needed)) return false;
      scope = await this.store.scopes.place(this.workspaceId, docId, target);
      this.setPlacement(docId, scope);
    }
    return atLeast(roles.get(scope), needed);
  }

  /** The scopes someone has a role in, as sync tells the client. */
  accessScopes(roles: Roles): AccessScope[] {
    return this.model.scopes
      .filter((s) => roles.has(s.id))
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.name,
        treeDoc: s.treeDoc,
        parent: s.parentId ?? '',
        role: roles.get(s.id)!,
      }));
  }

  /** A connection's policy for `roles` (placements stay live: new docs are seen). */
  policy(roles: Roles): DocPolicy {
    return {
      canRead: (docId) => this.canRead(roles, docId),
      canWrite: (docId, hint) => this.canWrite(roles, docId, hint),
    };
  }

  /**
   * A replica connecting: it holds the docs of the scopes it `known`s, as of log
   * position `cursor`. What should it lose, and get whole?
   */
  async reconcile(
    roles: Roles,
    known: readonly string[],
    cursor: number,
  ): Promise<{ gained: string[]; lost: string[]; lostScopes: string[] }> {
    const readable = (scopeId: string | null | undefined) =>
      !!scopeId && atLeast(roles.get(scopeId), 'view');
    const had = new Set(known);
    const now = new Set([...roles.keys()].filter((id) => readable(id)));
    const gained = new Set<string>();
    const lost = new Set<string>();
    for (const id of now) if (!had.has(id)) for (const doc of this.docsIn(id)) gained.add(doc);
    const lostScopes = [...had].filter((id) => !now.has(id));
    for (const id of lostScopes) for (const doc of this.docsIn(id)) lost.add(doc);
    // Docs moved between scopes while it was away.
    for (const move of await this.store.scopes.movesSince(this.workspaceId, cursor)) {
      const current = this.placements.get(move.docId);
      if (readable(current)) {
        if (!had.has(move.fromScope ?? '') || !readable(move.fromScope)) gained.add(move.docId);
      } else if (had.has(move.fromScope ?? '')) {
        lost.add(move.docId);
      }
    }
    for (const doc of gained) lost.delete(doc);
    return { gained: [...gained], lost: [...lost], lostScopes };
  }

  /** Docs moved between scopes (placements changed in the database already). */
  moved(docIds: readonly string[], to: string) {
    for (const docId of docIds) this.setPlacement(docId, to);
  }

  private setPlacement(docId: string, scopeId: string) {
    const previous = this.placements.get(docId);
    if (previous) this.docsOf.get(previous)?.delete(docId);
    this.placements.set(docId, scopeId);
    this.docSet(scopeId).add(docId);
  }

  private docSet(scopeId: string): Set<string> {
    let set = this.docsOf.get(scopeId);
    if (!set) this.docsOf.set(scopeId, (set = new Set()));
    return set;
  }
}

export class AccessService {
  private readonly workspaces = new Map<string, Promise<WorkspaceAccess>>();
  private readonly listeners = new Set<(event: AccessEvent) => void>();

  constructor(private readonly store: PgStore) {}

  workspace(workspaceId: string): Promise<WorkspaceAccess> {
    let loading = this.workspaces.get(workspaceId);
    if (!loading) {
      loading = (async () => {
        const [model, placements] = await Promise.all([
          this.store.scopes.model(workspaceId),
          this.store.scopes.placements(workspaceId),
        ]);
        return new WorkspaceAccess(workspaceId, model, placements, this.store);
      })();
      loading.catch(() => this.workspaces.delete(workspaceId));
      this.workspaces.set(workspaceId, loading);
    }
    return loading;
  }

  /** The scopes someone may read (for filtering search and other REST results). */
  async readableScopes(workspaceId: string, userId: string): Promise<string[]> {
    const access = await this.workspace(workspaceId);
    return [...access.roles(userId)].filter(([, r]) => atLeast(r, 'view')).map(([id]) => id);
  }

  onChange(listener: (event: AccessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Scopes, entries, members or groups changed: reload, and tell the connections. */
  async changed(workspaceId: string): Promise<void> {
    if (!this.workspaces.has(workspaceId)) return;
    const access = await this.workspace(workspaceId);
    access.setModel(await this.store.scopes.model(workspaceId));
    this.emit({ kind: 'model', workspaceId });
  }

  /** Docs moved to another scope (already recorded in the database). */
  async moved(workspaceId: string, docIds: string[], from: string, to: string): Promise<void> {
    if (!this.workspaces.has(workspaceId)) return;
    const access = await this.workspace(workspaceId);
    // A move can come with a new scope (sharing a page): the model first.
    access.setModel(await this.store.scopes.model(workspaceId));
    access.moved(docIds, to);
    this.emit({ kind: 'moved', workspaceId, docIds, from, to });
  }

  private emit(event: AccessEvent) {
    for (const listener of this.listeners) listener(event);
  }
}
