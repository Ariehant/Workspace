/**
 * Requests for access (Phase 8 N4), end to end: real server, Postgres and sockets. Ada has
 * private pages; Bob (a member) and Gus (a guest) can't read them, and ask.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, type NotificationData } from '@workspace/core';
import { addRow, initDatabase } from '@workspace/database';
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
  dir = mkdtempSync(join(tmpdir(), 'workspace-requests-'));
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

const config = () =>
  loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });

async function server(store: PgStore, clock: { now: number }) {
  const app = buildServer({
    config: config(),
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

describe('requests for access', () => {
  it('ask, are told no more than that the page exists, and get it shared; or not', async () => {
    const w = await world();
    const { call, ws, ada, bob, gus } = w;
    const scopes = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body as {
      scopes: { id: string; kind: string; treeDoc: string }[];
    };
    const mine = scopes.scopes.find((s) => s.kind === 'private')!;
    const device = await w.device('ada-laptop', ada.token);
    const tree = device.doc(mine.treeDoc);
    const specs = createPage(tree, { title: 'Specs', createdBy: ada.id });
    const budget = createPage(tree, { title: 'Budget', createdBy: ada.id });
    const parts = createPage(tree, { title: 'Parts', kind: 'database' });
    const db = device.doc(parts);
    initDatabase(db, { databaseId: parts });
    const row = addRow(db, { actor: ada.id, title: 'Servo' });
    await w.settled(device);
    const access = (token: string, page: string) =>
      call('GET', `/api/workspaces/${ws}/pages/${page}/access`, token);
    const ask = (token: string, page: string, body: object) =>
      call('POST', `/api/workspaces/${ws}/pages/${page}/access-requests`, token, body);
    await until(async () => (await access(bob.token, row)).body.exists === true, 'pages indexed');

    // What Bob learns: it exists, he can't read it, he hasn't asked. Not its title.
    const seen = await access(bob.token, specs);
    expect(seen.body).toEqual({ exists: true, readable: false, request: null });
    expect(JSON.stringify(seen.body)).not.toContain('Specs');
    expect((await access(bob.token, 'no-such-page')).body).toEqual({ exists: false });
    expect((await access(ada.token, specs)).body).toEqual({ exists: true, readable: true });
    // Someone outside the workspace: nothing at all.
    const res = await w.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email: 'xo@else.io', name: 'Xo', password: 'long password', client: 'desktop' },
    });
    const xo = res.json().token as string;
    expect((await access(xo, specs)).status).toBe(404);
    expect((await ask(xo, specs, { role: 'view' })).status).toBe(404);

    // Bob asks to edit, once; Ada can already read it so she can't ask.
    const asked = await ask(bob.token, specs, { role: 'edit', message: 'For the review' });
    expect(asked.status).toBe(201);
    expect(asked.body.request).toMatchObject({ role: 'edit', status: 'pending' });
    expect((await ask(bob.token, specs, { role: 'view' })).status).toBe(409);
    expect((await ask(ada.token, specs, { role: 'view' })).status).toBe(409);
    expect((await ask(bob.token, specs, { role: 'full' })).status).toBe(400);
    expect((await access(bob.token, specs)).body.request).toMatchObject({ status: 'pending' });

    // Ada (full access to her private pages) is told, with Bob's message.
    await until(
      async () => (await w.inbox(ada.token)).notifications.some((n) => n.kind === 'request'),
      'Ada told',
    );
    const told = (await w.inbox(ada.token)).notifications.find((n) => n.kind === 'request')!;
    expect(told).toMatchObject({
      pageId: specs,
      title: 'Specs',
      actorId: bob.id,
      text: 'For the review',
      key: `request:${asked.body.request.id}`,
      readAt: null,
    });
    const listed = await call(
      'GET',
      `/api/workspaces/${ws}/access-requests?pageId=${specs}`,
      ada.token,
    );
    expect(listed.body.requests).toEqual([
      expect.objectContaining({ id: asked.body.request.id, requesterId: bob.id, role: 'edit' }),
    ]);
    // Only people with full access see or answer it.
    expect(
      (await call('GET', `/api/workspaces/${ws}/access-requests`, gus.token)).body.requests,
    ).toEqual([]);
    const id = asked.body.request.id as string;
    expect(
      (await call('GET', `/api/workspaces/${ws}/access-requests/${id}`, bob.token)).status,
    ).toBe(403);
    expect(
      (await call('POST', `/api/workspaces/${ws}/access-requests/${id}/approve`, gus.token, {}))
        .status,
    ).toBe(403);

    // Ada shares it (to comment, not edit): Bob can read it and is told.
    const approved = await call(
      'POST',
      `/api/workspaces/${ws}/access-requests/${id}/approve`,
      ada.token,
      {
        role: 'comment',
      },
    );
    expect(approved.status).toBe(200);
    expect(approved.body.request).toMatchObject({ status: 'approved', decidedBy: ada.id });
    expect((await access(bob.token, specs)).body).toEqual({ exists: true, readable: true });
    await until(
      async () =>
        (await w.inbox(bob.token)).notifications.some(
          (n) => n.kind === 'access' && n.text === 'Shared Specs',
        ),
      'Bob told',
    );
    const bobScopes = (await call('GET', `/api/workspaces/${ws}/scopes`, bob.token)).body as {
      scopes: { kind: string; role: string }[];
    };
    expect(bobScopes.scopes.filter((s) => s.kind === 'shared').map((s) => s.role)).toEqual([
      'comment',
    ]);
    expect(
      (await w.inbox(ada.token)).notifications.find((n) => n.kind === 'request')!.readAt,
    ).not.toBeNull();
    expect(
      (await call('POST', `/api/workspaces/${ws}/access-requests/${id}/approve`, ada.token, {}))
        .status,
    ).toBe(409);

    // Gus asks for another page; Ada declines; Gus sees it and may ask again.
    const gusAsked = await ask(gus.token, budget, { role: 'view' });
    expect(gusAsked.status).toBe(201);
    const declined = await call(
      'POST',
      `/api/workspaces/${ws}/access-requests/${gusAsked.body.request.id}/decline`,
      ada.token,
    );
    expect(declined.body.request.status).toBe('declined');
    expect((await access(gus.token, budget)).body).toMatchObject({
      readable: false,
      request: { status: 'declined' },
    });
    expect((await ask(gus.token, budget, { role: 'view' })).status).toBe(201);

    // A row is asked for as its database.
    const rowAsked = await ask(bob.token, row, { role: 'view' });
    expect(rowAsked.status).toBe(201);
    const forRow = await call(
      'GET',
      `/api/workspaces/${ws}/access-requests/${rowAsked.body.request.id}`,
      ada.token,
    );
    expect(forRow.body.request.pageId).toBe(parts);

    // At most 20 an hour.
    for (let i = 0; i < 20; i++) {
      await w.store.accessRequests.create({
        workspaceId: ws,
        pageId: `page-${i}`,
        requesterId: gus.id,
        role: 'view',
        message: '',
      });
    }
    expect((await ask(gus.token, parts, { role: 'view' })).status).toBe(429);
  });
});
