import type { FastifyInstance } from 'fastify';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';

const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** The workspaces a signed-in user belongs to. */
export function workspaceRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;

  app.get('/api/workspaces', { preHandler: signedIn }, async (request) => ({
    workspaces: (await store.workspacesOf(request.auth!.user.id)).map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      createdAt: w.createdAt,
    })),
  }));

  app.post<{ Body: { name: string } }>(
    '/api/workspaces',
    {
      preHandler: signedIn,
      schema: { body: { type: 'object', required: ['name'], properties: { name } } },
    },
    async (request, reply) => {
      const title = request.body.name.trim();
      if (!title) return fail(reply, 400, 'invalid', 'Name the workspace.');
      const workspace = await store.createWorkspace(title, request.auth!.user.id);
      return reply.code(201).send({ workspace: { ...workspace, role: 'owner' } });
    },
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/workspaces/:id',
    {
      preHandler: signedIn,
      schema: {
        params: idParams,
        body: { type: 'object', required: ['name'], properties: { name } },
      },
    },
    async (request, reply) => {
      const role = await store.roleOf(request.params.id, request.auth!.user.id);
      // Not a member: as far as they can tell, it doesn't exist.
      if (!role) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (role !== 'owner' && role !== 'admin') {
        return fail(reply, 403, 'forbidden', 'Only owners and admins can rename a workspace.');
      }
      const title = request.body.name.trim();
      if (!title) return fail(reply, 400, 'invalid', 'Name the workspace.');
      await store.renameWorkspace(request.params.id, title);
      return { workspace: { ...(await store.getWorkspace(request.params.id))!, role } };
    },
  );
}
