/**
 * Button steps that need the server (Phase 6 M4): a button runs in the app, but its
 * "Send webhook" and "Send notification" steps go through here, so they leave from the
 * server (past the webhook guard, signed) and reach people's inboxes.
 *
 * - `POST /api/workspaces/:id/buttons/webhook`: queue a signed POST (as an automation's
 *   webhook is), for someone who can edit the doc the button is in.
 * - `POST /api/workspaces/:id/buttons/notify`: tell members who can see that doc.
 * - `GET /api/workspaces/:id/buttons/secret`: the secret button webhooks are signed with
 *   (one per workspace), for members who can edit something.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { atLeast } from '../access/roles';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { BUTTON_SECRET, type ButtonWebhookBody, type DeliverPayload } from '../automations/runner';
import { webhookUrlProblem } from '../webhooks/deliver';

const uuid = { type: 'string', format: 'uuid' } as const;
const docId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\w-]+$' } as const;
const params = { type: 'object', properties: { id: uuid } } as const;
const label = { type: 'string', maxLength: 200 } as const;
const MAX_BODY = 64 * 1024;

interface WebhookBody {
  /** The doc the button is in: its page, or the database of a button property. */
  docId: string;
  /** What it's about (the page, or the row), for the receiver and a failure notice. */
  pageId?: string | null;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
  label?: string;
}

interface NotifyBody {
  docId: string;
  pageId?: string | null;
  people: string[];
  message: string;
  label?: string;
}

type Params = { id: string };

export function buttonRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);

  /** Can the caller edit the doc the button is in? (404 if they can't see it, else 403.) */
  async function mayPress(
    request: FastifyRequest<{ Params: Params; Body: { docId: string } }>,
    reply: FastifyReply,
  ) {
    const userId = request.auth!.user.id;
    const access = await ctx.access.workspace(request.params.id);
    const { docId } = request.body;
    if (!access.isMember(userId) || access.placementOf(docId) === undefined) {
      void fail(reply, 404, 'not_found', 'No such page.');
      return null;
    }
    const roles = access.roles(userId);
    if (!access.canRead(roles, docId)) {
      void fail(reply, 404, 'not_found', 'No such page.');
      return null;
    }
    if (!(await access.canWrite(roles, docId, null))) {
      void fail(reply, 403, 'forbidden', 'Only people who can edit this page use its buttons.');
      return null;
    }
    return access;
  }

  app.post<{ Params: Params; Body: WebhookBody }>(
    '/api/workspaces/:id/buttons/webhook',
    {
      preHandler: signedIn,
      bodyLimit: MAX_BODY,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['docId', 'url'],
          additionalProperties: false,
          properties: {
            docId,
            pageId: { anyOf: [docId, { type: 'null' }] },
            url: { type: 'string', maxLength: 2048 },
            headers: {
              type: 'object',
              maxProperties: 20,
              additionalProperties: { type: 'string', maxLength: 1024 },
            },
            data: {},
            label,
          },
        },
      },
    },
    async (request, reply) => {
      if (!(await mayPress(request, reply))) return reply;
      const { id } = request.params;
      const b = request.body;
      const problem = webhookUrlProblem(b.url, ctx.config.webhooks);
      if (problem) return fail(reply, 400, 'invalid_url', problem);
      const userId = request.auth!.user.id;
      const body: ButtonWebhookBody = {
        source: { type: 'button', pageId: b.pageId ?? null, userId },
        data: b.data ?? null,
        triggeredAt: new Date().toISOString(),
      };
      const payload: DeliverPayload = {
        databaseId: b.docId,
        automationId: '',
        url: b.url,
        headers: b.headers ?? {},
        body,
        button: { userId, label: b.label ?? '', pageId: b.pageId ?? null },
      };
      await ctx.store.jobs.enqueue([
        { workspaceId: id, kind: 'webhook.deliver', payload, maxAttempts: 5 },
      ]);
      void ctx.jobs.poke();
      return reply.code(202).send({ queued: true });
    },
  );

  app.post<{ Params: Params; Body: NotifyBody }>(
    '/api/workspaces/:id/buttons/notify',
    {
      preHandler: signedIn,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['docId', 'people', 'message'],
          additionalProperties: false,
          properties: {
            docId,
            pageId: { anyOf: [docId, { type: 'null' }] },
            people: { type: 'array', maxItems: 50, items: uuid },
            message: { type: 'string', maxLength: 500 },
            label,
          },
        },
      },
    },
    async (request, reply) => {
      const access = await mayPress(request, reply);
      if (!access) return reply;
      const b = request.body;
      let sent = 0;
      for (const userId of new Set(b.people)) {
        // Only members who can see the page hear about it.
        if (!access.isMember(userId) || !access.canRead(access.roles(userId), b.docId)) continue;
        await ctx.notifier.automationNotice(request.params.id, {
          userId,
          databaseId: b.docId,
          pageId: b.pageId ?? null,
          title: b.label || 'Button',
          text: b.message || b.label || 'A button was pressed',
        });
        sent++;
      }
      return { sent };
    },
  );

  app.get<{ Params: Params }>(
    '/api/workspaces/:id/buttons/secret',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      const userId = request.auth!.user.id;
      const access = await ctx.access.workspace(request.params.id);
      const roles = access.isMember(userId) ? access.roles(userId) : new Map();
      if (![...roles.values()].some((role) => atLeast(role, 'edit'))) {
        return fail(reply, 403, 'forbidden', 'Only people who can edit pages see this.');
      }
      return {
        secret: await ctx.store.automationSecrets.get(
          request.params.id,
          BUTTON_SECRET.databaseId,
          BUTTON_SECRET.automationId,
        ),
      };
    },
  );
}
