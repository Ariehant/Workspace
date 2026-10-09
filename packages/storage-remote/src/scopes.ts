import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { MemberRole } from './store';

export type ScopeKind = 'teamspace' | 'private' | 'shared';
export type ScopeRole = 'full' | 'edit' | 'content' | 'comment' | 'view';
/** Who can find a teamspace: anyone (and join it), anyone (added by its members), or only its members. */
export type ScopeVisibility = 'open' | 'closed' | 'private';

export interface Scope {
  id: string;
  workspaceId: string;
  kind: ScopeKind;
  name: string;
  treeDoc: string;
  parentId: string | null;
  inherit: boolean;
  ownerId: string | null;
  /** A teamspace's emoji (or none). */
  icon: string | null;
  description: string;
  visibility: ScopeVisibility;
  /** The role someone gets by joining (an open teamspace). */
  joinRole: ScopeRole;
}

/** 'user:<id>', 'group:<id>' or 'workspace' (every member but guests). */
export type Principal = string;

export interface AccessEntry {
  scopeId: string;
  principal: Principal;
  role: ScopeRole;
}

/** Everything that decides who may do what in a workspace (small: loaded whole). */
export interface AccessModel {
  defaultScopeId: string | null;
  scopes: Scope[];
  entries: AccessEntry[];
  members: { userId: string; role: MemberRole }[];
  /** userId -> group ids */
  groups: { userId: string; groupId: string }[];
}

export interface DocMove {
  seq: number;
  docId: string;
  fromScope: string | null;
  toScope: string | null;
}

type ScopeRow = {
  id: string;
  workspace_id: string;
  kind: ScopeKind;
  name: string;
  tree_doc: string;
  parent_id: string | null;
  inherit: boolean;
  owner_id: string | null;
  icon: string | null;
  description: string;
  visibility: ScopeVisibility;
  join_role: ScopeRole;
};
const toScope = (r: ScopeRow): Scope => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  name: r.name,
  treeDoc: r.tree_doc,
  parentId: r.parent_id,
  inherit: r.inherit,
  ownerId: r.owner_id,
  icon: r.icon,
  description: r.description,
  visibility: r.visibility,
  joinRole: r.join_role,
});

/** Scopes, who may do what in them, and which scope each doc is in. */
export class Scopes {
  constructor(private readonly pool: pg.Pool) {}

  async model(workspaceId: string): Promise<AccessModel> {
    const [ws, scopes, entries, members, groups] = await Promise.all([
      this.pool.query<{ default_scope_id: string | null }>(
        'SELECT default_scope_id FROM workspaces WHERE id = $1',
        [workspaceId],
      ),
      this.pool.query<ScopeRow>(
        'SELECT * FROM scopes WHERE workspace_id = $1 ORDER BY created_at',
        [workspaceId],
      ),
      this.pool.query<{ scope_id: string; principal: string; role: ScopeRole }>(
        `SELECT a.scope_id, a.principal, a.role FROM scope_access a
         JOIN scopes s ON s.id = a.scope_id WHERE s.workspace_id = $1`,
        [workspaceId],
      ),
      this.pool.query<{ user_id: string; role: MemberRole }>(
        'SELECT user_id, role FROM workspace_members WHERE workspace_id = $1',
        [workspaceId],
      ),
      this.pool.query<{ user_id: string; group_id: string }>(
        `SELECT gm.user_id, gm.group_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id WHERE g.workspace_id = $1`,
        [workspaceId],
      ),
    ]);
    return {
      defaultScopeId: ws.rows[0]?.default_scope_id ?? null,
      scopes: scopes.rows.map(toScope),
      entries: entries.rows.map((r) => ({
        scopeId: r.scope_id,
        principal: r.principal,
        role: r.role,
      })),
      members: members.rows.map((r) => ({ userId: r.user_id, role: r.role })),
      groups: groups.rows.map((r) => ({ userId: r.user_id, groupId: r.group_id })),
    };
  }

  async get(workspaceId: string, scopeId: string): Promise<Scope | null> {
    const { rows } = await this.pool.query<ScopeRow>(
      'SELECT * FROM scopes WHERE id = $1 AND workspace_id = $2',
      [scopeId, workspaceId],
    );
    return rows[0] ? toScope(rows[0]) : null;
  }

