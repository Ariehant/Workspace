/**
 * Share links (Phase 8 N8, #34): someone with full access to a page makes a link for it, with
 * a role (view, comment or edit) and maybe an end date. Whoever opens it signs in (or signs
 * up); not yet in the workspace, they join it as a guest; then they get the link's role on
 * that page (never less than they had). The page is shared on its own first, so the link
 * gives nothing else.
 */
import { MEMBERS_DOC_ID, listPages } from '@workspace/core';
import * as Y from 'yjs';
import { SHARE_LINK_ROLES, type ShareLink } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { RANK, atLeast } from '../access/roles';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';

const uuid = { type: 'string', format: 'uuid' } as const;
const pageId = { type: 'string', minLength: 1, maxLength: 128 } as const;
const token = {
  type: 'string',
  minLength: 10,
  maxLength: 64,
  pattern: '^[A-Za-z0-9_-]+$',
} as const;
/** How long a link may last, in days (none: until turned off). */
const MAX_DAYS = 365;

type Params = { id: string; pageId: string };

export function shareLinkRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store, config } = ctx;
  const rateLimit = { max: 30, timeWindow: '1 minute' };
  const urlOf = (link: ShareLink) => `${config.publicUrl}/s/${link.token}`;
  const describe = (link: ShareLink) => ({
    url: urlOf(link),
    role: link.role,
    expiresAt: link.expiresAt,
    createdAt: link.createdAt,
  });

  /**
   * A page's place: its scope and title. From the search index, or (a page made a moment
   * ago, not indexed yet) the scopes' page trees. Null for a row (shared with its database).
   */
  async function target(workspaceId: string, id: string) {
    const entry = await store.search.entry(workspaceId, id);
    if (entry?.databaseId) return null;
    if (entry?.scopeId) return { pageId: id, scopeId: entry.scopeId, title: entry.title };
    const access = await ctx.access.workspace(workspaceId);
    for (const treeDoc of access.treeDocs()) {
      const state = await store.docState(workspaceId, treeDoc);
      if (!state) continue;
      const tree = new Y.Doc();
      Y.applyUpdate(tree, state);
      const page = listPages(tree).find((p) => p.id === id);
      tree.destroy();
      const scopeId = page ? access.scopeOfTree(treeDoc) : undefined;
      if (page && scopeId) return { pageId: id, scopeId, title: page.title };
    }
    return null;
  }

  /** The page, if the caller has full access to it (else an error is sent). */
  async function sharable(request: FastifyRequest<{ Params: Params }>, reply: FastifyReply) {
    const { id, pageId: page } = request.params;
    const access = await ctx.access.workspace(id);
    const userId = request.auth!.user.id;
    const found = page === MEMBERS_DOC_ID ? null : await target(id, page);
    if (!access.isMember(userId) || !found) {
      void fail(reply, 404, 'not_found', 'No such page.');
      return null;
    }
    if (!atLeast(access.roles(userId).get(found.scopeId), 'full')) {
      void fail(reply, 403, 'forbidden', 'You need full access to share this page.');
      return null;
    }
    return { access, found };
  }

  // The page's link, if it has one.
  app.get<{ Params: Params }>(
    '/api/workspaces/:id/pages/:pageId/link',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, pageId } } },
    },
    async (request, reply) => {
      if (!(await sharable(request, reply))) return reply;
      const link = await store.shareLinks.get(request.params.id, request.params.pageId);
      return { link: link ? describe(link) : null };
    },
  );

  // A new link (the old one stops working).
  app.put<{
    Params: Params;
    Body: { role: (typeof SHARE_LINK_ROLES)[number]; days: number | null };
  }>(
    '/api/workspaces/:id/pages/:pageId/link',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, pageId } },
        body: {
          type: 'object',
          required: ['role', 'days'],
          properties: {
            role: { type: 'string', enum: SHARE_LINK_ROLES },
            days: { type: ['integer', 'null'], minimum: 1, maximum: MAX_DAYS },
          },
        },
      },
    },
    async (request, reply) => {
      const ok = await sharable(request, reply);
      if (!ok) return reply;
      const { id, pageId: page } = request.params;
      // Shared on its own first: granting on its scope then gives this page alone.
      const from = ok.access.scope(ok.found.scopeId);
      const scope = from
        ? await ctx.sharing.locked(id, () => ctx.sharing.scopeToShare(id, page, from))
        : null;
      if (!scope) return fail(reply, 404, 'not_found', 'No such page.');
      const { days } = request.body;
      const link = await store.shareLinks.create({
        workspaceId: id,
        pageId: page,
        role: request.body.role,
        title: ok.found.title,
        expiresAt: days === null ? null : Date.now() + days * 86_400_000,
        createdBy: request.auth!.user.id,
      });
      request.log.info({ workspaceId: id, pageId: page, role: link.role }, 'share link made');
      return { link: describe(link) };
    },
  );

  // Turn the link off. (Whoever joined through it keeps their access, as with an invite.)
  app.delete<{ Params: Params }>(
    '/api/workspaces/:id/pages/:pageId/link',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, pageId } } },
    },
    async (request, reply) => {
      if (!(await sharable(request, reply))) return reply;
      await store.shareLinks.remove(request.params.id, request.params.pageId);
      return { ok: true };
    },
  );

  /** A link that can be used now, or an error sent. */
  async function usable(linkToken: string, reply: FastifyReply) {
    const link = await store.shareLinks.byToken(linkToken);
    if (!link) {
      void fail(reply, 404, 'not_found', 'This link isn’t valid (it may have been turned off).');
      return null;
    }
    if (link.expiresAt !== null && link.expiresAt <= Date.now()) {
      void fail(reply, 410, 'expired', 'This link has expired. Ask for a new one.');
      return null;
    }
    return link;
  }

  // What a link opens, before signing in: the page's title, the workspace and the role.
  app.get<{ Params: { token: string } }>(
    '/api/links/:token',
    { config: { rateLimit }, schema: { params: { type: 'object', properties: { token } } } },
    async (request, reply) => {
      const link = await usable(request.params.token, reply);
      if (!link) return reply;
      const workspace = await store.getWorkspace(link.workspaceId);
      return {
        workspace: { name: workspace?.name ?? '' },
        page: { title: link.title },
        role: link.role,
        expiresAt: link.expiresAt,
      };
    },
  );

  // Use it: join (as a guest) if need be, and get its role on the page.
  app.post<{ Params: { token: string } }>(
    '/api/links/:token/accept',
    {
      preHandler: signedIn,
      config: { rateLimit },
      schema: { params: { type: 'object', properties: { token } } },
    },
    async (request, reply) => {
      const link = await usable(request.params.token, reply);
      if (!link) return reply;
      const { workspaceId, pageId: page } = link;
      const user = request.auth!.user;
      if (!(await store.roleOf(workspaceId, user.id))) {
        await store.teams.addMember(workspaceId, user.id, 'guest');
        await ctx.members.refresh(workspaceId);
        await ctx.access.changed(workspaceId);
      }
      const found = await target(workspaceId, page);
      const access = await ctx.access.workspace(workspaceId);
      const from = found ? access.scope(found.scopeId) : undefined;
      if (!found || !from) return fail(reply, 404, 'not_found', 'That page isn’t there any more.');
      const shared = await ctx.sharing.locked(workspaceId, async () => {
        const scope = await ctx.sharing.scopeToShare(workspaceId, page, from);
        if (!scope) return null;
        const had = (await ctx.access.workspace(workspaceId)).roles(user.id).get(scope.id);
        // Never less than they had.
        if (had === undefined || RANK[had] < RANK[link.role]) {
          await ctx.sharing.grant(
            workspaceId,
            scope.id,
            `user:${user.id}`,
            link.role,
            link.createdBy ?? user.id,
          );
        }
        return scope;
      });
      if (!shared) return fail(reply, 404, 'not_found', 'That page isn’t there any more.');
      request.log.info({ workspaceId, pageId: page, userId: user.id }, 'share link used');
      return { workspaceId, pageId: page, role: link.role };
    },
  );
}
