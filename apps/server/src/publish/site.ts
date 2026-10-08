/**
 * Publishing to the web (Phase 5 M7): a page (with its sub-pages, if chosen) at
 * `/p/<slug>/…`, rendered from the docs' merged state with the HTML exporter, for anyone.
 *
 * Only the published pages' own docs are read: links and mentions of other pages show
 * as "Private page" (no title, no link), synced blocks from elsewhere show nothing, and a
 * file is served only if a published page shows it. A render is cached until the
 * workspace's log moves on; unpublishing drops it at once. Pages are sent with a strict
 * CSP and `noindex` unless search engines are allowed.
 */
import { createHash, randomBytes } from 'node:crypto';
import { MEMBERS_DOC_ID, WORKSPACE_DOC_ID, getPage, isInTrash, userNames } from '@workspace/core';
import { isDatabaseDoc, readDatabase } from '@workspace/database';
import {
  escapeHtml,
  exportName,
  exportPages,
  relativePath,
  selectPages,
} from '@workspace/exporters';
import type { Published } from '@workspace/storage-remote';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as Y from 'yjs';
import type { ServerContext } from '../context';
import { FILE_ID, fileKey } from '../files';

/** What a visitor may fetch: pages (HTML) and the files they show. */
interface Rendered {
  seq: number;
  root: string;
  html: Map<string, { body: string; pageId: string | null }>;
  files: Map<string, string>;
}

