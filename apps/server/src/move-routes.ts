/**
 * Moving a page to another workspace (Phase 8 #31): the page with its sub-pages, databases,
 * rows and attachments is copied into the person's private pages in the other workspace
 * (new ids; links and relations between them point at the copies), then put in the trash
 * here. It needs full access to the page here, and membership (not as a guest) there.
 */
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getPage, isInTrash, trashPage } from '@workspace/core';
import { captureBundle, instantiateBundle, type PageBundle } from '@workspace/database';
import type { FastifyInstance } from 'fastify';
import * as Y from 'yjs';
import { atLeast } from './access/roles';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';
import { EditRefused } from './docs-edit';
import { fileKey } from './files';

const uuid = { type: 'string', format: 'uuid' } as const;
const pageIdSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[\\w:-]+$',
} as const;
/** Docs one move may copy (pages, databases and their rows). */
export const MAX_MOVE_DOCS = 20_000;

class TooLarge extends Error {}
class Unreadable extends Error {}

/** A file id's sha256, and what may follow it (an extension, or the bytes after it). */
const HASHED = /[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?/g;

/**
 * The attachments a bundle may refer to: every file id written in its docs or its pages'
 * metadata (covers, icons). Ids are found in the encoded docs, so what follows an id may
 * run on into the next bytes: each shorter ending is a candidate too (only stored files
 * are copied).
 */
export function fileCandidates(bundle: PageBundle): Set<string> {
  const found = new Set<string>();
  const scan = (text: string) => {
    for (const match of text.matchAll(HASHED)) {
      const hash = match[0].slice(0, 64);
      const rest = match[0].slice(64);
      found.add(hash);
      for (let i = 2; i <= rest.length; i++) found.add(hash + rest.slice(0, i));
    }
  };
  scan(JSON.stringify(bundle.pages));
  for (const state of Object.values(bundle.docs)) scan(Buffer.from(state).toString('latin1'));
  return found;
}

export function moveRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);
  const { store } = ctx;

  // The workspaces a page can be moved to: the person's others (not as a guest).
  app.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/move-targets',
    { preHandler: signedIn, schema: { params: { type: 'object', properties: { id: uuid } } } },
    async (request, reply) => {
      const userId = request.auth!.user.id;
      if (!(await store.roleOf(request.params.id, userId))) {
        return fail(reply, 404, 'not_found', 'No such workspace.');
      }
      const workspaces = (await store.workspacesOf(userId)).filter(
        (w) => w.id !== request.params.id && w.role !== 'guest',
      );
      return { workspaces: workspaces.map((w) => ({ id: w.id, name: w.name })) };
    },
  );

  app.post<{ Params: { id: string; pageId: string }; Body: { to: string } }>(
    '/api/workspaces/:id/pages/:pageId/move-to-workspace',
    {
      preHandler: signedIn,
      schema: {
        params: { type: 'object', properties: { id: uuid, pageId: pageIdSchema } },
        body: { type: 'object', required: ['to'], properties: { to: uuid } },
      },
    },
    async (request, reply) => {
      const { id: sourceId, pageId } = request.params;
      const { to } = request.body;
      const userId = request.auth!.user.id;
      const from = await ctx.access.workspace(sourceId);
      if (!from.isMember(userId)) return fail(reply, 404, 'not_found', 'No such workspace.');
      if (to === sourceId) {
        return fail(reply, 400, 'invalid_request', 'The page is in that workspace already.');
      }
      const roles = from.roles(userId);

      // The page: in a tree they can read, not in the trash.
      const load = async (workspaceId: string, docId: string) => {
        const doc = new Y.Doc();
        const state = await store.docState(workspaceId, docId);
        if (state) Y.applyUpdate(doc, state);
        return doc;
      };
      let tree: Y.Doc | null = null;
      let treeDoc = '';
      for (const id of from.treeDocs()) {
        if (!from.canRead(roles, id)) continue;
        const doc = await load(sourceId, id);
        if (getPage(doc, pageId) && !isInTrash(doc, pageId)) {
          tree = doc;
          treeDoc = id;
          break;
        }
        doc.destroy();
      }
      if (!tree) return fail(reply, 404, 'not_found', 'No such page.');
      try {
        const scopeId = from.scopeOfTree(treeDoc);
        if (!atLeast(roles.get(scopeId ?? ''), 'full')) {
          return fail(reply, 403, 'forbidden', 'Moving a page needs full access to it.');
        }
        const role = await store.roleOf(to, userId);
        if (!role) return fail(reply, 404, 'not_found', 'No such workspace to move it to.');
        if (role === 'guest') {
          return fail(reply, 403, 'forbidden', 'Guests can’t add pages to that workspace.');
        }

        // Packed up: every doc it takes, each one they can read here.
        let count = 0;
        let bundle: PageBundle;
        try {
          bundle = await captureBundle(tree, pageId, async (id, use) => {
            if (++count > MAX_MOVE_DOCS) throw new TooLarge();
            if (from.placementOf(id) !== undefined && !from.canRead(roles, id)) {
              throw new Unreadable();
            }
            const doc = await load(sourceId, id);
            try {
              return use(doc);
            } finally {
              doc.destroy();
            }
          });
        } catch (error) {
          if (error instanceof TooLarge) {
            return fail(
              reply,
              413,
              'too_large',
              `Too large to move at once (over ${MAX_MOVE_DOCS} pages and rows): export it and import it there.`,
            );
          }
          if (error instanceof Unreadable) {
            return fail(reply, 403, 'forbidden', 'Part of this page is somewhere you can’t open.');
          }
          throw error;
        }

        // Its attachments, copied there first (the pages show them as soon as they arrive).
        await copyFiles(ctx, sourceId, to, fileCandidates(bundle), userId);

        // The copies: made aside, then written as the person (their private pages there).
        const scope = await store.scopes.privateScope(to, userId);
        await ctx.access.changed(to);
        const target = await load(to, scope.treeDoc);
        const made = new Map<string, Y.Doc>();
        let newId: string;
        try {
          const treeUpdates: Uint8Array[] = [];
          target.on('update', (u: Uint8Array) => treeUpdates.push(u));
          newId = await instantiateBundle(bundle, target, {
            parentId: null,
            createdBy: userId,
            withDoc: async (id, use) => {
              const doc = made.get(id) ?? new Y.Doc();
              made.set(id, doc);
              return use(doc);
            },
          });
          const author = { userId };
          const placed = { scope: scope.id };
          const pages = Y.mergeUpdates(treeUpdates);
          await ctx.docs.edit(to, scope.treeDoc, author, (d) => Y.applyUpdate(d, pages), placed);
          for (const [id, doc] of made) {
            const state = Y.encodeStateAsUpdate(doc);
            if (Y.encodeStateVector(doc).length <= 1) continue;
            await ctx.docs.edit(to, id, author, (d) => Y.applyUpdate(d, state), placed);
          }
        } catch (error) {
          if (error instanceof EditRefused) {
            return fail(reply, 403, 'forbidden', 'You can’t add pages to that workspace.');
          }
          throw error;
        } finally {
          target.destroy();
          for (const doc of made.values()) doc.destroy();
        }

        // Then out of here: in the trash (restorable, as any deleted page).
        await ctx.docs.edit(sourceId, treeDoc, { userId }, (d) => trashPage(d, pageId));
        return { workspaceId: to, pageId: newId };
      } finally {
        tree.destroy();
      }
    },
  );
}

/** Copy the attachments among `ids` that are stored for `from` and not yet for `to`. */
async function copyFiles(
  ctx: ServerContext,
  from: string,
  to: string,
  ids: Iterable<string>,
  userId: string,
): Promise<void> {
  let dir: string | null = null;
  try {
    for (const id of ids) {
      const meta = await ctx.store.getFile(from, id);
      if (!meta) continue;
      if (!(await ctx.files.has(fileKey(to, id)))) {
        const stored = await ctx.files.get(fileKey(from, id));
        if (!stored) continue;
        dir ??= await mkdtemp(join(tmpdir(), 'workspace-move-'));
        const path = join(dir, 'file');
        await pipeline(stored.body, createWriteStream(path));
        await ctx.files.putFile(fileKey(to, id), path, stored.size, meta.mime);
      }
      await ctx.store.putFile(to, meta, userId);
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
