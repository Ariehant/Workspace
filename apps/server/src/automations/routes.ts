/**
 * Automations over REST (Phase 6 M3): an automation's recent runs (who can see the
 * database), and its webhook signing secret (who can edit it: they set up receivers).
 * The automations themselves live in the database doc, edited like any of its parts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { atLeast } from '../access/roles';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';

const uuid = { type: 'string', format: 'uuid' } as const;
const docId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\w-]+$' } as const;
const params = {
  type: 'object',
  properties: { id: uuid, databaseId: docId, automationId: docId },
} as const;

type Params = { id: string; databaseId: string; automationId: string };

export function automationRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);

  /** The caller's role on the database (null, after a 404, if they can't see it). */
  async function roleOn(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    const userId = request.auth!.user.id;
    const access = await ctx.access.workspace(request.params.id);
    const role = access.isMember(userId)
      ? access.roles(userId).get(access.placementOf(request.params.databaseId) ?? '')
      : undefined;
    if (!atLeast(role, 'view')) {
      void fail(reply, 404, 'not_found', 'No such database.');
      return null;
    }
    return role!;
  }

  app.get<{ Params: Params }>(
    '/api/workspaces/:id/automations/:databaseId/:automationId/runs',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      if (!(await roleOn(request, reply))) return reply;
      const { id, automationId } = request.params;
      const jobs = await ctx.store.jobs.recentWhere(
        id,
        'automation.run',
        'automationId',
        automationId,
      );
      return {
        runs: jobs
          .filter(
            (j) => (j.payload as { databaseId?: string }).databaseId === request.params.databaseId,
          )
          .map((j) => ({
            id: j.id,
            at: j.createdAt,
            rowId: (j.payload as { rowId?: string | null }).rowId ?? null,
            status: j.failedAt ? 'failed' : j.doneAt ? 'done' : 'pending',
            error: j.failedAt ? j.lastError : null,
            result: j.result,
          })),
      };
    },
  );

  app.get<{ Params: Params }>(
    '/api/workspaces/:id/automations/:databaseId/:automationId/secret',
    { preHandler: signedIn, schema: { params } },
    async (request, reply) => {
      const role = await roleOn(request, reply);
      if (!role) return reply;
      if (!atLeast(role, 'edit')) {
        return fail(reply, 403, 'forbidden', 'Only someone who can edit the database sees this.');
      }
      const { id, databaseId, automationId } = request.params;
      return { secret: await ctx.store.automationSecrets.get(id, databaseId, automationId) };
    },
  );
}