const CSP = [
  "default-src 'none'",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

/** `Gearbox design!` → `gearbox-design` (a slug to start from). */
export const slugFrom = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'page';

export class Site {
  private readonly cache = new Map<string, Rendered>();
  /** A secret per day, for counting public visitors without keeping who they are. */
  private salt = { day: '', value: '' };

  constructor(private readonly ctx: ServerContext) {}

  /** Forget a published page's render (unpublished, or its settings changed). */
  forget(slug: string): void {
    this.cache.delete(slug);
  }

  private async load(workspaceId: string, docId: string): Promise<Y.Doc | null> {
    const state = await this.ctx.store.docState(workspaceId, docId);
    if (!state) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    return doc;
  }

  /** The published pages, rendered (null if the page is gone, trashed or unplaced). */
  async render(pub: Published): Promise<Rendered | null> {
    const seq = await this.ctx.store.latestSeq(pub.workspaceId);
    const cached = this.cache.get(pub.slug);
    if (cached && cached.seq === seq) return cached;

    const access = await this.ctx.access.workspace(pub.workspaceId);
    const scope = access.scope(access.placementOf(pub.pageId) ?? '');
    if (!scope) return null;
    const tree = await this.load(pub.workspaceId, scope.treeDoc);
    if (!tree) return null;
    const docs = new Map<string, Y.Doc>();
    try {
      const page = getPage(tree, pub.pageId);
      if (!page || isInTrash(tree, pub.pageId)) return null;
      // The docs a visitor may see: the published pages, their databases and rows.
      const selected = selectPages(tree, [pub.pageId], pub.includeSubpages);
      for (const { page: p } of selected) {
        const doc = await this.load(pub.workspaceId, p.id);
        if (!doc) continue;
        docs.set(p.id, doc);
        if (isDatabaseDoc(doc)) {
          for (const row of readDatabase(doc).rows) {
            const rowDoc = await this.load(pub.workspaceId, row.id);
            if (rowDoc) docs.set(row.id, rowDoc);
          }
        }
      }
      const workspace = await this.load(pub.workspaceId, WORKSPACE_DOC_ID);
      const members = await this.load(pub.workspaceId, MEMBERS_DOC_ID);
      const users = userNames(workspace, members);
      workspace?.destroy();
      members?.destroy();

      // Attachments are streamed from storage when asked for: the export only names them.
      const fileOf = new Map<Uint8Array, string>();
      const entries = [
        ...exportPages(
          {
            workspace: tree,
            doc: (id) => docs.get(id) ?? null,
            file: (id) => {
              if (!FILE_ID.test(id)) return null;
              const marker = new Uint8Array(0);
              fileOf.set(marker, id);
              return { bytes: marker, name: null };
            },
            users,
          },
          {
            format: 'html',
            roots: [pub.pageId],
            includeSubpages: pub.includeSubpages,
            outside: { href: () => '', title: () => 'Private page' },
          },
        ),
      ];
      const compact = new Map([...docs.keys()].map((id) => [id.replace(/-/g, ''), id]));
      const root = `${exportName(page.title, page.id)}.html`;
      const rendered: Rendered = { seq, root, html: new Map(), files: new Map() };
      for (const entry of entries) {
        if (typeof entry.data === 'string') {
          const id = / ([^ /]+)\.html$/.exec(entry.path)?.[1];
          const isRoot = entry.path === root;
          rendered.html.set(entry.path, {
            body: withHead(entry.data, pub, isRoot),
            pageId: (id && compact.get(id)) ?? null,
          });
        } else {
          const fileId = fileOf.get(entry.data);
          if (fileId) rendered.files.set(entry.path, fileId);
        }
      }
      // Sub-pages linked from nowhere in their parent's content are listed under it.
      const pathOf = new Map<string, string>();
      for (const [path, entry] of rendered.html) if (entry.pageId) pathOf.set(entry.pageId, path);
      for (const [path, entry] of rendered.html) {
        const children = selected.filter(
          (s) => s.parentId === entry.pageId && pathOf.has(s.page.id),
        );
        const links = children
          .map((c) => ({ href: relativePath(path, pathOf.get(c.page.id)!), title: c.page.title }))
          .filter((l) => !entry.body.includes(`href="${escapeHtml(l.href)}"`));
        if (links.length === 0) continue;
        const nav = `<nav class="subpages">${links
          .map(
            (l) =>
              `<p class="page-link"><a href="${escapeHtml(l.href)}">${escapeHtml(l.title || 'Untitled')}</a></p>`,
          )
          .join('')}</nav>\n`;
        entry.body = entry.body.replace('</article>', `${nav}</article>`);
      }
      this.cache.set(pub.slug, rendered);
      return rendered;
    } finally {
      tree.destroy();
      for (const doc of docs.values()) doc.destroy();
    }
  }

  /** A public visitor, as a hash that changes daily (no cookie, nothing kept about them). */
  visitor(request: FastifyRequest): string {
    const day = new Date().toISOString().slice(0, 10);
    if (this.salt.day !== day) this.salt = { day, value: randomBytes(16).toString('hex') };
    return (
      'v:' +
      createHash('sha256')
        .update(`${this.salt.value}\u0000${request.ip}\u0000${request.headers['user-agent'] ?? ''}`)
        .digest('hex')
        .slice(0, 32)
    );
  }
}

/** Search-engine and social-card metadata (and the chosen title, on the published page). */
function withHead(html: string, pub: Published, isRoot: boolean): string {
  const meta: string[] = [];
  if (!pub.allowIndexing) meta.push('<meta name="robots" content="noindex, nofollow">');
  if (isRoot) {
    if (pub.description) {
      meta.push(`<meta name="description" content="${escapeHtml(pub.description)}">`);
      meta.push(`<meta property="og:description" content="${escapeHtml(pub.description)}">`);
    }
    if (pub.title) meta.push(`<meta property="og:title" content="${escapeHtml(pub.title)}">`);
  }
  let out = html.replace('<head>', `<head>\n${meta.join('\n')}`);
  if (isRoot && pub.title) {
    out = out.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(pub.title)}</title>`);
  }
  return out;
}

/** `/p/<slug>` and everything under it, for anyone. */
export function siteRoutes(app: FastifyInstance, ctx: ServerContext, site: Site) {
  const { store, files } = ctx;
  const notFound = (reply: FastifyReply) =>
    reply
      .code(404)
      .header('content-type', 'text/html; charset=utf-8')
      .header('x-robots-tag', 'noindex')
      .send('<!doctype html><title>Not found</title><p>This page isn’t published.</p>');

  const headers = (reply: FastifyReply, pub: Published) => {
    reply
      .header('content-security-policy', CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-cache');
    if (!pub.allowIndexing) reply.header('x-robots-tag', 'noindex, nofollow');
  };

  app.get<{ Params: { slug: string } }>('/p/:slug', async (request, reply) => {
    const { slug } = request.params;
    const pub = SLUG.test(slug) ? await store.pages.bySlug(slug) : null;
    const rendered = pub ? await site.render(pub) : null;
    if (!pub || !rendered) return notFound(reply);
    return reply.redirect(`/p/${slug}/${encodeURIComponent(rendered.root)}`, 302);
  });

  app.get<{ Params: { slug: string; '*': string } }>('/p/:slug/*', async (request, reply) => {
    const { slug } = request.params;
    const pub = SLUG.test(slug) ? await store.pages.bySlug(slug) : null;
    const rendered = pub ? await site.render(pub) : null;
    if (!pub || !rendered) return notFound(reply);
    let path: string;
    try {
      path = decodeURIComponent(request.params['*']);
    } catch {
      return notFound(reply);
    }
    headers(reply, pub);
    const page = rendered.html.get(path);
    if (page) {
      if (page.pageId) {
        await store.pages
          .view(pub.workspaceId, page.pageId, site.visitor(request))
          .catch((error: unknown) => request.log.warn({ err: error }, 'counting a view'));
      }
      return reply.header('content-type', 'text/html; charset=utf-8').send(page.body);
    }
    const fileId = rendered.files.get(path);
    if (!fileId) return notFound(reply);
    const meta = await store.getFile(pub.workspaceId, fileId);
    const stored = await files.get(fileKey(pub.workspaceId, fileId));
    if (!meta || !stored) return notFound(reply);
    return reply
      .header('content-type', meta.mime || 'application/octet-stream')
      .header('content-length', stored.size)
      .send(stored.body);
  });
}
