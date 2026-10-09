/**
 * Scopes over HTTP: the ones you can see, teamspaces, your private pages, who has access,
 * and moving a page into another scope (sharing it on its own, or moving it to another
 * teamspace). Changing a scope's access needs full access to it; moving a page needs to
 * be able to edit both sides.
 *
 * Moves are server operations: the server edits both tree docs (as a peer of its own,
 * appending ordinary updates), moves the pages' docs to the new scope, records the move
 * (for devices that were away), and the open connections get what they gained or lost.
 */
import { MEMBERS_DOC_ID, moveSubtree, subtreeIds } from '@workspace/core';
import { isDatabaseDoc, readDatabase } from '@workspace/database';
import type { Scope, ScopeRole, ScopeVisibility } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import { atLeast, rolesFor } from '../access/roles';
import type { Roles } from '../access/service';
import { fail, requireUser } from '../auth/context';
import type { ServerContext } from '../context';

const uuid = { type: 'string', format: 'uuid' } as const;
const scopeName = { type: 'string', maxLength: 100 } as const;
const role = { type: 'string', enum: ['full', 'edit', 'content', 'comment', 'view'] } as const;
// (A type list, not anyOf: type coercion would turn null into '' for the string branch.)
const icon = { type: ['string', 'null'], maxLength: 64 } as const;
const description = { type: 'string', maxLength: 1000 } as const;
const visibility = { type: 'string', enum: ['open', 'closed', 'private'] } as const;
const pageId = { type: 'string', minLength: 1, maxLength: 128 } as const;
const PRINCIPAL = /^(workspace|user:[0-9a-f-]{36}|group:[0-9a-f-]{36})$/;

type Params = { id: string; scopeId: string; pageId: string };

