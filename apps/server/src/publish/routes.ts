/**
 * Pages on the server beyond sync (Phase 5 M7): publishing settings, backlinks, history
 * (versions with their authors) and views. Everything is checked against the caller's
 * access to the doc it's about.
 */
import type { Published } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { hasHistory, type HistoryKeeper } from '../history/keeper';
import { atLeast } from '../access/roles';
import { SLUG, slugFrom, type Site } from './site';

const uuid = { type: 'string', format: 'uuid' } as const;
const docId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\w:-]+$' } as const;
const pageParams = {
  type: 'object',
  properties: { id: uuid, pageId: docId },
} as const;
const LINK_KINDS = ['mention', 'link', 'pageLink', 'synced', 'linkedDatabase'];

type PageRequest = FastifyRequest<{ Params: { id: string; pageId: string } }>;

export function pageRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  site: Site,
  history: HistoryKeeper,
) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  const { pages } = store;
  const origin = new URL(ctx.config.publicUrl).origin;
  /** Where visitors find it. */
  const withUrl = (pub: Published) => ({ ...pub, url: `${origin}/p/${pub.slug}` });

  /**
   * The caller's role on a doc (its scope's), or null after replying 404: outsiders
   * can't tell a doc they can't read from one that doesn't exist.
   */
  async function roleOn(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    doc: string,
  ) {
    const userId = request.auth!.user.id;
    const access = await ctx.access.workspace(request.params.id);
    const role = access.isMember(userId)
      ? access.roles(userId).get(access.placementOf(doc) ?? '')
      : undefined;
    if (!atLeast(role, 'view')) {
      void fail(reply, 404, 'not_found', 'No such page.');
      return null;
    }
    return role!;
  }

  /** Who may read each of these docs. */
  async function readable(request: FastifyRequest<{ Params: { id: string } }>) {
    const access = await ctx.access.workspace(request.params.id);
    const roles = access.roles(request.auth!.user.id);
    return (doc: string) => access.canRead(roles, doc) && access.placementOf(doc) !== undefined;
  }

  // --- Publishing ---------------------------------------------------------------------

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/publish',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      const pub = await pages.published(request.params.id, request.params.pageId);
      return {
        published: pub && withUrl(pub),
        suggestedSlug: slugFrom(await titleOf(request)),
      };
    },
  );

  async function titleOf(request: PageRequest) {
    const { rows } = await store.pool.query<{ title: string }>(
      'SELECT title FROM search_index WHERE workspace_id = $1 AND id = $2',
      [request.params.id, request.params.pageId],
    );
    return rows[0]?.title ?? '';
  }

  app.put<{
    Params: { id: string; pageId: string };
    Body: {
      slug: string;
      includeSubpages?: boolean;
      allowIndexing?: boolean;
      title?: string;
      description?: string;
    };
  }>(
    '/api/workspaces/:id/pages/:pageId/publish',
    {
      preHandler: signedIn,
      schema: {
        params: pageParams,
        body: {
          type: 'object',
          required: ['slug'],
          properties: {
            slug: { type: 'string', maxLength: 64 },
            includeSubpages: { type: 'boolean' },
            allowIndexing: { type: 'boolean' },
            title: { type: 'string', maxLength: 200 },
            description: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const role = await roleOn(request, reply, request.params.pageId);
      if (!role) return reply;
      if (role !== 'full') {
        return fail(reply, 403, 'forbidden', 'Only people with full access can publish.');
      }
      const { id, pageId } = request.params;
      const body = request.body;
      const slug = body.slug.trim().toLowerCase();
      if (!SLUG.test(slug)) {
        return fail(reply, 400, 'invalid', 'Use 3–64 letters, digits and dashes.');
      }
      const before = await pages.published(id, pageId);
      const ok = await pages.publish(
        id,
        pageId,
        {
          slug,
          includeSubpages: body.includeSubpages ?? true,
          allowIndexing: body.allowIndexing ?? false,
          title: body.title?.trim() ?? '',
          description: body.description?.trim() ?? '',
        },
        request.auth!.user.id,
      );
      if (!ok) return fail(reply, 409, 'taken', 'That address is taken.');
      if (before) site.forget(before.slug);
      site.forget(slug);
      request.log.info({ workspaceId: id, pageId, slug }, 'published');
      return { published: withUrl((await pages.published(id, pageId))!) };
    },
  );

  app.delete<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/publish',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      const role = await roleOn(request, reply, request.params.pageId);
      if (!role) return reply;
      if (role !== 'full') {
        return fail(reply, 403, 'forbidden', 'Only people with full access can unpublish.');
      }
      const gone = await pages.unpublish(request.params.id, request.params.pageId);
      if (gone) site.forget(gone.slug);
      return { published: null };
    },
  );

  // --- Backlinks ----------------------------------------------------------------------

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/backlinks',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      const ok = await readable(request);
      const links = await pages.backlinks(request.params.id, request.params.pageId, LINK_KINDS);
      // Only from pages the caller can read (the snippet is their text).
      return { backlinks: links.filter((l) => ok(l.id)) };
    },
  );

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/synced/:pageId/places',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      return {
        places: (await pages.syncedPlaces(request.params.id, request.params.pageId)).length,
      };
    },
  );

  // --- History ------------------------------------------------------------------------

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/docs/:pageId/versions',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      return { versions: await pages.snapshots(request.params.id, request.params.pageId) };
    },
  );

  app.get<{ Params: { id: string; version: number } }>(
    '/api/workspaces/:id/versions/:version',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, version: { type: 'integer' } } },
      },
    },
    async (request, reply) => {
      const found = await pages.snapshotState(request.params.id, request.params.version);
      if (!found || !(await roleOn(request, reply, found.docId))) {
        return reply.sent ? reply : fail(reply, 404, 'not_found', 'No such version.');
      }
      return { docId: found.docId, state: Buffer.from(found.state).toString('base64') };
    },
  );

  // A version now (before restoring an older one, so the restore can be undone).
  app.post<{ Params: { id: string; pageId: string }; Body: { reason?: string } }>(
    '/api/workspaces/:id/docs/:pageId/versions',
    {
      preHandler: signedIn,
      schema: {
        params: pageParams,
        body: {
          type: 'object',
          properties: { reason: { type: 'string', pattern: '^[a-z-]{1,32}$' } },
        },
      },
    },
    async (request, reply) => {
      const role = await roleOn(request, reply, request.params.pageId);
      if (!role) return reply;
      if (!atLeast(role, 'edit') || !hasHistory(request.params.pageId)) {
        return fail(reply, 403, 'forbidden', 'You can’t change this page.');
      }
      const id = await history.snapshot(
        request.params.id,
        request.params.pageId,
        request.body?.reason ?? 'manual',
      );
      return { id };
    },
  );

  // --- Views --------------------------------------------------------------------------

  app.post<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/views',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      await pages.view(request.params.id, request.params.pageId, `u:${request.auth!.user.id}`);
      return { ok: true };
    },
  );

  app.get<{ Params: { id: string; pageId: string } }>(
    '/api/workspaces/:id/pages/:pageId/analytics',
    { preHandler: signedIn, schema: { params: pageParams } },
    async (request: PageRequest, reply) => {
      if (!(await roleOn(request, reply, request.params.pageId))) return reply;
      const { id, pageId } = request.params;
      const days = await pages.views(id, pageId);
      return {
        days,
        views: days.reduce((n, d) => n + d.views, 0),
        viewers: await pages.viewers(id, pageId),
      };
    },
  );
}
