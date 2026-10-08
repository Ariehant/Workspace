/**
 * The deployed stack, end to end: run against `docker compose up` (Caddy with TLS in
 * front of the server). Skipped unless STACK_URL is set, e.g.
 *
 *   STACK_URL=https://localhost NODE_EXTRA_CA_CERTS=caddy-root.crt vitest run src/stack.smoke.test.ts
 *
 * A device signs up, creates a workspace and syncs with a second device over wss, an
 * attachment goes up and comes back, search finds the page, and the web app is served.
 */
import { createHash } from 'node:crypto';
import { WORKSPACE_DOC_ID, createPage, getPageContent } from '@workspace/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TestDevice } from './sync/test-client';

const base = process.env.STACK_URL?.replace(/\/+$/, '');

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
});
