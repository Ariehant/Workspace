import type { NotificationData } from '@workspace/core';
import type { NotificationFilter } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { toData } from './notifier';

const uuid = { type: 'string', format: 'uuid' } as const;
const FILTERS: readonly NotificationFilter[] = ['all', 'mentions', 'unread', 'archived'];
const ids = { type: 'array', maxItems: 500, items: uuid } as const;

/** The inbox: a person's notifications in a workspace, and which pages they follow. */
export function notificationRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  const { notifications } = store;

  /** The caller's id if they're in the workspace (a 404 otherwise). */
  async function member(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<string | null> {
    const userId = request.auth!.user.id;
    if (!(await store.roleOf(request.params.id, userId))) {
      void fail(reply, 404, 'not_found', 'No such workspace.');
      return null;
    }
    return userId;
  }

  /** Can the person read the doc a notification is about (now)? */
  async function readable(workspaceId: string, userId: string) {
    const access = await ctx.access.workspace(workspaceId);
    const roles = access.roles(userId);
    return (docId: string | null) => !docId || access.canRead(roles, docId);
  }

  app.get<{
    Params: { id: string };
    Querystring: { filter?: NotificationFilter; before?: number; limit?: number };
  }>(
    '/api/workspaces/:id/notifications',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid } },
        querystring: {
          type: 'object',
          properties: {
            filter: { type: 'string', enum: FILTERS },
            before: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = await member(request, reply);
      if (!userId) return reply;
      const { id } = request.params;
      const ok = await readable(id, userId);
      const list = await notifications.list(id, userId, {
        filter: request.query.filter,
        before: request.query.before,
        limit: request.query.limit ?? 50,
      });
      const unread = (await notifications.unread(id, userId)).filter((n) => ok(n.docId)).length;
      // Pages the person can no longer read: their notifications aren't shown.
      const shown: NotificationData[] = list.filter((n) => ok(n.docId)).map(toData);
      return { notifications: shown, unread, more: list.length === (request.query.limit ?? 50) };
    },
  );

  app.post<{ Params: { id: string }; Body: { ids?: string[] | null; read?: boolean } }>(
    '/api/workspaces/:id/notifications/read',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid } },
        body: {
          type: 'object',
          properties: { ids: { anyOf: [ids, { type: 'null' }] }, read: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const userId = await member(request, reply);
      if (!userId) return reply;
      await notifications.setRead(
        request.params.id,
        userId,
        request.body.ids ?? null,
        request.body.read ?? true,
      );
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { ids: string[]; archived?: boolean } }>(
    '/api/workspaces/:id/notifications/archive',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid } },
        body: {
          type: 'object',
          required: ['ids'],
          properties: { ids, archived: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const userId = await member(request, reply);
      if (!userId) return reply;
      await notifications.setArchived(
        request.params.id,
        userId,
        request.body.ids,
        request.body.archived ?? true,
      );
      return { ok: true };
    },
  );

  const pageParams = {
    type: 'object',
    properties: { id: uuid, pageId: { type: 'string', minLength: 1, maxLength: 128 } },
  } as const;

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/follow',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request, reply) => {
      const userId = await member(request, reply);
      if (!userId) return reply;
      const { id, pageId } = request.params;
      return { following: await notifications.isFollowing(id, pageId, userId) };
    },
  );

  app.put<{ Params: { id: string; pageId: string }; Body: { following: boolean } }>(
    '/api/workspaces/:id/pages/:pageId/follow',
    {
      preHandler: signedIn,
      schema: {
        params: pageParams,
        body: {
          type: 'object',
          required: ['following'],
          properties: { following: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const userId = await member(request, reply);
      if (!userId) return reply;
      const { id, pageId } = request.params;
      if (!(await readable(id, userId))(pageId)) {
        return fail(reply, 404, 'not_found', 'No such page.');
      }
      await notifications.setFollowing(id, pageId, userId, request.body.following);
      return { following: request.body.following };
    },
  );
}
