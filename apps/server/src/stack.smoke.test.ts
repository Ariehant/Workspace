/**
 * The deployed stack, end to end: run against `docker compose up` (Caddy with TLS in
 * front of the server). Skipped unless STACK_URL is set, e.g.
 *
 *   STACK_URL=https://localhost NODE_EXTRA_CA_CERTS=caddy-root.crt vitest run src/stack.smoke.test.ts
 *
 * A device signs up, creates a workspace and syncs with a second device over wss, an
 * attachment goes up and comes back, search finds the page, and the web app is served.
 * Then a second account: it gets only the page shared with it, live, and a published
 * page is public until it's unpublished. Then Phase 6: an integration uses the API, a
 * public form takes a response, and (with STACK_WEBHOOK_HOST, a name the server reaches
 * this machine by, and webhooks to private addresses allowed on the stack) the
 * integration's webhook is verified and reports the new page.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WORKSPACE_DOC_ID, createPage, getPageContent } from '@workspace/core';
import { addView, initDatabase, readDatabase, updateView } from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TestDevice } from './sync/test-client';

const base = process.env.STACK_URL?.replace(/\/+$/, '');
const webhookHost = process.env.STACK_WEBHOOK_HOST;

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe.skipIf(!base)('the deployed stack', () => {
  it('signs up, syncs two devices over TLS, stores a file and searches', async () => {
    const json = { 'content-type': 'application/json', 'x-workspace-client': 'smoke' };
    const email = `smoke-${Date.now()}@lab.io`;
    const signup = await fetch(`${base}/api/auth/signup`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email, name: 'Smoke', password: 'smoke password', client: 'desktop' }),
    });
    expect(signup.status).toBe(201);
    const { token } = (await signup.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    const created = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { ...json, ...auth },
      body: JSON.stringify({ name: 'Smoke lab' }),
    });
    const { workspace } = (await created.json()) as { workspace: { id: string } };

    const url = `${base!.replace(/^http/, 'ws')}/api/sync/${workspace.id}`;
    const a = new TestDevice({ url, token, deviceId: 'smoke-a' });
    const b = new TestDevice({ url, token, deviceId: 'smoke-b' });
    try {
      a.client.start();
      b.client.start();
      await until(() => a.client.state.state === 'live' && b.client.state.state === 'live', 'live');
      const pageId = createPage(a.doc(WORKSPACE_DOC_ID), { title: 'Through Caddy' });
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Synced over TLS with a checkerboard target.')]);
      getPageContent(a.doc(pageId)).insert(0, [paragraph]);
      await until(
        () => getPageContent(b.doc(pageId)).toString().includes('checkerboard'),
        'device B has the page',
      );

      // An attachment up and back.
      const bytes = Buffer.from('smoke test attachment');
      const id = `${createHash('sha256').update(bytes).digest('hex')}.txt`;
      const fileUrl = `${base}/api/workspaces/${workspace.id}/files/${id}`;
      const put = await fetch(fileUrl, {
        method: 'PUT',
        headers: {
          ...auth,
          'content-type': 'application/octet-stream',
          'x-file-name': 'smoke.txt',
          'x-file-mime': 'text/plain',
        },
        body: bytes,
      });
      expect(put.status).toBe(201);
      const got = await fetch(fileUrl, { headers: auth });
      expect(Buffer.from(await got.arrayBuffer()).equals(bytes)).toBe(true);

      // Search (the server indexes what was synced).
      await until(async () => {
        const res = await fetch(`${base}/api/workspaces/${workspace.id}/search?q=checker`, {
          headers: auth,
        });
        const { results } = (await res.json()) as { results: { id: string }[] };
        return results.some((r) => r.id === pageId);
      }, 'search finds the page');

      // The web app.
      const page = await fetch(`${base}/w/${workspace.id}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<div id="root">');
    } finally {
      a.client.stop();
      b.client.stop();
    }
  }, 60_000);

  it('a second account gets only the page shared with it, live; a published page is public', async () => {
    const stamp = Date.now();
    const call = async <T>(method: string, path: string, token: string | null, body?: object) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-workspace-client': 'smoke',
          // A JSON type only with a body (an empty one isn't JSON).
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
      return (await res.json()) as T;
    };
    const signup = (who: string, invite?: string) =>
      call<{ token: string; user: { id: string } }>('POST', '/api/auth/signup', null, {
        email: `${who}-${stamp}@lab.io`,
        name: who,
        password: 'smoke password',
        client: 'desktop',
        ...(invite ? { invite } : {}),
      });
    const ada = await signup('owner');
    const { workspace } = await call<{ workspace: { id: string } }>(
      'POST',
      '/api/workspaces',
      ada.token,
      { name: 'Shared lab' },
    );
    const ws = `/api/workspaces/${workspace.id}`;
    const { scope: mine } = await call<{ scope: { id: string; treeDoc: string } }>(
      'POST',
      `${ws}/private`,
      ada.token,
    );
    const { invites } = await call<{ invites: { link: string }[] }>(
      'POST',
      `${ws}/invites`,
      ada.token,
      { emails: [`member-${stamp}@lab.io`], role: 'member' },
    );
    const bob = await signup('member', invites[0]!.link.split('/invite/')[1]);

    const url = `${base!.replace(/^http/, 'ws')}/api/sync/${workspace.id}`;
    const a = new TestDevice({ url, token: ada.token, deviceId: 'smoke-owner' });
    const b = new TestDevice({ url, token: bob.token, deviceId: 'smoke-member' });
    try {
      a.client.start();
      b.client.start();
      await until(() => a.client.state.state === 'live' && b.client.state.state === 'live', 'live');
      // Two of Ada's private pages.
      a.hint = mine.id;
      const shared = createPage(a.doc(mine.treeDoc), { title: 'For Bob' });
      const hidden = createPage(a.doc(mine.treeDoc), { title: 'Only mine' });
      for (const [id, text] of [
        [shared, 'Shared through Caddy.'],
        [hidden, 'Nobody else reads this.'],
      ] as const) {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        getPageContent(a.doc(id)).insert(0, [paragraph]);
      }
      await until(() => a.outbox.length === 0, 'Ada synced');
      await new Promise((r) => setTimeout(r, 500));
      expect(b.has(shared) || b.has(hidden) || b.has(mine.treeDoc)).toBe(false);

      // Shared with Bob: it reaches his device, live; the other page doesn't.
      const { scope } = await call<{ scope: { id: string } }>(
        'POST',
        `${ws}/pages/${shared}/share`,
        ada.token,
        { scope: mine.id },
      );
      await call('PUT', `${ws}/scopes/${scope.id}/access`, ada.token, {
        principal: `user:${bob.user.id}`,
        role: 'view',
      });
      await until(
        () => getPageContent(b.doc(shared)).toString().includes('Shared through Caddy.'),
        'Bob has the shared page',
      );
      expect(b.has(hidden)).toBe(false);

      // Published: anyone reads it through Caddy; unpublished, it's gone.
      const slug = `smoke-${stamp}`;
      await call('PUT', `${ws}/pages/${shared}/publish`, ada.token, { slug });
      const page = await fetch(`${base}/p/${slug}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      const html = await page.text();
      expect(html).toContain('Shared through Caddy.');
      expect(html).not.toContain('Nobody else reads this.');
      await call('DELETE', `${ws}/pages/${shared}/publish`, ada.token);
      expect((await fetch(`${base}/p/${slug}`)).status).toBe(404);
    } finally {
      a.client.stop();
      b.client.stop();
    }
  }, 60_000);

  it('the API, a public form and an integration webhook, through Caddy', async () => {
    const stamp = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Json = Record<string, any>;
    const call = async (method: string, path: string, token: string | null, body?: object) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-workspace-client': 'smoke',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
      return (await res.json()) as Json;
    };
    const ada = await call('POST', '/api/auth/signup', null, {
      email: `api-${stamp}@lab.io`,
      name: 'Api',
      password: 'smoke password',
      client: 'desktop',
    });
    const { workspace } = await call('POST', '/api/workspaces', ada.token, { name: 'API lab' });
    const ws = `/api/workspaces/${workspace.id}`;
    const { defaultScopeId } = await call('GET', `${ws}/scopes`, ada.token);

    // A receiver for the integration's webhook, if the server can reach this machine.
    const got: Json[] = [];
    const receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        got.push(JSON.parse(body) as Json);
        res.end('ok');
      });
    });
    if (webhookHost) await new Promise<void>((r) => receiver.listen(0, '0.0.0.0', r));

    const url = `${base!.replace(/^http/, 'ws')}/api/sync/${workspace.id}`;
    const a = new TestDevice({ url, token: ada.token, deviceId: 'smoke-api' });
    try {
      a.client.start();
      await until(() => a.client.state.state === 'live', 'live');
      // A database with a public form.
      const orders = createPage(a.doc(WORKSPACE_DOC_ID), { title: 'Orders', kind: 'database' });
      const db = a.doc(orders);
      initDatabase(db, { databaseId: orders });
      const formId = addView(db, { viewSet: orders, name: 'Order form', type: 'form' });
      const form = readDatabase(db).views.find((v) => v.id === formId)!.form!;
      updateView(db, formId, { form: { ...form, title: 'Place an order', audience: 'public' } });
      await until(() => a.outbox.length === 0, 'synced');

      // An integration connected to it.
      const made = await call('POST', `${ws}/integrations`, ada.token, { name: 'Smoke bot' });
      const bot = { id: made.integration.id as string, token: made.token as string };
      const { scope } = await call('POST', `${ws}/pages/${orders}/share`, ada.token, {
        scope: defaultScopeId,
      });
      await call('PUT', `${ws}/scopes/${scope.id}/access`, ada.token, {
        principal: `user:${bot.id}`,
        role: 'edit',
      });
      if (webhookHost) {
        const port = (receiver.address() as AddressInfo).port;
        await call('PUT', `${ws}/integrations/${bot.id}/webhook`, ada.token, {
          url: `http://${webhookHost}:${port}/hook`,
          events: ['page.created'],
        });
        await until(() => got.some((g) => g.verification_token), 'the verification token');
        const token = got.find((g) => g.verification_token)!.verification_token as string;
        await call('POST', `${ws}/integrations/${bot.id}/webhook/verify`, ada.token, { token });
      }

      // The API, through Caddy.
      const v1 = (method: string, path: string, body?: object) =>
        fetch(`${base}/v1${path}`, {
          method,
          headers: {
            authorization: `Bearer ${bot.token}`,
            'notion-version': '2025-09-03',
            ...(body && { 'content-type': 'application/json' }),
          },
          body: body ? JSON.stringify(body) : undefined,
        }).then(async (r) => ({ status: r.status, body: (await r.json()) as Json }));
      expect((await v1('GET', '/users/me')).body).toMatchObject({ type: 'bot', name: 'Smoke bot' });
      const page = await v1('POST', '/pages', {
        parent: { data_source_id: orders },
        properties: { Name: { title: [{ text: { content: 'From the API' } }] } },
        children: [{ paragraph: { rich_text: [{ text: { content: 'Through Caddy.' } }] } }],
      });
      expect(page.status).toBe(200);
      const blocks = await v1('GET', `/blocks/${page.body.id}/children`);
      expect(blocks.body.results[0].paragraph.rich_text[0].plain_text).toBe('Through Caddy.');

      // The public form: answered signed out.
      const { link } = await call('PUT', `${ws}/forms/${orders}/${formId}/link`, ada.token);
      const formPath = new URL(link as string).pathname;
      const shown = await fetch(`${base}${formPath}`);
      expect(shown.status).toBe(200);
      expect(await shown.text()).toContain('Place an order');
      const sent = await fetch(`${base}${formPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ title: 'From the form' }).toString(),
        redirect: 'manual',
      });
      expect(sent.status).toBeLessThan(400);
      const rows = await v1('POST', `/data_sources/${orders}/query`, {
        sorts: [{ property: 'Name', direction: 'ascending' }],
      });
      expect(rows.body.results.map((r: Json) => r.properties.Name.title[0]?.plain_text)).toEqual([
        'From the API',
        'From the form',
      ]);

      if (webhookHost) {
        await until(
          () => got.some((g) => g.type === 'page.created' && g.entity.id === page.body.id),
          'page.created',
        );
      }
    } finally {
      a.client.stop();
      receiver.close();
    }
  }, 60_000);
});
