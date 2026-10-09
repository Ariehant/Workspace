import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { hashSecret, normalizeEmail } from './accounts';
import type { MemberRole } from './store';

/** Someone in a workspace, as its members list shows them. */
export interface Member {
  userId: string;
  name: string;
  email: string;
  avatar: string | null;
  role: MemberRole;
  joinedAt: Date;
  /** The account is disabled on this server. */
  disabled: boolean;
}

export type InviteRole = Exclude<MemberRole, 'owner'>;

export interface WorkspaceInvite {
  id: string;
  workspaceId: string;
  email: string;
  role: InviteRole;
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export type InviteStatus = 'valid' | 'expired' | 'accepted' | 'revoked';

/** What an invite link shows before it's accepted. */
export interface InviteInfo {
  id: string;
  workspace: { id: string; name: string };
  email: string;
  role: InviteRole;
  invitedByName: string | null;
  status: InviteStatus;
}

export interface Group {
  id: string;
  name: string;
  /** User ids. */
  members: string[];
}

/** How much a role may do, for "never lower someone by accepting an invite". */
export const ROLE_RANK: Record<MemberRole, number> = {
  bot: -1,
  guest: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

type InviteRow = {
  id: string;
  workspace_id: string;
  email: string;
  role: InviteRole;
  invited_by: string | null;
  created_at: Date;
  expires_at: Date;
};
const toInvite = (r: InviteRow): WorkspaceInvite => ({
  id: r.id,
  workspaceId: r.workspace_id,
  email: r.email,
  role: r.role,
  invitedBy: r.invited_by,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
});

/** Workspace members, their invites and groups. */
export class Teams {
  constructor(private readonly pool: pg.Pool) {}

  // --- Members ---------------------------------------------------------------------------

  async members(workspaceId: string): Promise<Member[]> {
    const { rows } = await this.pool.query<{
      user_id: string;
      name: string;
      email: string;
      avatar: string | null;
      role: MemberRole;
      created_at: Date;
      disabled_at: Date | null;
    }>(
      `SELECT m.user_id, u.name, u.email, u.avatar, m.role, m.created_at, u.disabled_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.role <> 'bot' ORDER BY m.created_at, u.name`,
      [workspaceId],
    );
    return rows.map((r) => ({
      userId: r.user_id,
      name: r.name,
      email: r.email,
      avatar: r.avatar,
      role: r.role,
      joinedAt: r.created_at,
      disabled: r.disabled_at !== null,
    }));
  }

  /** Add someone (no change if they're already in). True if they were added. */
  async addMember(workspaceId: string, userId: string, role: MemberRole): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [workspaceId, userId, role],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Change a member's role. Refused (false) if it would leave the workspace without an
   * owner. The owner count is checked under a lock, so two owners can't demote each
   * other at once.
   */
  async setRole(workspaceId: string, userId: string, role: MemberRole): Promise<boolean> {
    return this.withWorkspaceLock(workspaceId, async (client) => {
      const current = await roleIn(client, workspaceId, userId);
      // An integration's bot keeps its role (it goes with the integration).
      if (!current || current === 'bot' || role === 'bot') return false;
      if (current === 'owner' && role !== 'owner' && (await owners(client, workspaceId)) <= 1) {
        return false;
      }
      await client.query(
        'UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
        [workspaceId, userId, role],
      );
      return true;
    });
  }

  /** Take someone out of the workspace (and its groups). False for the last owner. */
  async removeMember(workspaceId: string, userId: string): Promise<boolean> {
    return this.withWorkspaceLock(workspaceId, async (client) => {
      const current = await roleIn(client, workspaceId, userId);
      if (!current || current === 'bot') return false;
      if (current === 'owner' && (await owners(client, workspaceId)) <= 1) return false;
      await client.query(
        `DELETE FROM group_members g USING groups gr
         WHERE g.group_id = gr.id AND gr.workspace_id = $1 AND g.user_id = $2`,
        [workspaceId, userId],
      );
      await client.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
        workspaceId,
        userId,
      ]);
      return true;
    });
  }

