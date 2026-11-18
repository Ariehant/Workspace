/**
 * Requests for access (Phase 8 N4). Someone in the workspace opens a page they can't read and
 * asks for it; the people who can share it are told, and one of them shares it (or not).
 *
 * The asker learns only that the page exists, never its title or where it is. A database row
 * can't be shared on its own, so asking for a row asks for its database.
 */
import { REQUESTED_ROLES, type AccessRequest, type RequestedRole } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { atLeast } from '../access/roles';
import type { WorkspaceAccess } from '../access/service';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';

const uuid = { type: 'string', format: 'uuid' } as const;
const pageId = { type: 'string', minLength: 1, maxLength: 128 } as const;
const role = { type: 'string', enum: REQUESTED_ROLES } as const;

/** How many requests one person may make in an hour. */
export const REQUESTS_PER_HOUR = 20;
export const MAX_REQUEST_MESSAGE = 500;

type Params = { id: string; pageId: string; requestId: string };

/** What the person asking sees of their request. */
const own = (r: AccessRequest) => ({
  id: r.id,
  role: r.role,
  status: r.status,
  createdAt: r.createdAt,
  decidedAt: r.decidedAt,
});

/** What the people who can share it see. */
const full = (r: AccessRequest) => ({
  ...own(r),
  pageId: r.pageId,
  requesterId: r.requesterId,
  message: r.message,
  decidedBy: r.decidedBy,
});

