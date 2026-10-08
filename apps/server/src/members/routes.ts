/**
 * Members, invites and groups of a workspace:
 *
 * - Everyone but guests can see the members (with emails) and groups.
 * - Owners and admins invite people, change roles, remove people and manage groups.
 *   Only owners can make someone an owner or change an owner; a workspace always keeps
 *   at least one owner.
 * - Anyone can leave.
 *
 * Every change refreshes the members doc, and a changed role or removal closes the
 * person's sockets so their access is checked again.
 */
import type { MemberRole } from '@workspace/storage-remote';
import { normalizeEmail } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, requireUser } from '../auth/context';
import { randomToken } from '../auth/passwords';
import type { ServerContext } from '../context';

export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
const MAX_INVITES_PER_REQUEST = 50;

const uuid = { type: 'string', format: 'uuid' } as const;
const groupName = { type: 'string', minLength: 1, maxLength: 100 } as const;
const role = { type: 'string', enum: ['owner', 'admin', 'member', 'guest'] } as const;
const inviteRole = { type: 'string', enum: ['admin', 'member', 'guest'] } as const;
const email = { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+$' } as const;
const params = (...extra: string[]) =>
  ({
    type: 'object',
    properties: Object.fromEntries(['id', ...extra].map((k) => [k, uuid])),
  }) as const;

const manages = (r: MemberRole) => r === 'owner' || r === 'admin';

export function memberRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  const { teams } = store;

  /** The caller's role in the workspace, or a 404 if they aren't in it. */
  async function roleIn(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<MemberRole | null> {
    const r = await store.roleOf(request.params.id, request.auth!.user.id);
    if (!r) {
      // As far as outsiders can tell, the workspace doesn't exist.
      void fail(reply, 404, 'not_found', 'No such workspace.');
      return null;
    }
    return r;
  }

  /** Owners and admins only; null (after replying) otherwise. */
  async function manager(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<MemberRole | null> {
    const r = await roleIn(request, reply);
    if (!r) return null;
    if (!manages(r)) {
      void fail(reply, 403, 'forbidden', 'Only owners and admins can do that.');
      return null;
    }
    return r;
  }

  /** Not guests: they don't see who else is in the workspace (beyond names). */
  async function insider(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<MemberRole | null> {
    const r = await roleIn(request, reply);
    if (!r) return null;
    if (r === 'guest') {
      void fail(reply, 403, 'forbidden', 'Guests can’t see the members list.');
      return null;
    }
    return r;
  }

  const changed = (workspaceId: string) => ctx.members.refresh(workspaceId);

  // --- Members ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/members',
    { preHandler: signedIn, schema: { params: params() } },
    async (request, reply) => {
      const me = await insider(request, reply);
      if (!me) return reply;
      const members = await teams.members(request.params.id);
      return {
        role: me,
        members: members.map((m) => ({
          id: m.userId,
          name: m.name,
          email: m.email,
          avatar: m.avatar,
          role: m.role,
          joinedAt: m.joinedAt,
          disabled: m.disabled,
        })),
      };
    },
  );

  app.patch<{ Params: { id: string; userId: string }; Body: { role: MemberRole } }>(
    '/api/workspaces/:id/members/:userId',
    {
      preHandler: signedIn,
      schema: {
        params: params('userId'),
        body: { type: 'object', required: ['role'], properties: { role } },
      },
    },
    async (request, reply) => {
      const me = await manager(request, reply);
      if (!me) return reply;
      const { id, userId } = request.params;
      const current = await store.roleOf(id, userId);
      if (!current) return fail(reply, 404, 'not_found', 'Not a member of this workspace.');
      if ((current === 'owner' || request.body.role === 'owner') && me !== 'owner') {
        return fail(reply, 403, 'forbidden', 'Only owners can change who is an owner.');
      }
      if (current === request.body.role) return { ok: true };
      if (!(await teams.setRole(id, userId, request.body.role))) {
        return fail(reply, 409, 'last_owner', 'A workspace needs at least one owner.');
      }
      request.log.info({ workspaceId: id, userId, role: request.body.role }, 'role changed');
      await changed(id);
      ctx.realtime.disconnect(id, userId, false);
      return { ok: true };
    },
  );

  // Remove someone, or leave (your own id).
  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/workspaces/:id/members/:userId',
    { preHandler: signedIn, schema: { params: params('userId') } },
    async (request, reply) => {
      const { id, userId } = request.params;
      const self = userId === request.auth!.user.id;
      const me = self ? await roleIn(request, reply) : await manager(request, reply);
      if (!me) return reply;
      const current = await store.roleOf(id, userId);
      if (!current) return fail(reply, 404, 'not_found', 'Not a member of this workspace.');
      if (!self && current === 'owner' && me !== 'owner') {
        return fail(reply, 403, 'forbidden', 'Only owners can remove an owner.');
      }
      if (!(await teams.removeMember(id, userId))) {
        return fail(
          reply,
          409,
          'last_owner',
          self
            ? 'You’re the only owner. Make someone else an owner first.'
            : 'A workspace needs at least one owner.',
        );
      }
      request.log.info({ workspaceId: id, userId, self }, 'member removed');
      await changed(id);
      ctx.realtime.disconnect(id, userId, true);
      return { ok: true };
    },
  );

  // --- Invites ---------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/invites',
    { preHandler: signedIn, schema: { params: params() } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const invites = await teams.pendingInvites(request.params.id);
      return {
        invites: invites.map((i) => ({
          id: i.id,
          email: i.email,
          role: i.role,
          invitedBy: i.invitedBy,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
        })),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { emails: string[]; role: Exclude<MemberRole, 'owner'> };
  }>(
    '/api/workspaces/:id/invites',
    {
      preHandler: signedIn,
      schema: {
        params: params(),
        body: {
          type: 'object',
          required: ['emails', 'role'],
          properties: {
            emails: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_INVITES_PER_REQUEST,
              items: email,
            },
            role: inviteRole,
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id } = request.params;
      const workspace = (await store.getWorkspace(id))!;
      const inviter = request.auth!.user;
      const memberEmails = new Set((await teams.members(id)).map((m) => m.email));
      const emails = [...new Set(request.body.emails.map(normalizeEmail))];
      const invites = [];
      const skipped = [];
      for (const address of emails) {
        if (memberEmails.has(address)) {
          skipped.push(address);
          continue;
        }
        const token = randomToken();
        const invite = await teams.createInvite({
          workspaceId: id,
          email: address,
          role: request.body.role,
          token,
          invitedBy: inviter.id,
          ttlMs: INVITE_TTL_MS,
        });
        const link = `${ctx.config.publicUrl}/invite/${token}`;
        let emailed = false;
        if (ctx.mailer) {
          try {
            await ctx.mailer.send({
              to: address,
              subject: `${inviter.name} invited you to ${workspace.name}`,
              text:
                `${inviter.name} invited you to join the workspace “${workspace.name}”.\n\n` +
                `Open this link to accept (it works once, for ${address}, ` +
                `for the next 7 days):\n\n${link}\n`,
            });
            emailed = true;
          } catch (error) {
            request.log.warn({ err: error }, 'invite email failed');
          }
        }
        invites.push({
          id: invite.id,
          email: invite.email,
          role: invite.role,
          expiresAt: invite.expiresAt,
          // Only shown now: the server keeps just a hash of the token.
          link,
          emailed,
        });
      }
      request.log.info({ workspaceId: id, count: invites.length }, 'invited');
      return reply.code(201).send({ invites, skipped });
    },
  );

  app.delete<{ Params: { id: string; inviteId: string } }>(
    '/api/workspaces/:id/invites/:inviteId',
    { preHandler: signedIn, schema: { params: params('inviteId') } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      if (!(await teams.revokeInvite(request.params.id, request.params.inviteId))) {
        return fail(reply, 404, 'not_found', 'No such pending invite.');
      }
      return { ok: true };
    },
  );

  // --- Groups ----------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/groups',
    { preHandler: signedIn, schema: { params: params() } },
    async (request, reply) => {
      if (!(await insider(request, reply))) return reply;
      return { groups: await teams.groups(request.params.id) };
    },
  );

  app.post<{ Params: { id: string }; Body: { name: string } }>(
    '/api/workspaces/:id/groups',
    {
      preHandler: signedIn,
      schema: {
        params: params(),
        body: { type: 'object', required: ['name'], properties: { name: groupName } },
      },
    },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      if (!request.body.name.trim()) return fail(reply, 400, 'invalid', 'Name the group.');
      const group = await teams.createGroup(request.params.id, request.body.name);
      if (!group) return fail(reply, 409, 'taken', 'There is already a group with this name.');
      return reply.code(201).send({ group });
    },
  );

  app.patch<{ Params: { id: string; groupId: string }; Body: { name: string } }>(
    '/api/workspaces/:id/groups/:groupId',
    {
      preHandler: signedIn,
      schema: {
        params: params('groupId'),
        body: { type: 'object', required: ['name'], properties: { name: groupName } },
      },
    },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      if (!request.body.name.trim()) return fail(reply, 400, 'invalid', 'Name the group.');
      const result = await teams.renameGroup(
        request.params.id,
        request.params.groupId,
        request.body.name,
      );
      if (result === 'missing') return fail(reply, 404, 'not_found', 'No such group.');
      if (result === 'taken') {
        return fail(reply, 409, 'taken', 'There is already a group with this name.');
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; groupId: string } }>(
    '/api/workspaces/:id/groups/:groupId',
    { preHandler: signedIn, schema: { params: params('groupId') } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      if (!(await teams.deleteGroup(request.params.id, request.params.groupId))) {
        return fail(reply, 404, 'not_found', 'No such group.');
      }
      return { ok: true };
    },
  );

  app.put<{ Params: { id: string; groupId: string; userId: string } }>(
    '/api/workspaces/:id/groups/:groupId/members/:userId',
    { preHandler: signedIn, schema: { params: params('groupId', 'userId') } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id, groupId, userId } = request.params;
      if (!(await teams.addToGroup(id, groupId, userId))) {
        return fail(reply, 404, 'not_found', 'No such group, or not a member of the workspace.');
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; groupId: string; userId: string } }>(
    '/api/workspaces/:id/groups/:groupId/members/:userId',
    { preHandler: signedIn, schema: { params: params('groupId', 'userId') } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id, groupId, userId } = request.params;
      if (!(await teams.removeFromGroup(id, groupId, userId))) {
        return fail(reply, 404, 'not_found', 'Not in this group.');
      }
      return { ok: true };
    },
  );
}

