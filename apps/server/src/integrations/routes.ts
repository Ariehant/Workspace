/**
 * Integrations in settings (Phase 6 M5): owners and admins make them, set what they
 * may do, rotate their token (shown once) and delete them. Members see the list (name
 * and icon), to connect pages to them through the usual sharing.
 *
 * - `GET /api/workspaces/:id/integrations`
 * - `POST /api/workspaces/:id/integrations` → `{integration, token}`
 * - `PATCH /api/workspaces/:id/integrations/:integrationId`
 * - `POST /api/workspaces/:id/integrations/:integrationId/token` → `{token}`
 * - `DELETE /api/workspaces/:id/integrations/:integrationId`
 *
 * Its webhook subscription (Phase 6 M7), one per integration, as Notion's:
 *
 * - `PUT …/:integrationId/webhook` `{url, events}`: a new URL is sent a verification token
 * - `POST …/:integrationId/webhook/verify` `{token}`: the token pasted back turns it on
 * - `POST …/:integrationId/webhook/resend` (the token again), `…/webhook/resume` (after a
 *   pause), and `DELETE …/:integrationId/webhook`
 */
import {
  DEFAULT_CAPABILITIES,
  type Capabilities,
  type Integration,
  type IntegrationWebhook,
  type MemberRole,
} from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { webhookUrlProblem } from '../webhooks/deliver';
import { WEBHOOK_EVENTS } from '../webhooks/integration-events';

const uuid = { type: 'string', format: 'uuid' } as const;
const params = { type: 'object', properties: { id: uuid, integrationId: uuid } } as const;
const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const icon = { anyOf: [{ type: 'string', maxLength: 16 }, { type: 'null' }] } as const;
const capabilities = {
  type: 'object',
  additionalProperties: false,
  properties: {
    readContent: { type: 'boolean' },
    updateContent: { type: 'boolean' },
    insertContent: { type: 'boolean' },
    readComments: { type: 'boolean' },
    insertComments: { type: 'boolean' },
    userInfo: { type: 'string', enum: ['none', 'noEmail', 'email'] },
  },
} as const;

type Params = { id: string; integrationId: string };

/** What settings show of a webhook subscription (never its token). */
const webhookView = (w: IntegrationWebhook | null | undefined) =>
  w
    ? {
        url: w.url,
        events: w.events,
        verified: w.verified,
        paused: w.pausedAt !== null,
        failingSince: w.failingSince,
        lastError: w.lastError,
      }
    : null;

/** What settings show of an integration (never its token, only its last characters). */
const view = (i: Integration, full: boolean, webhook?: IntegrationWebhook | null) => ({
  id: i.id,
  name: i.name,
  icon: i.icon,
  ...(full && {
    capabilities: i.capabilities,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    tokenHint: i.tokenHint,
    lastUsedAt: i.lastUsedAt,
    webhook: webhookView(webhook),
  }),
});

