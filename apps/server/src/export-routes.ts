/**
 * Exports for the web app: Markdown & CSV or HTML of a page (with its sub-pages) or of
 * everything the person can read, as a zip, rendered here with the same exporter as the
 * desktop. Pages they can't read stay out; links to them show their title only if readable.
 */
import {
  Forest,
  MEMBERS_DOC_ID,
  WORKSPACE_DOC_ID,
  listPages,
  localTree,
  userNames,
} from '@workspace/core';
import { exportPages, mermaidSources, type ExportOptions } from '@workspace/exporters';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PassThrough } from 'node:stream';
import * as Y from 'yjs';
import { fail, requireUser } from './auth/context';
import type { ServerContext } from './context';
import { FILE_ID, fileKey } from './files';

interface ExportBody {
  format: 'markdown' | 'html';
  pageId?: string;
  includeSubpages?: boolean;
  /** Mermaid diagrams the browser rendered (source → SVG), for HTML. */
  mermaid?: Record<string, string>;
}

/** Text and already-compressed media are stored as they are; the rest is deflated. */
const COMPRESSED = /\.(png|jpe?g|gif|webp|avif|mp4|webm|mov|mp3|ogg|m4a|zip|gz|pdf)$/i;
const uuid = { type: 'string', format: 'uuid' } as const;
const docId = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\w:-]+$' } as const;
// Characters that can't be in file names, including control characters.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME = /[/\\:*?"<>|\u0000-\u001f]/g;
/** Docs an export may load (a whole workspace's pages, databases and rows). */
const MAX_DOCS = 20_000;

