/**
 * Share links (Phase 8 N8, #34), end to end: real server, Postgres and sockets. Ada makes a
 * link for one of her private pages; Carol (not in the workspace) signs up and uses it,
 * and gets that page alone, with the link's role.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, type NotificationData } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-links-'));
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

const config = (signup = 'open') =>
  loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: signup,
    PUBLIC_URL: 'http://app.test',
  });

async function server(store: PgStore, clock: { now: number }, signup = 'open') {
  const app = buildServer({
    config: config(signup),
    store,
    files: new FsStorage(dir),
    mailer: null,
    notify: { delayMs: 0, reminderPollMs: 60_000, now: () => clock.now },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  cleanups.push(() => store.close());
  const clock = { now: Date.UTC(2026, 9, 1) };
  const app = await server(store, clock);
  cleanups.push(() => app.close());
  const port = (app.server.address() as AddressInfo).port;
  const call = async (method: string, url: string, token: string, payload?: object) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
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
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  for (const [person, role] of [
    [bob, 'member'],
    [gus, 'guest'],
  ] as const) {
    const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [`${person === bob ? 'bob' : 'gus'}@lab.io`],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await call('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  }
  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const device = async (deviceId: string, token: string) => {
    const d = new TestDevice({ url, token, deviceId });
    cleanups.push(() => d.client.stop());
    d.client.start();
    await until(() => d.client.state.state === 'live', 'live');
    return d;
  };
  const settled = (d: TestDevice) => until(() => d.outbox.length === 0, 'outbox sent');
  const inbox = async (token: string, filter = 'all') =>
    (await call('GET', `/api/workspaces/${ws}/notifications?filter=${filter}`, token)).body as {
      notifications: NotificationData[];
      unread: number;
    };
  return { app, store, clock, ws, call, device, settled, inbox, ada, bob, gus };
}

describe('share links', () => {
  it('a link opens one page to whoever signs in, with its role, until it ends', async () => {
    const w = await world();
    const { call, ws, ada, bob, app } = w;
    const scopes = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body as {
      scopes: { id: string; kind: string; treeDoc: string }[];
    };
    const mine = scopes.scopes.find((s) => s.kind === 'private')!;
    const device = await w.device('ada-laptop', ada.token);
    const tree = device.doc(mine.treeDoc);
    const brief = createPage(tree, { title: 'Client brief', createdBy: ada.id });
    const other = createPage(tree, { title: 'Budget', createdBy: ada.id });
    await w.settled(device);
    const link = (token: string, page = brief) => `/api/workspaces/${ws}/pages/${page}/link`;
    await until(
      async () => (await call('GET', link(ada.token), ada.token)).status === 200,
      'indexed',
    );

    // Only with full access: Bob (a member) can't see her private page, nor make a link.
    expect((await call('GET', link(bob.token), bob.token)).status).toBe(403);
    expect(
      (await call('PUT', link(bob.token), bob.token, { role: 'view', days: null })).status,
    ).toBe(403);
    expect((await call('GET', link(ada.token), ada.token)).body).toEqual({ link: null });
    const made = await call('PUT', link(ada.token), ada.token, { role: 'comment', days: 7 });
    expect(made.status).toBe(200);
    expect(made.body.link).toMatchObject({ role: 'comment' });
    const url = made.body.link.url as string;
    expect(url).toMatch(/^http:\/\/app\.test\/s\/[A-Za-z0-9_-]{20,}$/);
    const token = url.split('/s/')[1]!;
    expect(made.body.link.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // Before signing in: what it opens, not the page itself.
    const peek = await app.inject({ method: 'GET', url: `/api/links/${token}` });
    expect(peek.json()).toMatchObject({
      workspace: { name: 'Lab' },
      page: { title: 'Client brief' },
      role: 'comment',
    });
    expect(
      (await app.inject({ method: 'GET', url: '/api/links/notarealtoken123' })).statusCode,
    ).toBe(404);
    // Using it needs an account.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/links/${token}/accept`,
          headers: { 'x-workspace-client': 'test' },
        })
      ).statusCode,
    ).toBe(401);

    // Carol signs up and uses it: a guest, with "comment" on that page alone.
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: {
        email: 'carol@client.io',
        name: 'Carol',
        password: 'long password',
        client: 'desktop',
      },
    });
    const carol = { token: signup.json().token as string, id: signup.json().user.id as string };
    const used = await call('POST', `/api/links/${token}/accept`, carol.token);
    expect(used.status).toBe(200);
    expect(used.body).toEqual({ workspaceId: ws, pageId: brief, role: 'comment' });
    const members = (await call('GET', `/api/workspaces/${ws}/members`, ada.token)).body
      .members as {
      id: string;
      role: string;
    }[];
    expect(members.find((m) => m.id === carol.id)?.role).toBe('guest');
    const theirs = (await call('GET', `/api/workspaces/${ws}/scopes`, carol.token)).body.scopes as {
      id: string;
      role: string;
    }[];
    expect(theirs.map((s) => s.role)).toEqual(['comment']);
    const access = async (page: string) =>
      (await call('GET', `/api/workspaces/${ws}/pages/${page}/access`, carol.token)).body;
    await until(async () => (await access(brief)).exists === true, 'the shared page indexed');
    expect(await access(brief)).toMatchObject({ readable: true });
    expect(await access(other)).toMatchObject({ readable: false });

    // A new link (edit) replaces the old; using it raises her role, never lowers it.
    const edit = await call('PUT', link(ada.token), ada.token, { role: 'edit', days: null });
    const editToken = (edit.body.link.url as string).split('/s/')[1]!;
    expect((await app.inject({ method: 'GET', url: `/api/links/${token}` })).statusCode).toBe(404);
    expect((await call('POST', `/api/links/${editToken}/accept`, carol.token)).status).toBe(200);
    const raised = (await call('GET', `/api/workspaces/${ws}/scopes`, carol.token)).body.scopes as {
      role: string;
    }[];
    expect(raised.map((s) => s.role)).toEqual(['edit']);
    const view = await call('PUT', link(ada.token), ada.token, { role: 'view', days: 1 });
    const viewToken = (view.body.link.url as string).split('/s/')[1]!;
    expect((await call('POST', `/api/links/${viewToken}/accept`, carol.token)).status).toBe(200);
    const kept = (await call('GET', `/api/workspaces/${ws}/scopes`, carol.token)).body.scopes as {
      role: string;
    }[];
    expect(kept.map((s) => s.role)).toEqual(['edit']);

    // On a server where signing up takes an invite, a working link is one.
    const closed = await server(w.store, w.clock, 'invite');
    cleanups.push(() => closed.close());
    const signUp = (email: string, invite?: string) =>
      closed.inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'x-workspace-client': 'test' },
        payload: { email, name: 'Dan', password: 'long password', client: 'desktop', invite },
      });
    expect((await signUp('dan@client.io')).statusCode).toBe(403);
    expect((await signUp('dan@client.io', 'notarealtoken123')).statusCode).toBe(403);
    expect((await signUp('dan@client.io', viewToken)).statusCode).toBe(201);

    // An expired link, and one turned off, don't work.
    await w.store.pool.query("UPDATE share_links SET expires_at = now() - interval '1 minute'");
    expect((await app.inject({ method: 'GET', url: `/api/links/${viewToken}` })).statusCode).toBe(
      410,
    );
    expect((await call('DELETE', link(ada.token), ada.token)).status).toBe(200);
    expect((await call('GET', link(ada.token), ada.token)).body).toEqual({ link: null });
    expect((await app.inject({ method: 'GET', url: `/api/links/${viewToken}` })).statusCode).toBe(
      404,
    );
  });
});