export function scopeRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;
  /** One scope operation at a time per workspace (moves read and write two trees). */
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(workspaceId: string, fn: () => Promise<T>): Promise<T> => {
    const run = (locks.get(workspaceId) ?? Promise.resolve()).then(fn, fn);
    locks.set(
      workspaceId,
      run.catch(() => {}),
    );
    return run;
  };

  /** The caller's roles in the workspace's scopes (404 for outsiders). */
  async function rolesOf(
    request: FastifyRequest<{ Params: Partial<Params> & { id: string } }>,
    reply: FastifyReply,
  ): Promise<Roles | null> {
    const access = await ctx.access.workspace(request.params.id);
    if (!access.isMember(request.auth!.user.id)) {
      if (await store.roleOf(request.params.id, request.auth!.user.id)) {
        // Joined since the model was loaded.
        await ctx.access.changed(request.params.id);
        return (await ctx.access.workspace(request.params.id)).roles(request.auth!.user.id);
      }
      void fail(reply, 404, 'not_found', 'No such workspace.');
      return null;
    }
    return access.roles(request.auth!.user.id);
  }

  /** A scope of the workspace the caller has at least `needed` in (404 if they can't see it). */
  async function scopeWith(
    request: FastifyRequest<{ Params: Partial<Params> & { id: string } }>,
    reply: FastifyReply,
    scopeId: string,
    needed: ScopeRole,
  ): Promise<{ scope: Scope; roles: Roles } | null> {
    const roles = await rolesOf(request, reply);
    if (!roles) return null;
    const scope = (await ctx.access.workspace(request.params.id)).scope(scopeId);
    if (!scope || !roles.has(scopeId)) {
      void fail(reply, 404, 'not_found', 'No such scope.');
      return null;
    }
    if (!atLeast(roles.get(scopeId), needed)) {
      void fail(
        reply,
        403,
        'forbidden',
        needed === 'full'
          ? 'You need full access to change who can see this.'
          : 'You can’t edit this.',
      );
      return null;
    }
    return { scope, roles };
  }

  const describe = (scope: Scope, r: ScopeRole) => ({
    id: scope.id,
    kind: scope.kind,
    name: scope.name,
    treeDoc: scope.treeDoc,
    parentId: scope.parentId,
    inherit: scope.inherit,
    icon: scope.icon,
    description: scope.description,
    visibility: scope.visibility,
    joinRole: scope.joinRole,
    role: r,
  });

  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/scopes',
    { preHandler: signedIn, schema: { params: { type: 'object', properties: { id: uuid } } } },
    async (request, reply) => {
      const roles = await rolesOf(request, reply);
      if (!roles) return reply;
      const access = await ctx.access.workspace(request.params.id);
      const model = await store.scopes.model(request.params.id);
      // Who has access is shown to the workspace's own people (guests see only theirs).
      const guest = (await store.roleOf(request.params.id, request.auth!.user.id)) === 'guest';
      return {
        defaultScopeId: access.defaultScopeId,
        scopes: [...roles].flatMap(([id, r]) => {
          const scope = access.scope(id);
          if (!scope) return [];
          const entries =
            !guest || r === 'full'
              ? model.entries
                  .filter((e) => e.scopeId === id)
                  .map((e) => ({ principal: e.principal, role: e.role }))
              : undefined;
          return [{ ...describe(scope, r), ...(entries ? { access: entries } : {}) }];
        }),
      };
    },
  );

  // Every teamspace the caller can find: theirs, and the workspace's open and closed ones.
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/teamspaces',
    { preHandler: signedIn, schema: { params: { type: 'object', properties: { id: uuid } } } },
    async (request, reply) => {
      const roles = await rolesOf(request, reply);
      if (!roles) return reply;
      const guest = (await store.roleOf(request.params.id, request.auth!.user.id)) === 'guest';
      const model = await store.scopes.model(request.params.id);
      return {
        teamspaces: model.scopes
          .filter((s) => s.kind === 'teamspace')
          .filter((s) => roles.has(s.id) || (!guest && s.visibility !== 'private'))
          .map((s) => ({
            ...describe(s, roles.get(s.id) ?? 'view'),
            role: roles.get(s.id) ?? null,
            members: model.entries.filter(
              (e) => e.scopeId === s.id && e.principal.startsWith('user:'),
            ).length,
            everyone:
              model.entries.find((e) => e.scopeId === s.id && e.principal === 'workspace')?.role ??
              null,
          })),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      name: string;
      everyone?: ScopeRole | null;
      icon?: string | null;
      description?: string;
      visibility?: ScopeVisibility;
      joinRole?: ScopeRole;
    };
  }>(
    '/api/workspaces/:id/teamspaces',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid } },
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: scopeName,
            everyone: { anyOf: [role, { type: 'null' }] },
            icon,
            description,
            visibility,
            joinRole: role,
          },
        },
      },
    },
    async (request, reply) => {
      const memberRole = await store.roleOf(request.params.id, request.auth!.user.id);
      if (!memberRole) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (memberRole === 'guest') {
        return fail(reply, 403, 'forbidden', 'Guests can’t create teamspaces.');
      }
      const name = request.body.name.trim();
      if (!name) return fail(reply, 400, 'invalid', 'Name the teamspace.');
      const everyone = request.body.everyone === undefined ? 'edit' : request.body.everyone;
      const scope = await store.scopes.create({
        workspaceId: request.params.id,
        kind: 'teamspace',
        name,
        icon: request.body.icon ?? null,
        description: request.body.description?.trim() ?? '',
        visibility: request.body.visibility ?? 'open',
        joinRole: request.body.joinRole ?? 'edit',
        access: [
          { principal: `user:${request.auth!.user.id}`, role: 'full' },
          ...(everyone ? [{ principal: 'workspace', role: everyone }] : []),
        ],
      });
      await ctx.access.changed(request.params.id);
      return reply.code(201).send({ scope: describe(scope, 'full') });
    },
  );

  // Join an open teamspace (with its joining role).
  app.post<{ Params: Params }>(
    '/api/workspaces/:id/scopes/:scopeId/join',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, scopeId: uuid } } },
    },
    async (request, reply) => {
      const { id, scopeId } = request.params;
      const userId = request.auth!.user.id;
      const roles = await rolesOf(request, reply);
      if (!roles) return reply;
      const scope = (await ctx.access.workspace(id)).scope(scopeId);
      const guest = (await store.roleOf(id, userId)) === 'guest';
      if (
        !scope ||
        scope.kind !== 'teamspace' ||
        (scope.visibility === 'private' && !roles.has(scopeId))
      ) {
        return fail(reply, 404, 'not_found', 'No such teamspace.');
      }
      if (roles.has(scopeId)) return { ok: true };
      if (guest || scope.visibility !== 'open') {
        return fail(reply, 403, 'forbidden', 'Ask someone in this teamspace to add you.');
      }
      await store.scopes.setAccess(scopeId, `user:${userId}`, scope.joinRole);
      await ctx.access.changed(id);
      return { ok: true };
    },
  );

  // Leave a teamspace you were added to (not one you're in through everyone or a group).
  app.post<{ Params: Params }>(
    '/api/workspaces/:id/scopes/:scopeId/leave',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid, scopeId: uuid } } },
    },
    async (request, reply) => {
      const { id, scopeId } = request.params;
      const userId = request.auth!.user.id;
      const roles = await rolesOf(request, reply);
      if (!roles) return reply;
      const scope = (await ctx.access.workspace(id)).scope(scopeId);
      if (!scope || scope.kind !== 'teamspace' || !roles.has(scopeId)) {
        return fail(reply, 404, 'not_found', 'No such teamspace.');
      }
      const model = await store.scopes.model(id);
      const without = {
        ...model,
        entries: model.entries.filter(
          (e) => !(e.scopeId === scopeId && e.principal === `user:${userId}`),
        ),
      };
      if (rolesFor(without, userId).has(scopeId)) {
        return fail(
          reply,
          400,
          'invalid',
          'You’re in this teamspace through everyone in the workspace, a group, or as an admin.',
        );
      }
      await store.scopes.setAccess(scopeId, `user:${userId}`, null);
      await ctx.access.changed(id);
      return { ok: true };
    },
  );

  // Your private pages (made the first time).
  app.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/private',
    { preHandler: signedIn, schema: { params: { type: 'object', properties: { id: uuid } } } },
    async (request, reply) => {
      const memberRole = await store.roleOf(request.params.id, request.auth!.user.id);
      if (!memberRole) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (memberRole === 'guest')
        return fail(reply, 403, 'forbidden', 'Guests have no private pages.');
      const scope = await store.scopes.privateScope(request.params.id, request.auth!.user.id);
      await ctx.access.changed(request.params.id);
      return { scope: describe(scope, 'full') };
    },
  );

  app.patch<{
    Params: Params;
    Body: {
      name?: string;
      inherit?: boolean;
      icon?: string | null;
      description?: string;
      visibility?: ScopeVisibility;
      joinRole?: ScopeRole;
    };
  }>(
    '/api/workspaces/:id/scopes/:scopeId',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, scopeId: uuid } },
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            name: scopeName,
            inherit: { type: 'boolean' },
            icon,
            description,
            visibility,
            joinRole: role,
          },
        },
      },
    },
    async (request, reply) => {
      const found = await scopeWith(request, reply, request.params.scopeId, 'full');
      if (!found) return reply;
      const { body } = request;
      if (found.scope.kind !== 'teamspace' && (body.visibility || body.joinRole || body.icon)) {
        return fail(reply, 400, 'invalid', 'Only teamspaces have these settings.');
      }
      if (body.name !== undefined && !body.name.trim() && found.scope.kind === 'teamspace') {
        return fail(reply, 400, 'invalid', 'Name the teamspace.');
      }
      await store.scopes.update(request.params.id, request.params.scopeId, {
        name: body.name?.trim(),
        inherit: body.inherit,
        icon: body.icon,
        description: body.description?.trim(),
        visibility: body.visibility,
        joinRole: body.joinRole,
      });
      await ctx.access.changed(request.params.id);
      return { ok: true };
    },
  );

  app.put<{ Params: Params; Body: { principal: string; role: ScopeRole | null } }>(
    '/api/workspaces/:id/scopes/:scopeId/access',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, scopeId: uuid } },
        body: {
          type: 'object',
          required: ['principal', 'role'],
          properties: {
            principal: { type: 'string', maxLength: 80 },
            role: { anyOf: [role, { type: 'null' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, scopeId } = request.params;
      const { principal } = request.body;
      if (!PRINCIPAL.test(principal)) return fail(reply, 400, 'invalid', 'Unknown principal.');
      const found = await scopeWith(request, reply, scopeId, 'full');
      if (!found) return reply;
      // Only the workspace's own people and groups.
      if (principal.startsWith('user:') && !(await store.roleOf(id, principal.slice(5)))) {
        return fail(reply, 400, 'invalid', 'Not a member or guest of this workspace.');
      }
      if (
        principal.startsWith('group:') &&
        !(await store.teams.groups(id)).some((g) => g.id === principal.slice(6))
      ) {
        return fail(reply, 400, 'invalid', 'No such group.');
      }
      const { rows: had } = await store.pool.query(
        'SELECT 1 FROM scope_access WHERE scope_id = $1 AND principal = $2',
        [scopeId, principal],
      );
      await store.scopes.setAccess(scopeId, principal, request.body.role);
      request.log.info({ workspaceId: id, scopeId, principal, role: request.body.role }, 'access');
      await ctx.access.changed(id);
      // Someone added (not a role changed): tell them.
      if (request.body.role && had.length === 0 && principal.startsWith('user:')) {
        await ctx.notifier.accessGranted(id, scopeId, request.auth!.user.id, [principal.slice(5)]);
      }
      return { ok: true };
    },
  );

  /**
   * Move page `pageId` (in `from`'s tree) with its sub-pages to `to`'s tree. With
   * `stub`, a stub stays in its place (sharing). Returns false if the page isn't there.
   */
  async function movePage(
    workspaceId: string,
    page: string,
    from: Scope,
    to: Scope,
    options: { parentId?: string | null; stub?: boolean },
  ): Promise<boolean> {
    const load = async (docId: string) => {
      const doc = new Y.Doc();
      const state = await store.docState(workspaceId, docId);
      if (state) Y.applyUpdate(doc, state);
      return doc;
    };
    const source = await load(from.treeDoc);
    const target = await load(to.treeDoc);
    const before = [Y.encodeStateVector(source), Y.encodeStateVector(target)] as const;
    if (subtreeIds(source, page).length === 0) return false;
    const pages = moveSubtree(source, target, page, {
      parentId: options.parentId,
      stubScope: options.stub ? to.id : null,
    });
    // The pages' own docs: content (or database) docs, comments, and database rows.
    const docIds = new Set<string>();
    for (const id of pages) {
      docIds.add(id);
      docIds.add(`comments:${id}`);
      const doc = await load(id);
      if (isDatabaseDoc(doc)) {
        for (const row of readDatabase(doc).rows) {
          docIds.add(row.id);
          docIds.add(`comments:${row.id}`);
        }
      }
      doc.destroy();
    }
    const seqs = await ctx.realtime.appendFromServer(workspaceId, [
      { docId: from.treeDoc, data: Y.encodeStateAsUpdate(source, before[0]) },
      { docId: to.treeDoc, data: Y.encodeStateAsUpdate(target, before[1]) },
    ]);
    const moved = await store.scopes.move(
      workspaceId,
      [...docIds],
      from.id,
      to.id,
      Math.max(...seqs),
    );
    await ctx.access.moved(workspaceId, moved, from.id, to.id);
    return true;
  }

  // Share a page on its own: it becomes its own scope (inheriting where it was, so
  // nobody loses it), ready for people to be added. Needs full access where it is.
  app.post<{ Params: Params; Body: { scope: string } }>(
    '/api/workspaces/:id/pages/:pageId/share',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, pageId } },
        body: { type: 'object', required: ['scope'], properties: { scope: uuid } },
      },
    },
    async (request, reply) => {
      const { id, pageId: page } = request.params;
      if (page === MEMBERS_DOC_ID) return fail(reply, 400, 'invalid', 'Not a page.');
      const found = await scopeWith(request, reply, request.body.scope, 'full');
      if (!found) return reply;
      const from = found.scope;
      return locked(id, async () => {
        const created = await store.scopes.create({
          workspaceId: id,
          kind: 'shared',
          name: '',
          parentId: from.id,
          inherit: true,
          access: [],
        });
        await ctx.access.changed(id);
        if (!(await movePage(id, page, from, created, { stub: true }))) {
          await store.pool.query('DELETE FROM scopes WHERE id = $1', [created.id]);
          await ctx.access.changed(id);
          return fail(reply, 404, 'not_found', 'That page isn’t in this scope.');
        }
        return reply.code(201).send({ scope: describe(created, 'full') });
      });
    },
  );

  // Move a page (and its sub-pages) to another scope: under `parentId` there, or on top.
  app.post<{ Params: Params; Body: { from: string; to: string; parentId?: string | null } }>(
    '/api/workspaces/:id/pages/:pageId/move',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, pageId } },
        body: {
          type: 'object',
          required: ['from', 'to'],
          properties: {
            from: uuid,
            to: uuid,
            parentId: { anyOf: [pageId, { type: 'null' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const { id, pageId: page } = request.params;
      const { from, to } = request.body;
      if (from === to) return fail(reply, 400, 'invalid', 'Already there.');
      const source = await scopeWith(request, reply, from, 'edit');
      if (!source) return reply;
      const target = await scopeWith(request, reply, to, 'edit');
      if (!target) return reply;
      return locked(id, async () => {
        const ok = await movePage(id, page, source.scope, target.scope, {
          parentId: request.body.parentId ?? null,
        });
        if (!ok) return fail(reply, 404, 'not_found', 'That page isn’t in this scope.');
        return { ok: true };
      });
    },
  );
}