  /**
   * A new scope with its tree doc (`tree:<id>`, placed in it) and its first access
   * entries.
   */
  async create(input: {
    workspaceId: string;
    kind: ScopeKind;
    name: string;
    parentId?: string | null;
    inherit?: boolean;
    ownerId?: string | null;
    icon?: string | null;
    description?: string;
    visibility?: ScopeVisibility;
    joinRole?: ScopeRole;
    access: { principal: Principal; role: ScopeRole }[];
  }): Promise<Scope> {
    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<ScopeRow>(
        `INSERT INTO scopes (id, workspace_id, kind, name, tree_doc, parent_id, inherit, owner_id,
           icon, description, visibility, join_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          id,
          input.workspaceId,
          input.kind,
          input.name,
          `tree:${id}`,
          input.parentId ?? null,
          input.inherit ?? true,
          input.ownerId ?? null,
          input.icon ?? null,
          input.description ?? '',
          input.visibility ?? 'open',
          input.joinRole ?? 'edit',
        ],
      );
      for (const entry of input.access) {
        await client.query(
          'INSERT INTO scope_access (scope_id, principal, role) VALUES ($1, $2, $3)',
          [id, entry.principal, entry.role],
        );
      }
      await client.query(
        'INSERT INTO doc_scopes (workspace_id, doc_id, scope_id) VALUES ($1, $2, $3)',
        [input.workspaceId, `tree:${id}`, id],
      );
      await client.query('COMMIT');
      return toScope(rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async update(
    workspaceId: string,
    scopeId: string,
    change: {
      name?: string;
      inherit?: boolean;
      /** `null` removes the icon. */
      icon?: string | null;
      description?: string;
      visibility?: ScopeVisibility;
      joinRole?: ScopeRole;
    },
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE scopes SET
         name = coalesce($3, name),
         inherit = coalesce($4, inherit),
         icon = CASE WHEN $5 THEN $6 ELSE icon END,
         description = coalesce($7, description),
         visibility = coalesce($8, visibility),
         join_role = coalesce($9, join_role)
       WHERE id = $1 AND workspace_id = $2`,
      [
        scopeId,
        workspaceId,
        change.name ?? null,
        change.inherit ?? null,
        change.icon !== undefined,
        change.icon ?? null,
        change.description ?? null,
        change.visibility ?? null,
        change.joinRole ?? null,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Give a principal a role in a scope, or take it away (`role` null). */
  async setAccess(scopeId: string, principal: Principal, role: ScopeRole | null): Promise<void> {
    if (role === null) {
      await this.pool.query('DELETE FROM scope_access WHERE scope_id = $1 AND principal = $2', [
        scopeId,
        principal,
      ]);
      return;
    }
    await this.pool.query(
      `INSERT INTO scope_access (scope_id, principal, role) VALUES ($1, $2, $3)
       ON CONFLICT (scope_id, principal) DO UPDATE SET role = excluded.role`,
      [scopeId, principal, role],
    );
  }

  /** Someone's private pages, made the first time they're asked for. */
  async privateScope(workspaceId: string, userId: string): Promise<Scope> {
    const { rows } = await this.pool.query<ScopeRow>(
      `SELECT * FROM scopes WHERE workspace_id = $1 AND kind = 'private' AND owner_id = $2
       ORDER BY created_at LIMIT 1`,
      [workspaceId, userId],
    );
    if (rows[0]) return toScope(rows[0]);
    return this.create({
      workspaceId,
      kind: 'private',
      name: 'Private',
      ownerId: userId,
      inherit: false,
      access: [{ principal: `user:${userId}`, role: 'full' }],
    });
  }

  // --- Placements -------------------------------------------------------------------------

  /** Every doc's scope, for a workspace. */
  async placements(workspaceId: string): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ doc_id: string; scope_id: string }>(
      'SELECT doc_id, scope_id FROM doc_scopes WHERE workspace_id = $1',
      [workspaceId],
    );
    return new Map(rows.map((r) => [r.doc_id, r.scope_id]));
  }

  async placementOf(workspaceId: string, docId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ scope_id: string }>(
      'SELECT scope_id FROM doc_scopes WHERE workspace_id = $1 AND doc_id = $2',
      [workspaceId, docId],
    );
    return rows[0]?.scope_id ?? null;
  }

  /** Put a new doc in a scope; returns where it actually is (someone may have been first). */
  async place(workspaceId: string, docId: string, scopeId: string): Promise<string> {
    const { rows } = await this.pool.query<{ scope_id: string }>(
      `WITH ins AS (
         INSERT INTO doc_scopes (workspace_id, doc_id, scope_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING scope_id
       )
       SELECT scope_id FROM ins
       UNION ALL
       SELECT scope_id FROM doc_scopes WHERE workspace_id = $1 AND doc_id = $2
       LIMIT 1`,
      [workspaceId, docId, scopeId],
    );
    if (rows[0]) return rows[0].scope_id;
    // Someone else's insert was in flight: it wasn't in this statement's snapshot, and it
    // is committed now.
    const placed = await this.placementOf(workspaceId, docId);
    if (!placed) throw new Error(`Could not place ${docId}`);
    return placed;
  }

  /**
   * Move docs to another scope (the ones in `from`), recording the move at log position
   * `seq`. Returns the docs that moved. The search index follows (pages and rows of
   * moved databases).
   */
  async move(
    workspaceId: string,
    docIds: readonly string[],
    from: string,
    to: string,
    seq: number,
  ): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ doc_id: string }>(
        `UPDATE doc_scopes SET scope_id = $4
         WHERE workspace_id = $1 AND doc_id = ANY($2::text[]) AND scope_id = $3
         RETURNING doc_id`,
        [workspaceId, docIds, from, to],
      );
      const moved = rows.map((r) => r.doc_id);
      await client.query(
        `INSERT INTO doc_moves (workspace_id, seq, doc_id, from_scope, to_scope)
         SELECT $1, $2, id, $3, $4 FROM unnest($5::text[]) AS t(id)`,
        [workspaceId, seq, from, to, moved],
      );
      await client.query(
        `UPDATE search_index SET scope_id = $3
         WHERE workspace_id = $1 AND (id = ANY($2::text[]) OR database_id = ANY($2::text[]))`,
        [workspaceId, docIds, to],
      );
      await client.query('COMMIT');
      return moved;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Docs moved after log position `seq`, oldest first. */
  async movesSince(workspaceId: string, seq: number): Promise<DocMove[]> {
    const { rows } = await this.pool.query<{
      seq: number;
      doc_id: string;
      from_scope: string | null;
      to_scope: string | null;
    }>(
      'SELECT seq, doc_id, from_scope, to_scope FROM doc_moves WHERE workspace_id = $1 AND seq > $2 ORDER BY seq',
      [workspaceId, seq],
    );
    return rows.map((r) => ({
      seq: r.seq,
      docId: r.doc_id,
      fromScope: r.from_scope,
      toScope: r.to_scope,
    }));
  }
}
