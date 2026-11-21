/**
 * Phase 8 N8 (#22): the "can create pages" role. Real server, real Postgres, real sockets.
 *
 * Ada (owner) has the database "tasks" with her row "r1" (its page has text) and a page
 * "notes" inside it. She shares "tasks" on its own (scope D) with Gus, a guest, as "create":
 * he may add rows and edit those he made, not hers nor the database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage } from '@workspace/core';
import { addProperty, addRow, initDatabase, readDatabase, setRowTitle } from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-create-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const app = buildServer({
    config,
    store,
    files: new FsStorage(dir),
    mailer: null,
    jobs: { pollMs: 20, backoffMs: [30] },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
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
  const ada = await signup('ada');
  const gus = await signup('gus');
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
    emails: ['gus@lab.io'],
    role: 'guest',
  });
  const token = (invite.body.invites[0].link as string).split('/invite/')[1];
  expect((await call('POST', `/api/invites/${token}/accept`, gus.token)).status).toBe(200);

  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const device = (deviceId: string, token: string) => {
    const d = new TestDevice({ url, token, deviceId });
    cleanups.push(() => d.client.stop());
    return d;
  };
  const live = (d: TestDevice) => until(() => d.client.state.state === 'live', 'live');
  const settled = (d: TestDevice) => until(() => d.outbox.length === 0, 'outbox sent');

  const a = device('ada-1', ada.token);
  a.client.start();
  await live(a);
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
    .defaultScopeId as string;
  createPage(a.doc('workspace'), { id: 'tasks', title: 'Tasks' });
  createPage(a.doc('workspace'), { id: 'notes', title: 'Notes', parentId: 'tasks' });
  initDatabase(a.doc('tasks'), { databaseId: 'tasks' });
  addRow(a.doc('tasks'), { id: 'r1', actor: ada.id, title: 'Grease the gears' });
  a.doc('r1').getText('t').insert(0, 'row page');
  a.doc('notes').getText('t').insert(0, 'notes body');
  await settled(a);
  const shared = await call('POST', `/api/workspaces/${ws}/pages/tasks/share`, ada.token, {
    scope: T,
  });
  expect(shared.status).toBe(201);
  const D = shared.body.scope as { id: string; treeDoc: string };
  expect(
    (
      await call('PUT', `/api/workspaces/${ws}/scopes/${D.id}/access`, ada.token, {
        principal: `user:${gus.id}`,
        role: 'create',
      })
    ).status,
  ).toBe(200);

  const state = async (docId: string) => {
    const doc = new Y.Doc();
    const update = await store.docState(ws, docId);
    if (update) Y.applyUpdate(doc, update);
    return doc;
  };
  return { app, store, ws, call, device, live, settled, state, a, ada, gus, T, D };
}

describe('the "can create pages" role', () => {
  it('adds rows and edits its own, not someone else’s rows, their pages, or the database', async () => {
    const w = await world();
    const g = w.device('gus-1', w.gus.token);
    g.client.start();
    await w.live(g);
    expect(g.scopes.map((s) => [s.id, s.role])).toEqual([[w.D.id, 'create']]);
    expect(g.text('r1')).toBe('row page');

    // His own row, with its page, in one push; then edited.
    g.hint = w.D.id;
    const r2 = addRow(g.doc('tasks'), { actor: w.gus.id, title: 'Request: a new gripper' });
    g.doc(r2).getText('t').insert(0, 'two fingers');
    await w.settled(g);
    expect(g.resets).toEqual([]);
    setRowTitle(g.doc('tasks'), r2, 'Request: a soft gripper', w.gus.id);
    g.doc(r2).getText('t').insert(0, 'soft, ');
    await w.settled(g);
    expect(g.resets).toEqual([]);
    await until(
      async () =>
        readDatabase(await w.state('tasks')).rows.some(
          (r) => r.title === 'Request: a soft gripper',
        ),
      'his row stored',
    );
    expect((await w.state(r2)).getText('t').toString()).toBe('soft, two fingers');
    await until(() => w.a.text(r2) === 'soft, two fingers', 'Ada sees his row page');

    // Not Ada's row, nor its page.
    setRowTitle(g.doc('tasks'), 'r1', 'Mine now', w.gus.id);
    await w.settled(g);
    await until(() => g.resets.includes('tasks'), 'her row undone');
    g.doc('r1').getText('t').insert(0, 'gus ');
    await w.settled(g);
    await until(() => g.resets.includes('r1'), 'her row page undone');
    expect((await w.state('r1')).getText('t').toString()).toBe('row page');
    // Nor a row in her name.
    addRow(g.doc('tasks'), { actor: w.ada.id, title: 'Fake' });
    await w.settled(g);
    await until(() => g.resets.filter((d) => d === 'tasks').length === 2, 'fake row undone');
    // Nor the database.
    addProperty(g.doc('tasks'), { name: 'Owner', type: 'person' });
    await w.settled(g);
    await until(() => g.resets.filter((d) => d === 'tasks').length === 3, 'property undone');
    const stored = readDatabase(await w.state('tasks'));
    expect(stored.rows.map((r) => r.title)).toEqual([
      'Grease the gears',
      'Request: a soft gripper',
    ]);
    expect(stored.properties.some((p) => p.name === 'Owner')).toBe(false);

    // His own row still works after all that.
    setRowTitle(g.doc('tasks'), r2, 'Request: two soft grippers', w.gus.id);
    await w.settled(g);
    await until(
      async () =>
        readDatabase(await w.state('tasks')).rows.some(
          (r) => r.title === 'Request: two soft grippers',
        ),
      'his edit after the refusals',
    );
  });
});
