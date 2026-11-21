/**
 * Publishing, backlinks, history and views (Phase 5 M7): real server, Postgres, sockets.
 *
 * Lab's first teamspace (everyone edits) has Ada's "Gearbox" with a sub-page "Sub
 * notes", and "Secret plans" next to it, unpublished. Gearbox mentions the secret page
 * and shows a synced block from it, and an image. Bob is a member; Gus a guest who can't
 * read the teamspace.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, getPageContent, listPages } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage, fileKey } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-publish-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const IMAGE = `${'a'.repeat(64)}.png`;
const OTHER = `${'b'.repeat(64)}.png`;

function element(
  name: string,
  attrs: Record<string, string>,
  ...children: (string | Y.XmlElement)[]
) {
  const el = new Y.XmlElement(name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.insert(
    0,
    children.map((c) => (typeof c === 'string' ? new Y.XmlText(c) : c)),
  );
  return el;
}

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  const files = new FsStorage(dir);
  const clock = { now: Date.now() };
  const app = buildServer({
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      LOG_LEVEL: 'silent',
      FILES_DIR: dir,
      SIGNUP: 'open',
      PUBLIC_URL: 'http://app.test',
    }),
    store,
    files,
    mailer: null,
    indexDelayMs: 0,
    history: { quietMs: 60_000, pollMs: 3_600_000, now: () => clock.now },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const port = (app.server.address() as AddressInfo).port;
  const call = async (method: string, url: string, token: string | null, payload?: object) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return res;
  };
  const json = async (method: string, url: string, token: string | null, payload?: object) => {
    const res = await call(method, url, token, payload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const signup = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email: `${name}@lab.io`, name, password: 'long password', client: 'desktop' },
    });
    return { token: res.json().token as string, id: res.json().user.id as string };
  };
  const [ada, bob, gus] = [await signup('ada'), await signup('bob'), await signup('gus')];
  const ws = (await json('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  for (const [person, role] of [
    [bob, 'member'],
    [gus, 'guest'],
  ] as const) {
    const invite = await json('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [`${person === bob ? 'bob' : 'gus'}@lab.io`],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await json('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  }
  for (const [id, text] of [
    [IMAGE, 'png bytes'],
    [OTHER, 'private bytes'],
  ] as const) {
    const bytes = new TextEncoder().encode(text);
    await files.put(fileKey(ws, id), bytes, 'image/png');
    await store.putFile(ws, { id, name: `${id}`, mime: 'image/png', size: bytes.length }, ada.id);
  }

  const a = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
    token: ada.token,
    deviceId: 'ada',
  });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  const tree = a.doc('workspace');
  createPage(tree, { id: 'gear', title: 'Gearbox' });
  createPage(tree, { id: 'sub', title: 'Sub notes', parentId: 'gear' });
  createPage(tree, { id: 'secret', title: 'Secret plans' });
  getPageContent(a.doc('secret')).insert(0, [element('paragraph', { id: 's1' }, 'Do not share')]);
  getPageContent(a.doc('syn1')).insert(0, [element('paragraph', { id: 'y1' }, 'Leaked synced')]);
  getPageContent(a.doc('sub')).insert(0, [element('paragraph', { id: 'u1' }, 'Sub content')]);
  getPageContent(a.doc('gear')).insert(0, [
    element(
      'paragraph',
      { id: 'g1' },
      'Planetary, see ',
      element('mention', { kind: 'page', pageId: 'secret' }),
      ' and ',
      element('mention', { kind: 'page', pageId: 'sub' }),
    ),
    element('syncedBlock', { id: 'g2', syncedId: 'syn1' }),
    element('image', { id: 'g3', fileId: IMAGE }),
  ]);
  await until(() => a.outbox.length === 0, 'outbox sent');
  return { app, store, clock, ws, call, json, ada, bob, gus, a };
}

describe('publishing', () => {
  it('publishes to /p/<slug>: only the published pages and their files, then unpublishes', async () => {
    const w = await world();
    const publish = `/api/workspaces/${w.ws}/pages/gear/publish`;
    // A member who can edit (not full access) can't publish; a guest can't see the page.
    expect((await w.json('PUT', publish, w.bob.token, { slug: 'gearbox' })).status).toBe(403);
    expect((await w.json('GET', publish, w.gus.token)).status).toBe(404);
    expect((await w.json('PUT', publish, w.ada.token, { slug: 'Bad slug!' })).status).toBe(400);
    const done = await w.json('PUT', publish, w.ada.token, {
      slug: 'gearbox',
      title: 'Our gearbox',
      description: 'How it turns',
    });
    expect(done.status).toBe(200);
    expect(done.body.published).toMatchObject({ slug: 'gearbox', includeSubpages: true });

    // Signed out.
    const start = await w.call('GET', '/p/gearbox', null);
    expect(start.statusCode).toBe(302);
    const location = start.headers.location as string;
    expect(location).toBe(`/p/gearbox/${encodeURIComponent('Gearbox gear.html')}`);
    const page = await w.call('GET', location, null);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toContain('noindex');
    const html = page.body;
    expect(html).toContain('<title>Our gearbox</title>');
    expect(html).toContain('<meta name="description" content="How it turns">');
    expect(html).toContain('Planetary');
    expect(html).toContain('Sub notes');
    // Nothing of the unpublished page: not its title, its synced block, or a link.
    expect(html).toContain('Private page');
    expect(html).not.toContain('Secret plans');
    expect(html).not.toContain('Leaked synced');
    expect(html).not.toContain('secret');

    // The sub-page, and the image the page shows; nothing else.
    const sub = /href="([^"]*Sub notes sub\.html)"/.exec(html)?.[1];
    expect(sub).toBeDefined();
    const subPage = await w.call(
      'GET',
      `/p/gearbox/${sub!.split('/').map(encodeURIComponent).join('/')}`,
      null,
    );
    expect(subPage.statusCode).toBe(200);
    expect(subPage.body).toContain('Sub content');
    const image = /<img[^>]*src="([^"]+)"/.exec(html)?.[1];
    expect(image).toBeDefined();
    const bytes = await w.call('GET', `/p/gearbox/${image!}`, null);
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe('png bytes');
    expect((await w.call('GET', `/p/gearbox/${OTHER}`, null)).statusCode).toBe(404);
    expect((await w.call('GET', '/p/gearbox/Secret plans secret.html', null)).statusCode).toBe(404);

    // Edits show (the render follows the log).
    getPageContent(w.a.doc('gear')).insert(3, [element('paragraph', { id: 'g4' }, 'Ratio 64:1')]);
    await until(() => w.a.outbox.length === 0, 'outbox sent');
    expect((await w.call('GET', location, null)).body).toContain('Ratio 64:1');

    // Without sub-pages: the sub-page is gone, its mention private.
    await w.json('PUT', publish, w.ada.token, { slug: 'gearbox', includeSubpages: false });
    const alone = (await w.call('GET', location, null)).body;
    expect(alone).not.toContain('Sub notes');
    expect((await w.call('GET', `/p/gearbox/${sub!}`, null)).statusCode).toBe(404);

    // Views were counted (public visitors, without cookies).
    const analytics = await w.json(
      'GET',
      `/api/workspaces/${w.ws}/pages/gear/analytics`,
      w.bob.token,
    );
    expect(analytics.body.views).toBeGreaterThanOrEqual(3);
    expect(analytics.body.viewers).toBe(1);
    await w.json('POST', `/api/workspaces/${w.ws}/pages/gear/views`, w.bob.token);
    expect(
      (await w.json('GET', `/api/workspaces/${w.ws}/pages/gear/analytics`, w.bob.token)).body
        .viewers,
    ).toBe(2);

    // Slugs are unique; unpublishing takes effect at once.
    const other = `/api/workspaces/${w.ws}/pages/secret/publish`;
    expect((await w.json('PUT', other, w.ada.token, { slug: 'gearbox' })).status).toBe(409);
    expect((await w.json('DELETE', publish, w.ada.token)).status).toBe(200);
    expect((await w.call('GET', '/p/gearbox', null)).statusCode).toBe(404);
    expect((await w.call('GET', location, null)).statusCode).toBe(404);
  });

  it('backlinks and history, as each person may see them', async () => {
    const w = await world();
    const backlinks = (token: string) =>
      w.json('GET', `/api/workspaces/${w.ws}/pages/secret/backlinks`, token);
    await until(
      async () => (await backlinks(w.ada.token)).body.backlinks?.length === 1,
      'backlink indexed',
    );
    expect((await backlinks(w.ada.token)).body.backlinks).toEqual([
      expect.objectContaining({ id: 'gear', title: 'Gearbox', blockId: 'g1', kind: 'mention' }),
    ]);
    expect((await backlinks(w.gus.token)).status).toBe(404);

    // History: a snapshot once the page has been quiet, with its author.
    await w.app.history.follow(w.ws);
    await w.app.history.tick();
    const versions = `/api/workspaces/${w.ws}/docs/gear/versions`;
    expect((await w.json('GET', versions, w.ada.token)).body.versions).toEqual([]);
    w.clock.now += 120_000;
    await w.app.history.tick();
    const listed = (await w.json('GET', versions, w.bob.token)).body.versions;
    expect(listed).toEqual([expect.objectContaining({ reason: 'edit', authors: [w.ada.id] })]);
    const got = await w.json(
      'GET',
      `/api/workspaces/${w.ws}/versions/${listed[0].id}`,
      w.bob.token,
    );
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(got.body.state as string, 'base64'));
    expect(getPageContent(doc).toString()).toContain('Planetary');
    expect(
      (await w.json('GET', `/api/workspaces/${w.ws}/versions/${listed[0].id}`, w.gus.token)).status,
    ).toBe(404);
    // Nothing new: no new snapshot. A manual one (before a restore) is taken anyway.
    await w.app.history.tick();
    expect((await w.json('GET', versions, w.ada.token)).body.versions).toHaveLength(1);
    expect((await w.json('POST', versions, w.bob.token, { reason: 'restore' })).body.id).toEqual(
      expect.any(Number),
    );
    expect((await w.json('GET', versions, w.ada.token)).body.versions).toHaveLength(2);
    expect((await w.json('POST', versions, w.gus.token, { reason: 'restore' })).status).toBe(404);
  });
});

describe('duplicate as template (#35)', () => {
  it('only when allowed: a visitor copies what the site shows into a workspace of theirs', async () => {
    const w = await world();
    const publish = `/api/workspaces/${w.ws}/pages/gear/publish`;
    expect(
      (await w.json('PUT', publish, w.ada.token, { slug: 'gearbox', includeSubpages: false }))
        .status,
    ).toBe(200);
    const pageHtml = async () => {
      const start = await w.call('GET', '/p/gearbox', null);
      return (await w.call('GET', start.headers.location as string, null)).body;
    };
    // Not allowed: no button, nothing to duplicate.
    expect(await pageHtml()).not.toContain('href="/d/gearbox"');
    expect((await w.json('GET', '/api/published/gearbox/duplicate', null)).status).toBe(404);

    await w.json('PUT', publish, w.ada.token, {
      slug: 'gearbox',
      includeSubpages: false,
      allowDuplicate: true,
      title: 'Gearbox template',
    });
    expect(await pageHtml()).toContain('href="/d/gearbox"');
    const info = await w.json('GET', '/api/published/gearbox/duplicate', null);
    expect(info.body).toEqual({ title: 'Gearbox template', includeSubpages: false });

    // Signed in, into a workspace of Bob's own.
    const mine = (await w.json('POST', '/api/workspaces', w.bob.token, { name: 'Bob’s' })).body
      .workspace.id as string;
    // Signed out: refused.
    expect([401, 403]).toContain(
      (await w.json('POST', '/api/published/gearbox/duplicate', null, { to: mine })).status,
    );
    const copied = await w.json('POST', '/api/published/gearbox/duplicate', w.bob.token, {
      to: mine,
    });
    expect(copied.status).toBe(200);
    expect(copied.body.workspaceId).toBe(mine);
    const scopes = (await w.json('GET', `/api/workspaces/${mine}/scopes`, w.bob.token)).body
      .scopes as { kind: string; treeDoc: string }[];
    const tree = new Y.Doc();
    Y.applyUpdate(
      tree,
      (await w.store.docState(mine, scopes.find((s) => s.kind === 'private')!.treeDoc))!,
    );
    const titles = listPages(tree).map((p) => p.title);
    // The page, not its sub-page (it isn't published).
    expect(titles).toEqual(['Gearbox']);
    const content = new Y.Doc();
    Y.applyUpdate(content, (await w.store.docState(mine, copied.body.pageId as string))!);
    expect(getPageContent(content).toString()).toContain('Planetary');
    // Its image came along; the unpublished page's text didn't.
    expect(await w.store.getFile(mine, IMAGE)).not.toBeNull();
    expect(await w.store.getFile(mine, OTHER)).toBeNull();
    expect(getPageContent(content).toString()).not.toContain('Do not share');

    // A guest there can't; nor into a workspace that isn't theirs.
    expect(
      (await w.json('POST', '/api/published/gearbox/duplicate', w.gus.token, { to: w.ws })).status,
    ).toBe(403);
    expect(
      (await w.json('POST', '/api/published/gearbox/duplicate', w.gus.token, { to: mine })).status,
    ).toBe(404);

    // With its sub-pages published, they come too.
    await w.json('PUT', publish, w.ada.token, {
      slug: 'gearbox',
      includeSubpages: true,
      allowDuplicate: true,
    });
    const again = await w.json('POST', '/api/published/gearbox/duplicate', w.bob.token, {
      to: mine,
    });
    expect(again.status).toBe(200);
    const tree2 = new Y.Doc();
    Y.applyUpdate(
      tree2,
      (await w.store.docState(mine, scopes.find((s) => s.kind === 'private')!.treeDoc))!,
    );
    const titles2 = listPages(tree2).map((p) => p.title);
    expect(titles2.sort()).toEqual(['Gearbox', 'Gearbox', 'Sub notes']);
  });
});

describe('exports for the web app', () => {
  it('zips a page with its sub-pages, or everything someone can read; not for outsiders', async () => {
    const w = await world();
    const exportUrl = `/api/workspaces/${w.ws}/export`;
    const names: string[] = [];
    const zip = async (token: string, payload: object) => {
      const res = await w.app.inject({
        method: 'POST',
        url: exportUrl,
        payload,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/zip');
      names.push(
        decodeURIComponent(String(res.headers['content-disposition']).split("''")[1] ?? ''),
      );
      const files = unzipSync(new Uint8Array(res.rawPayload));
      return new Map(Object.entries(files).map(([path, bytes]) => [path, bytes]));
    };
    const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

    // A page with its sub-page, its synced block's text and its image (under its name).
    const page = await zip(w.bob.token, {
      format: 'markdown',
      pageId: 'gear',
      includeSubpages: true,
    });
    expect([...page.keys()].sort()).toEqual([
      'Gearbox gear.md',
      'Gearbox gear/Sub notes sub.md',
      `Gearbox gear/${IMAGE}`,
    ]);
    expect(text(page.get('Gearbox gear.md'))).toContain('Leaked synced');
    expect(text(page.get(`Gearbox gear/${IMAGE}`))).toBe('png bytes');
    expect(text(page.get('Gearbox gear/Sub notes sub.md'))).toContain('Sub content');

    // Everything Ada can read, as HTML.
    const all = await zip(w.ada.token, { format: 'html' });
    expect([...all.keys()]).toContain('Secret plans secret.html');
    expect(text(all.get('Secret plans secret.html'))).toContain('Do not share');

    // A guest who can't read the teamspace gets nothing, and can't tell it's there.
    const refused = await w.call('POST', exportUrl, w.gus.token, {
      format: 'markdown',
      pageId: 'gear',
    });
    expect(refused.statusCode).toBe(404);
    const nothing = await zip(w.gus.token, { format: 'markdown' });
    expect(nothing.size).toBe(0);
    const signedOut = await w.call('POST', exportUrl, null, { format: 'markdown' });
    expect([401, 403]).toContain(signedOut.statusCode);

    expect(names).toEqual([
      'Gearbox (Markdown).zip',
      'Workspace (HTML).zip',
      'Workspace (Markdown).zip',
    ]);

    // HTML: the diagrams to draw come first (the browser renders them).
    const diagrams = await w.json('POST', `${exportUrl}/diagrams`, w.ada.token, { format: 'html' });
    expect(diagrams).toEqual({ status: 200, body: { sources: [] } });
  });
});