/** Invite links: what one is for (no sign-in needed), and accepting it. */
export function inviteRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { teams } = ctx.store;
  const token = {
    type: 'object',
    properties: { token: { type: 'string', minLength: 1, maxLength: 200 } },
  } as const;
  const rateLimit = { max: 30, timeWindow: '1 minute' };

  app.get<{ Params: { token: string } }>(
    '/api/invites/:token',
    { config: { rateLimit }, schema: { params: token } },
    async (request, reply) => {
      const info = await teams.inviteInfo(request.params.token);
      if (!info) return fail(reply, 404, 'not_found', 'This invite link is not valid.');
      return {
        invite: {
          workspace: info.workspace.name,
          email: info.email,
          role: info.role,
          invitedBy: info.invitedByName,
          status: info.status,
        },
      };
    },
  );

  app.post<{ Params: { token: string } }>(
    '/api/invites/:token/accept',
    { preHandler: signedIn, config: { rateLimit }, schema: { params: token } },
    async (request, reply) => {
      const user = request.auth!.user;
      const result = await teams.acceptInvite(request.params.token, user);
      if (!result.ok) {
        switch (result.reason) {
          case 'not_found':
            return fail(reply, 404, 'not_found', 'This invite link is not valid.');
          case 'wrong_account': {
            const info = await teams.inviteInfo(request.params.token);
            return fail(
              reply,
              403,
              'wrong_account',
              `This invite is for ${info?.email ?? 'someone else'}, and you’re signed in as ${user.email}.`,
            );
          }
          case 'expired':
            return fail(reply, 410, 'expired', 'This invite has expired. Ask for a new one.');
          case 'revoked':
            return fail(reply, 410, 'revoked', 'This invite was withdrawn.');
          default:
            return fail(reply, 410, 'used', 'This invite has already been used.');
        }
      }
      await ctx.members.refresh(result.workspaceId);
      const workspace = (await ctx.store.getWorkspace(result.workspaceId))!;
      request.log.info({ workspaceId: workspace.id, userId: user.id }, 'invite accepted');
      return { workspace: { id: workspace.id, name: workspace.name, role: result.role } };
    },
  );
}

/** Whether `invite` is a valid workspace invite for `address` (sign-up when invite-only). */
export async function workspaceInviteFor(
  ctx: ServerContext,
  invite: string,
  address: string,
): Promise<boolean> {
  const info = await ctx.store.teams.inviteInfo(invite);
  return info?.status === 'valid' && info.email === normalizeEmail(address);
}