export function exportRoutes(app: FastifyInstance, ctx: ServerContext) {
  const signedIn = requireUser(ctx);

  /** What an export of these pages needs: the trees, the docs, a source to render from. */
  async function prepare(request: FastifyRequest<{ Params: { id: string } }>, body: ExportBody) {
    const workspaceId = request.params.id;
    const access = await ctx.access.workspace(workspaceId);
    const userId = request.auth!.user.id;
    if (!access.isMember(userId)) return null;
    const roles = access.roles(userId);
    const readable = (doc: string) =>
      access.canRead(roles, doc) && access.placementOf(doc) !== undefined;

    const load = async (id: string): Promise<Y.Doc | null> => {
      const state = await ctx.store.docState(workspaceId, id);
      if (!state) return null;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      return doc;
    };
    const trees = [];
    for (const treeDoc of access.treeDocs()) {
      if (!readable(treeDoc)) continue;
      const doc = await load(treeDoc);
      if (doc) trees.push(localTree(doc, treeDoc));
    }
    const workspace = new Forest(trees);
    // The page must be in a tree they can read (its own doc may not be placed yet: a page
    // gets a scope on its first edit, so an empty page has none).
    if (body.pageId && !listPages(workspace).some((p) => p.id === body.pageId)) return null;
    const workspaceDoc = await load(WORKSPACE_DOC_ID);
    const members = await load(MEMBERS_DOC_ID);
    const users = userNames(workspaceDoc, members);
    workspaceDoc?.destroy();
    members?.destroy();

    // The docs the export asks for, loaded and asked again until it has them all (pages
    // lead to their databases' rows, and those to synced blocks).
    const docs = new Map<string, Y.Doc | null>();
    const options: ExportOptions = {
      format: body.format,
      roots: body.pageId ? [body.pageId] : 'all',
      includeSubpages: body.pageId ? body.includeSubpages === true : true,
    };
    const marker = new Map<Uint8Array, string>();
    const source = {
      workspace,
      doc: (id: string) => {
        if (!docs.has(id)) missing.add(id);
        return docs.get(id) ?? null;
      },
      // Files are named here and streamed into the zip afterwards.
      file: (id: string) => {
        if (!FILE_ID.test(id)) return null;
        const bytes = new Uint8Array(0);
        marker.set(bytes, id);
        if (!names.has(id)) unnamed.add(id);
        return { bytes, name: names.get(id) ?? null };
      },
      users,
    };
    const missing = new Set<string>();
    const names = new Map<string, string | null>();
    const unnamed = new Set<string>();
    for (let round = 0; round < 6; round++) {
      missing.clear();
      // Rendering once tells which docs it reads.
      for (const entry of exportPages(source, options)) void entry;
      for (const id of unnamed) {
        names.set(id, (await ctx.store.getFile(workspaceId, id))?.name ?? null);
      }
      unnamed.clear();
      if (missing.size === 0) break;
      for (const id of missing) {
        if (docs.size >= MAX_DOCS) throw new Error('This export is too large for the web app.');
        docs.set(id, readable(id) ? await load(id) : null);
      }
    }
    marker.clear();
    return { source, options, marker, workspaceId, docs };
  }

  // The diagrams an HTML export will draw: the browser renders them (it has Mermaid).
  app.post<{ Params: { id: string }; Body: ExportBody }>(
    '/api/workspaces/:id/export/diagrams',
    {
      preHandler: signedIn,
      schema: { params: { type: 'object', properties: { id: uuid } }, body: bodySchema },
    },
    async (request, reply) => {
      const prepared = await prepare(request, request.body);
      if (!prepared) return fail(reply, 404, 'not_found', 'No such page.');
      return { sources: mermaidSources(prepared.source, prepared.options) };
    },
  );

  app.post<{ Params: { id: string }; Body: ExportBody }>(
    '/api/workspaces/:id/export',
    {
      preHandler: signedIn,
      bodyLimit: 8 * 1024 * 1024,
      schema: { params: { type: 'object', properties: { id: uuid } }, body: bodySchema },
    },
    async (request, reply) => {
      let prepared;
      try {
        prepared = await prepare(request, request.body);
      } catch (error) {
        return fail(reply, 413, 'too_large', error instanceof Error ? error.message : 'Too large');
      }
      if (!prepared) return fail(reply, 404, 'not_found', 'No such page.');
      const { source, options, marker, workspaceId, docs } = prepared;
      const svgs = request.body.mermaid ?? {};

      const out = new PassThrough();
      const zip = new Zip((error, chunk, final) => {
        if (error) out.destroy(error);
        else {
          out.write(chunk);
          if (final) out.end();
        }
      });
      const add = (path: string, bytes: Uint8Array) => {
        const file = COMPRESSED.test(path)
          ? new ZipPassThrough(path)
          : new ZipDeflate(path, { level: 6 });
        zip.add(file);
        file.push(bytes, true);
      };
      // Named like the desktop's: the page's title (or the workspace's) and the format.
      const title = request.body.pageId
        ? (listPages(source.workspace).find((p) => p.id === request.body.pageId)?.title ?? '')
        : 'Workspace';
      const name = `${
        (title || 'Untitled').replace(UNSAFE_NAME, ' ').trim().slice(0, 100) || 'Untitled'
      } (${options.format === 'html' ? 'HTML' : 'Markdown'}).zip`;
      void reply
        .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`)
        .header('content-type', 'application/zip')
        .header('cache-control', 'no-store')
        .send(out);

      try {
        const files: { path: string; id: string }[] = [];
        for (const entry of exportPages(source, {
          ...options,
          mermaidSvg: (code) => svgs[code] ?? null,
        })) {
          if (typeof entry.data === 'string') add(entry.path, new TextEncoder().encode(entry.data));
          else {
            const id = marker.get(entry.data);
            if (id) files.push({ path: entry.path, id });
          }
        }
        for (const { path, id } of files) {
          const stored = await ctx.files.get(fileKey(workspaceId, id));
          if (!stored) continue;
          const chunks: Buffer[] = [];
          for await (const chunk of stored.body) chunks.push(chunk as Buffer);
          add(path, new Uint8Array(Buffer.concat(chunks)));
        }
        zip.end();
      } catch (error) {
        out.destroy(error instanceof Error ? error : new Error(String(error)));
      } finally {
        for (const doc of docs.values()) doc?.destroy();
      }
      return reply;
    },
  );
}

const bodySchema = {
  type: 'object',
  required: ['format'],
  properties: {
    format: { enum: ['markdown', 'html'] },
    pageId: docId,
    includeSubpages: { type: 'boolean' },
    mermaid: { type: 'object', additionalProperties: { type: 'string', maxLength: 500_000 } },
  },
  additionalProperties: false,
} as const;
