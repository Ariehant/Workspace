import type { FastifyInstance } from 'fastify';
import { fail, publicUser, requireAdmin } from './auth/context';
import { randomToken } from './auth/passwords';
import type { ServerContext } from './context';

const DAY = 24 * 3_600_000;

/** Server administration over HTTP (the same as `workspace-admin` on the command line). */
export function adminRoutes(app: FastifyInstance, ctx: ServerContext) {
  const admin = requireAdmin(ctx);
  const { accounts } = ctx.store;

  app.get('/api/admin/users', { preHandler: admin }, async () => ({
    users: (await accounts.listUsers()).map((u) => ({
      ...publicUser(u),
      createdAt: u.createdAt,
      disabled: u.disabledAt !== null,
    })),
  }));

  app.post<{ Body: { email?: string; days?: number } }>(
    '/api/admin/invites',
    {
      preHandler: admin,
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+$' },
            days: { type: 'integer', minimum: 1, maximum: 90 },
          },
        },
      },
    },
    async (request, reply) => {
      const code = randomToken();
      const days = request.body?.days ?? 7;
      await accounts.createInvite({
        code,
        email: request.body?.email ?? null,
        createdBy: request.auth!.user.id,
        ttlMs: days * DAY,
      });
      return reply.code(201).send({ code, expiresInDays: days });
    },
  );

  app.post<{ Params: { id: string }; Body: { disabled: boolean } }>(
    '/api/admin/users/:id/disabled',
    {
      preHandler: admin,
      schema: {
        params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          required: ['disabled'],
          properties: { disabled: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      if (request.params.id === request.auth!.user.id) {
        return fail(reply, 400, 'invalid', "You can't disable your own account.");
      }
      if (!(await accounts.userById(request.params.id))) {
        return fail(reply, 404, 'not_found', 'No such user.');
      }
      await accounts.setDisabled(request.params.id, request.body.disabled);
      return { ok: true };
    },
  );
}
