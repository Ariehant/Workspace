/**
 * "Allow duplicate as template" (Phase 8 #35): a published page whose publisher allows it can
 * be copied by a visitor into one of their workspaces (their private pages there), as the
 * site shows it: the page, and its sub-pages if those are published too. The site links to
 * `/d/<slug>` in the web app, which signs them in and asks where.
 *
 * - `GET /api/published/:slug/duplicate`: what it is (its title), for anyone.
 * - `POST /api/published/:slug/duplicate`, `{ to }`: the copy, signed in, into a workspace
 *   they're a member of (not a guest).
 */
import { getPage, isInTrash } from '@workspace/core';
import { captureBundle } from '@workspace/database';
import { selectPages } from '@workspace/exporters';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';
import { EditRefused } from '../docs-edit';
import { copyBundleInto } from '../move-routes';
import { SLUG } from './site';

const uuid = { type: 'string', format: 'uuid' } as const;

export function duplicateRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;

  /** The published page, if it may be duplicated; with its tree. */
  async function find(slug: string) {
    const pub = SLUG.test(slug) ? await store.pages.bySlug(slug) : null;
    if (!pub?.allowDuplicate) return null;
    const access = await ctx.access.workspace(pub.workspaceId);
    const scope = access.scope(access.placementOf(pub.pageId) ?? '');
    if (!scope) return null;
    const state = await store.docState(pub.workspaceId, scope.treeDoc);
    if (!state) return null;
    const tree = new Y.Doc();
    Y.applyUpdate(tree, state);
    const page = getPage(tree, pub.pageId);
    if (!page || isInTrash(tree, pub.pageId)) {
      tree.destroy();
      return null;
    }
    return { pub, tree, page };
  }

  const gone = (reply: Parameters<typeof fail>[0]) =>
    fail(reply, 404, 'not_found', 'This page isn’t published to duplicate.');

  app.get<{ Params: { slug: string } }>(
    '/api/published/:slug/duplicate',
    async (request, reply) => {
      const found = await find(request.params.slug);
      if (!found) return gone(reply);
      found.tree.destroy();
      return {
        title: found.pub.title || found.page.title,
        includeSubpages: found.pub.includeSubpages,
      };
    },
  );

  app.post<{ Params: { slug: string }; Body: { to: string } }>(
    '/api/published/:slug/duplicate',
    {
      preHandler: signedIn,
      schema: { body: { type: 'object', required: ['to'], properties: { to: uuid } } },
    },
    async (request, reply) => {
      const userId = request.auth!.user.id;
      const { to } = request.body;
      const role = await store.roleOf(to, userId);
      if (!role) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (role === 'guest') {
        return fail(reply, 403, 'forbidden', 'Guests can’t add pages to that workspace.');
      }
      const found = await find(request.params.slug);
      if (!found) return gone(reply);
      const { pub, tree } = found;
      try {
        // Exactly what the site shows: the page, and its sub-pages if they're published.
        const shown = new Set(
          selectPages(tree, [pub.pageId], pub.includeSubpages).map((s) => s.page.id),
        );
        const bundle = await captureBundle(
          tree,
          pub.pageId,
          async (id, use) => {
            const doc = new Y.Doc();
            const state = await store.docState(pub.workspaceId, id);
            if (state) Y.applyUpdate(doc, state);
            try {
              return use(doc);
            } finally {
              doc.destroy();
            }
          },
          (page) => shown.has(page.id),
        );
        const pageId = await copyBundleInto(ctx, bundle, { from: pub.workspaceId, to, userId });
        request.log.info({ slug: pub.slug, to }, 'published page duplicated');
        return { workspaceId: to, pageId };
      } catch (error) {
        if (error instanceof EditRefused) {
          return fail(reply, 403, 'forbidden', 'You can’t add pages to that workspace.');
        }
        throw error;
      } finally {
        tree.destroy();
      }
    },
  );
}