  /** The workspaces a user is in (to refresh each one's members doc after a profile change). */
  async workspaceIdsOf(userId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_members WHERE user_id = $1',
      [userId],
    );
    return rows.map((r) => r.workspace_id);
  }

  /**
   * Everyone who was ever named in the workspace's members doc stays there (marked
   * removed), so "created by" and person values keep their names: this lists the
   * accounts behind ids that are no longer members.
   */
  async usersByIds(
    ids: readonly string[],
  ): Promise<{ id: string; name: string; avatar: string | null }[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<{ id: string; name: string; avatar: string | null }>(
      'SELECT id, name, avatar FROM users WHERE id = ANY($1::uuid[])',
      [ids],
    );
    return rows;
  }

  // --- Invites ---------------------------------------------------------------------------

  async createInvite(input: {
    workspaceId: string;
    email: string;
    role: InviteRole;
    token: string;
    invitedBy: string | null;
    ttlMs: number;
  }): Promise<WorkspaceInvite> {
    const email = normalizeEmail(input.email);
    // A new invite to the same address replaces the pending one (its link stops working).
    await this.pool.query(
      `UPDATE workspace_invites SET revoked_at = now()
       WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [input.workspaceId, email],
    );
    const { rows } = await this.pool.query<InviteRow>(
      `INSERT INTO workspace_invites (id, workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint * interval '1 millisecond'))
       RETURNING *`,
      [
        randomUUID(),
        input.workspaceId,
        email,
        input.role,
        hashSecret(input.token),
        input.invitedBy,
        input.ttlMs,
      ],
    );
    return toInvite(rows[0]!);
  }

  /** Invites not yet accepted, revoked or expired. */
  async pendingInvites(workspaceId: string): Promise<WorkspaceInvite[]> {
    const { rows } = await this.pool.query<InviteRow>(
      `SELECT * FROM workspace_invites
       WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at`,
      [workspaceId],
    );
    return rows.map(toInvite);
  }

  async revokeInvite(workspaceId: string, inviteId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE workspace_invites SET revoked_at = now()
       WHERE id = $2 AND workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, inviteId],
    );
    return (rowCount ?? 0) > 0;
  }

  async inviteInfo(token: string): Promise<InviteInfo | null> {
    const { rows } = await this.pool.query<
      InviteRow & {
        workspace_name: string;
        inviter: string | null;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }
    >(
      `SELECT i.*, w.name AS workspace_name, u.name AS inviter
       FROM workspace_invites i JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.token_hash = $1`,
      [hashSecret(token)],
    );
    const r = rows[0];
    if (!r) return null;
    const status: InviteStatus = r.revoked_at
      ? 'revoked'
      : r.accepted_at
        ? 'accepted'
        : r.expires_at.getTime() <= Date.now()
          ? 'expired'
          : 'valid';
    return {
      id: r.id,
      workspace: { id: r.workspace_id, name: r.workspace_name },
      email: r.email,
      role: r.role,
      invitedByName: r.inviter,
      status,
    };
  }

  /**
   * Join the workspace with an invite. The invite must be valid and for this user's
   * email; it works once (accepting it again as the same person changes nothing).
   * Someone already in the workspace keeps their role unless the invite's is higher.
   */
  async acceptInvite(
    token: string,
    user: { id: string; email: string },
  ): Promise<
    | { ok: true; workspaceId: string; role: MemberRole }
    | { ok: false; reason: InviteStatus | 'not_found' | 'wrong_account' }
  > {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<
        InviteRow & {
          accepted_at: Date | null;
          accepted_by: string | null;
          revoked_at: Date | null;
        }
      >('SELECT * FROM workspace_invites WHERE token_hash = $1 FOR UPDATE', [hashSecret(token)]);
      const invite = rows[0];
      const fail = async (reason: InviteStatus | 'not_found' | 'wrong_account') => {
        await client.query('ROLLBACK');
        return { ok: false as const, reason };
      };
      if (!invite) return await fail('not_found');
      if (invite.revoked_at) return await fail('revoked');
      if (invite.accepted_at) {
        // Accepting twice (signing up with the invite already joined) is fine.
        const role = await roleIn(client, invite.workspace_id, user.id);
        if (invite.accepted_by !== user.id || !role) return await fail('accepted');
        await client.query('ROLLBACK');
        return { ok: true, workspaceId: invite.workspace_id, role };
      }
      if (invite.expires_at.getTime() <= Date.now()) return await fail('expired');
      if (invite.email !== normalizeEmail(user.email)) return await fail('wrong_account');

      const current = await roleIn(client, invite.workspace_id, user.id);
      let role: MemberRole = invite.role;
      if (!current) {
        await client.query(
          'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
          [invite.workspace_id, user.id, invite.role],
        );
      } else if (ROLE_RANK[invite.role] > ROLE_RANK[current]) {
        await client.query(
          'UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
          [invite.workspace_id, user.id, invite.role],
        );
      } else {
        role = current;
      }
      await client.query(
        'UPDATE workspace_invites SET accepted_by = $2, accepted_at = now() WHERE id = $1',
        [invite.id, user.id],
      );
      await client.query('COMMIT');
      return { ok: true, workspaceId: invite.workspace_id, role };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  // --- Groups ----------------------------------------------------------------------------

  async groups(workspaceId: string): Promise<Group[]> {
    const { rows } = await this.pool.query<{ id: string; name: string; members: string[] }>(
      `SELECT g.id, g.name,
         coalesce(array_agg(gm.user_id ORDER BY gm.user_id) FILTER (WHERE gm.user_id IS NOT NULL), '{}') AS members
       FROM groups g LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE g.workspace_id = $1 GROUP BY g.id ORDER BY lower(g.name)`,
      [workspaceId],
    );
    return rows;
  }

  /** Null if the workspace already has a group with this name. */
  async createGroup(workspaceId: string, name: string): Promise<Group | null> {
    const { rows } = await this.pool.query<{ id: string; name: string }>(
      `INSERT INTO groups (id, workspace_id, name) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, name) DO NOTHING RETURNING id, name`,
      [randomUUID(), workspaceId, name.trim()],
    );
    return rows[0] ? { ...rows[0], members: [] } : null;
  }

  /** 'missing' if there's no such group, 'taken' if another has the name. */
  async renameGroup(
    workspaceId: string,
    groupId: string,
    name: string,
  ): Promise<'ok' | 'missing' | 'taken'> {
    try {
      const { rowCount } = await this.pool.query(
        'UPDATE groups SET name = $3 WHERE id = $2 AND workspace_id = $1',
        [workspaceId, groupId, name.trim()],
      );
      return (rowCount ?? 0) > 0 ? 'ok' : 'missing';
    } catch (error) {
      if ((error as { code?: string }).code === '23505') return 'taken';
      throw error;
    }
  }

  async deleteGroup(workspaceId: string, groupId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM groups WHERE id = $2 AND workspace_id = $1',
      [workspaceId, groupId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Only the workspace's own members can be in its groups. */
  async addToGroup(workspaceId: string, groupId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO group_members (group_id, user_id)
       SELECT g.id, m.user_id FROM groups g
       JOIN workspace_members m ON m.workspace_id = g.workspace_id AND m.user_id = $3
       WHERE g.id = $2 AND g.workspace_id = $1
       ON CONFLICT DO NOTHING`,
      [workspaceId, groupId, userId],
    );
    if ((rowCount ?? 0) > 0) return true;
    // Already in it counts as success; anything else (no group, not a member) doesn't.
    const { rows } = await this.pool.query(
      `SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE g.id = $2 AND g.workspace_id = $1 AND gm.user_id = $3`,
      [workspaceId, groupId, userId],
    );
    return rows.length > 0;
  }

  async removeFromGroup(workspaceId: string, groupId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM group_members gm USING groups g
       WHERE gm.group_id = g.id AND g.id = $2 AND g.workspace_id = $1 AND gm.user_id = $3`,
      [workspaceId, groupId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------------------

  /** Run `fn` in a transaction holding the workspace row's lock (membership changes). */
  private async withWorkspaceLock<T>(
    workspaceId: string,
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

async function roleIn(
  client: pg.PoolClient,
  workspaceId: string,
  userId: string,
): Promise<MemberRole | null> {
  const { rows } = await client.query<{ role: MemberRole }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}

async function owners(client: pg.PoolClient, workspaceId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  return rows[0]!.n;
}