export function accessRequestRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;

  /** The workspace's access model, if the caller is in it (else a 404 is sent). */
  async function member(
    request: FastifyRequest<{ Params: Partial<Params> & { id: string } }>,
    reply: FastifyReply,
  ): Promise<WorkspaceAccess | null> {
    const userId = request.auth!.user.id;
    let access = await ctx.access.workspace(request.params.id);
    if (!access.isMember(userId) && (await store.roleOf(request.params.id, userId))) {
      await ctx.access.changed(request.params.id); // joined since the model was loaded
      access = await ctx.access.workspace(request.params.id);
    }
    if (!access.isMember(userId)) {
      void fail(reply, 404, 'not_found', 'No such workspace.');
      return null;
    }
    return access;
  }

  /** The page a request is about (a row's database), its scope and title; null if unknown. */
  async function target(workspaceId: string, id: string) {
    const entry = await store.search.entry(workspaceId, id);
    if (!entry) return null;
    if (entry.databaseId) {
      const db = await store.search.entry(workspaceId, entry.databaseId);
      if (!db?.scopeId) return null;
      return { pageId: entry.databaseId, scopeId: db.scopeId, title: db.title };
    }
    if (!entry.scopeId) return null;
    return { pageId: id, scopeId: entry.scopeId, title: entry.title };
  }

  // Can I open this page, and did I ask? (The no-access screen.)
  app.get<{ Params: Params }>(
    '/api/workspaces/:id/pages/:pageId/access',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, pageId } } },
    },
    async (request, reply) => {
      const access = await member(request, reply);
      if (!access) return reply;
      const found = await target(request.params.id, request.params.pageId);
      if (!found) return { exists: false };
      const userId = request.auth!.user.id;
      if (atLeast(access.roles(userId).get(found.scopeId), 'view')) {
        return { exists: true, readable: true };
      }
      const latest = await store.accessRequests.latest(request.params.id, found.pageId, userId);
      return { exists: true, readable: false, request: latest ? own(latest) : null };
    },
  );

  // Ask for access.
  app.post<{ Params: Params; Body: { role: RequestedRole; message?: string } }>(
    '/api/workspaces/:id/pages/:pageId/access-requests',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, pageId } },
        body: {
          type: 'object',
          required: ['role'],
          properties: { role, message: { type: 'string', maxLength: MAX_REQUEST_MESSAGE } },
        },
      },
    },
    async (request, reply) => {
      const access = await member(request, reply);
      if (!access) return reply;
      const { id } = request.params;
      const userId = request.auth!.user.id;
      if (access.isBot(userId)) return fail(reply, 403, 'forbidden', 'Integrations can’t ask.');
      const found = await target(id, request.params.pageId);
      if (!found) return fail(reply, 404, 'not_found', 'No such page.');
      if (atLeast(access.roles(userId).get(found.scopeId), 'view')) {
        return fail(reply, 409, 'conflict', 'You can already open this page.');
      }
      const recent = await store.accessRequests.countSince(
        userId,
        new Date(Date.now() - 60 * 60_000),
      );
      if (recent >= REQUESTS_PER_HOUR) {
        return fail(reply, 429, 'rate_limited', 'Too many requests. Try again later.');
      }
      const created = await store.accessRequests.create({
        workspaceId: id,
        pageId: found.pageId,
        requesterId: userId,
        role: request.body.role,
        message: (request.body.message ?? '').trim(),
      });
      if (!created) return fail(reply, 409, 'conflict', 'You asked already.');
      const sharers = access.sharersOf(found.scopeId).filter((u) => u !== userId);
      await ctx.notifier.accessRequested(id, created, found.title, sharers);
      request.log.info({ workspaceId: id, request: created.id }, 'access requested');
      return reply.code(201).send({ request: own(created) });
    },
  );

  /** A request the caller may answer (full access where its page is), else an error sent. */
  async function answerable(
    request: FastifyRequest<{ Params: Params }>,
    reply: FastifyReply,
  ): Promise<{ access: WorkspaceAccess; req: AccessRequest; scopeId: string } | null> {
    const access = await member(request, reply);
    if (!access) return null;
    const req = await store.accessRequests.get(request.params.id, request.params.requestId);
    const found = req ? await target(request.params.id, req.pageId) : null;
    if (!req || !found) {
      void fail(reply, 404, 'not_found', 'No such request.');
      return null;
    }
    if (!atLeast(access.roles(request.auth!.user.id).get(found.scopeId), 'full')) {
      void fail(reply, 403, 'forbidden', 'You need full access to share this page.');
      return null;
    }
    return { access, req, scopeId: found.scopeId };
  }

  // The requests the caller can answer: pending ones (for one page), or one by id.
  app.get<{ Params: Params; Querystring: { pageId?: string } }>(
    '/api/workspaces/:id/access-requests',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid } },
        querystring: { type: 'object', properties: { pageId } },
      },
    },
    async (request, reply) => {
      const access = await member(request, reply);
      if (!access) return reply;
      const roles = access.roles(request.auth!.user.id);
      const pending = await store.accessRequests.pending(
        request.params.id,
        request.query.pageId ? [request.query.pageId] : null,
      );
      const scopes = new Map<string, string | null>();
      const mine = [];
      for (const r of pending) {
        if (!scopes.has(r.pageId)) {
          scopes.set(r.pageId, (await target(request.params.id, r.pageId))?.scopeId ?? null);
        }
        const scopeId = scopes.get(r.pageId);
        if (scopeId && atLeast(roles.get(scopeId), 'full')) mine.push(full(r));
      }
      return { requests: mine };
    },
  );

  app.get<{ Params: Params }>(
    '/api/workspaces/:id/access-requests/:requestId',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, requestId: uuid } } },
    },
    async (request, reply) => {
      const found = await answerable(request, reply);
      if (!found) return reply;
      return { request: full(found.req) };
    },
  );

  // Share the page with the person who asked (with the role asked for, or another).
  app.post<{ Params: Params; Body: { role?: RequestedRole } }>(
    '/api/workspaces/:id/access-requests/:requestId/approve',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, requestId: uuid } },
        body: { type: 'object', properties: { role } },
      },
    },
    async (request, reply) => {
      const found = await answerable(request, reply);
      if (!found) return reply;
      const { req, access, scopeId } = found;
      const { id } = request.params;
      const userId = request.auth!.user.id;
      if (req.status !== 'pending') return fail(reply, 409, 'conflict', 'Already answered.');
      if (!(await store.roleOf(id, req.requesterId))) {
        return fail(reply, 409, 'conflict', 'They’re no longer in this workspace.');
      }
      const from = access.scope(scopeId);
      if (!from) return fail(reply, 404, 'not_found', 'No such request.');
      const shared = await ctx.sharing.locked(id, async () => {
        const scope = await ctx.sharing.scopeToShare(id, req.pageId, from);
        if (!scope) return null;
        await ctx.sharing.grant(
          id,
          scope.id,
          `user:${req.requesterId}`,
          request.body?.role ?? req.role,
          userId,
        );
        return scope;
      });
      if (!shared) return fail(reply, 404, 'not_found', 'That page isn’t there any more.');
      const decided = await store.accessRequests.decide(id, req.id, 'approved', userId);
      await store.notifications.readByKey(id, `request:${req.id}`);
      request.log.info(
        { workspaceId: id, request: req.id, scopeId: shared.id },
        'request approved',
      );
      return { request: full(decided ?? req) };
    },
  );

  app.post<{ Params: Params }>(
    '/api/workspaces/:id/access-requests/:requestId/decline',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, requestId: uuid } } },
    },
    async (request, reply) => {
      const found = await answerable(request, reply);
      if (!found) return reply;
      const { id } = request.params;
      const decided = await store.accessRequests.decide(
        id,
        found.req.id,
        'declined',
        request.auth!.user.id,
      );
      if (!decided) return fail(reply, 409, 'conflict', 'Already answered.');
      await store.notifications.readByKey(id, `request:${found.req.id}`);
      return { request: full(decided) };
    },
  );
}