export function integrationRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  const manages = (r: MemberRole | null) => r === 'owner' || r === 'admin';

  async function roleIn(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<MemberRole | null> {
    const role = await store.roleOf(request.params.id, request.auth!.user.id);
    if (!role || role === 'bot') {
      void fail(reply, 404, 'not_found', 'No such workspace.');
      return null;
    }
    return role;
  }

  async function manager(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) {
    const role = await roleIn(request, reply);
    if (!role) return false;
    if (!manages(role)) {
      void fail(reply, 403, 'forbidden', 'Only owners and admins manage integrations.');
      return false;
    }
    return true;
  }

  /** Who sees and may act on what changed: the members doc and the access model. */
  async function changed(workspaceId: string) {
    await ctx.members.refresh(workspaceId);
    await ctx.access.changed(workspaceId);
  }

  app.get<{ Params: Params }>(
    '/api/workspaces/:id/integrations',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      const role = await roleIn(request, reply);
      if (!role) return reply;
      if (role === 'guest') return { integrations: [] };
      const list = await store.integrations.list(request.params.id);
      const hooks = manages(role)
        ? new Map(
            (await store.integrationWebhooks.list(request.params.id)).map((w) => [
              w.integrationId,
              w,
            ]),
          )
        : new Map<string, IntegrationWebhook>();
      return {
        integrations: list.map((i) => view(i, manages(role), hooks.get(i.id))),
      };
    },
  );

  app.post<{
    Params: Params;
    Body: { name: string; icon?: string | null; capabilities?: Partial<Capabilities> };
  }>(
    '/api/workspaces/:id/integrations',
    {
      preHandler: signedIn,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name, icon, capabilities },
        },
      },
    },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id } = request.params;
      const { integration, token } = await store.integrations.create({
        workspaceId: id,
        name: request.body.name.trim(),
        icon: request.body.icon ?? null,
        capabilities: { ...DEFAULT_CAPABILITIES, ...request.body.capabilities },
        createdBy: request.auth!.user.id,
      });
      await changed(id);
      return reply.code(201).send({ integration: view(integration, true), token });
    },
  );

  app.patch<{
    Params: Params;
    Body: { name?: string; icon?: string | null; capabilities?: Partial<Capabilities> };
  }>(
    '/api/workspaces/:id/integrations/:integrationId',
    {
      preHandler: signedIn,
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { name, icon, capabilities },
        },
      },
    },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id, integrationId } = request.params;
      const current = await store.integrations.get(id, integrationId);
      if (!current) return fail(reply, 404, 'not_found', 'No such integration.');
      const { name: newName, icon: newIcon, capabilities: caps } = request.body;
      const updated = await store.integrations.update(id, integrationId, {
        ...(newName !== undefined && { name: newName.trim() }),
        ...(newIcon !== undefined && { icon: newIcon }),
        ...(caps && { capabilities: { ...current.capabilities, ...caps } }),
      });
      if (newName !== undefined || newIcon !== undefined) await ctx.members.refresh(id);
      return {
        integration: view(updated!, true, await store.integrationWebhooks.get(id, integrationId)),
      };
    },
  );

  app.post<{ Params: Params }>(
    '/api/workspaces/:id/integrations/:integrationId/token',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const token = await store.integrations.rotate(
        request.params.id,
        request.params.integrationId,
      );
      if (!token) return fail(reply, 404, 'not_found', 'No such integration.');
      return { token };
    },
  );

  app.delete<{ Params: Params }>(
    '/api/workspaces/:id/integrations/:integrationId',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await manager(request, reply))) return reply;
      const { id, integrationId } = request.params;
      if (!(await store.integrations.remove(id, integrationId))) {
        return fail(reply, 404, 'not_found', 'No such integration.');
      }
      await changed(id);
      return { ok: true };
    },
  );

  // --- The webhook subscription -----------------------------------------------------

  /** The integration (or a 404 sent), for an owner or admin. */
  async function target(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    if (!(await manager(request, reply))) return null;
    const integration = await store.integrations.get(
      request.params.id,
      request.params.integrationId,
    );
    if (!integration) void fail(reply, 404, 'not_found', 'No such integration.');
    return integration;
  }

  app.put<{ Params: Params; Body: { url: string; events: string[] } }>(
    '/api/workspaces/:id/integrations/:integrationId/webhook',
    {
      preHandler: signedIn,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['url', 'events'],
          additionalProperties: false,
          properties: {
            url: { type: 'string', minLength: 1, maxLength: 2000 },
            events: {
              type: 'array',
              minItems: 1,
              uniqueItems: true,
              items: { type: 'string', enum: [...WEBHOOK_EVENTS] },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await target(request, reply))) return reply;
      const { id, integrationId } = request.params;
      const url = request.body.url.trim();
      const problem = webhookUrlProblem(url, ctx.config.webhooks);
      if (problem) return fail(reply, 400, 'invalid', problem);
      const { webhook, token } = await store.integrationWebhooks.set(
        id,
        integrationId,
        url,
        request.body.events,
      );
      if (token) await ctx.webhooks.requestVerification(id, integrationId, url);
      return { webhook: webhookView(webhook) };
    },
  );

  app.post<{ Params: Params; Body: { token: string } }>(
    '/api/workspaces/:id/integrations/:integrationId/webhook/verify',
    {
      preHandler: signedIn,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['token'],
          additionalProperties: false,
          properties: { token: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      if (!(await target(request, reply))) return reply;
      const { id, integrationId } = request.params;
      if (!(await store.integrationWebhooks.verify(id, integrationId, request.body.token.trim()))) {
        return fail(reply, 400, 'invalid', "That isn't the token sent to the webhook.");
      }
      return { webhook: webhookView(await store.integrationWebhooks.get(id, integrationId)) };
    },
  );

  app.post<{ Params: Params }>(
    '/api/workspaces/:id/integrations/:integrationId/webhook/resend',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await target(request, reply))) return reply;
      const { id, integrationId } = request.params;
      const webhook = await store.integrationWebhooks.get(id, integrationId);
      if (!webhook) return fail(reply, 404, 'not_found', 'No webhook is set up.');
      if (webhook.verified) return fail(reply, 409, 'conflict', 'The webhook is verified already.');
      await ctx.webhooks.requestVerification(id, integrationId, webhook.url);
      return { ok: true };
    },
  );

  app.post<{ Params: Params }>(
    '/api/workspaces/:id/integrations/:integrationId/webhook/resume',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await target(request, reply))) return reply;
      const { id, integrationId } = request.params;
      await store.integrationWebhooks.resume(id, integrationId);
      return { webhook: webhookView(await store.integrationWebhooks.get(id, integrationId)) };
    },
  );

  app.delete<{ Params: Params }>(
    '/api/workspaces/:id/integrations/:integrationId/webhook',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await target(request, reply))) return reply;
      await store.integrationWebhooks.remove(request.params.id, request.params.integrationId);
      return { ok: true };
    },
  );
}
