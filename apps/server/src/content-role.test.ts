/**
 * Phase 6 M1: the "can edit content" role, the server's own edits for someone, and the
 * job runner. Real server, real Postgres, real sockets.
 *
 * Ada (owner) has the database "tasks" in the first teamspace T, with a row "r1" whose
 * page has text, and a page "notes" inside it. She shares "tasks" on its own (scope D)
 * with Gus, a guest, as "content".
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, createThread, readThreads } from '@workspace/core';
import {
  addProperty,
  addRow,
  initDatabase,
  readDatabase,
  setRowTitle,
  updateView,
} from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { EditRefused } from './docs-edit';
import { FsStorage } from './files';
import { PermanentJobError } from './jobs/runner';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-content-'));
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
        role: 'content',
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

describe('the "can edit content" role', () => {
  it('edits rows and their pages, not the database’s properties, views or other pages', async () => {
    const w = await world();
    const g = w.device('gus-1', w.gus.token);
    g.client.start();
    await w.live(g);
    expect(g.scopes.map((s) => [s.id, s.role])).toEqual([[w.D.id, 'content']]);
    expect(g.text('r1')).toBe('row page');
    expect(g.text('notes')).toBe('notes body');

    // Rows: edit one, add one together with its page (one push), write a row's page.
    g.hint = w.D.id;
    setRowTitle(g.doc('tasks'), 'r1', 'Grease the gears well', w.gus.id);
    const r2 = addRow(g.doc('tasks'), { actor: w.gus.id, title: 'Check the bearings' });
    g.doc(r2).getText('t').insert(0, 'new row page');
    g.doc('r1').getText('t').insert(8, ' (checked)');
    // Comments, as for "comment".
    createThread(g.doc('comments:r1'), {
      anchor: { kind: 'page' },
      author: w.gus.id,
      body: 'Which grease?',
    });
    await w.settled(g);
    expect(g.resets).toEqual([]);
    expect(readDatabase(await w.state('tasks')).rows.map((r) => r.title)).toEqual([
      'Grease the gears well',
      'Check the bearings',
    ]);
    expect((await w.state(r2)).getText('t').toString()).toBe('new row page');
    expect((await w.state('r1')).getText('t').toString()).toBe('row page (checked)');
    expect(readThreads(await w.state('comments:r1'))).toHaveLength(1);
    await until(() => w.a.text(r2) === 'new row page', 'Ada sees the new row page');

    // Not the database itself.
    const before = readDatabase(await w.state('tasks'));
    addProperty(g.doc('tasks'), { name: 'Owner', type: 'person' });
    await w.settled(g);
    await until(() => g.resets.includes('tasks'), 'property undone');
    updateView(g.doc('tasks'), before.views[0]!.id, { name: 'Mine' });
    await w.settled(g);
    await until(() => g.resets.filter((d) => d === 'tasks').length === 2, 'view undone');
    const after = readDatabase(await w.state('tasks'));
    expect(after.properties.map((p) => p.name)).toEqual(before.properties.map((p) => p.name));
    expect(after.views.map((v) => v.name)).toEqual(before.views.map((v) => v.name));
    // Nor a page in it that isn't a row, nor the tree.
    g.doc('notes').getText('t').insert(0, 'gus ');
    g.doc(w.D.treeDoc).getMap('x').set('y', 1);
    await w.settled(g);
    await until(() => g.resets.includes('notes'), 'notes undone');
    expect((await w.state('notes')).getText('t').toString()).toBe('notes body');
    // Nor a new doc that isn't a row's page.
    g.doc('loose').getText('t').insert(0, 'not a row');
    await w.settled(g);
    expect(await w.store.docState(w.ws, 'loose')).toBeNull();
    // Rows still work after all that.
    setRowTitle(g.doc('tasks'), r2, 'Check the bearings twice', w.gus.id);
    await w.settled(g);
    await until(
      async () =>
        readDatabase(await w.state('tasks')).rows.some(
          (r) => r.title === 'Check the bearings twice',
        ),
      'row edit stored',
    );
  });
});

describe('server edits for someone', () => {
  it('pass the same checks as the person’s own pushes, and record them as author', async () => {
    const w = await world();
    const seq = await w.store.latestSeq(w.ws);
    const docs = w.app.docs;
    // Gus (content) may add a row through the server...
    const { result: id, seq: at } = await docs.edit(w.ws, 'tasks', { userId: w.gus.id }, (doc) =>
      addRow(doc, { actor: w.gus.id, title: 'Added by the server' }),
    );
    expect(at).toBeGreaterThan(seq);
    await until(
      () => readDatabase(w.a.doc('tasks')).rows.some((r) => r.id === id),
      'Ada’s device gets it live',
    );
    expect(await w.store.pages.authorsSince(w.ws, 'tasks', seq)).toEqual([w.gus.id]);
    // ...but not a property, nor a page he can't edit.
    await expect(
      docs.edit(w.ws, 'tasks', { userId: w.gus.id }, (doc) =>
        addProperty(doc, { name: 'Nope', type: 'text' }),
      ),
    ).rejects.toBeInstanceOf(EditRefused);
    await expect(
      docs.edit(w.ws, 'notes', { userId: w.gus.id }, (doc) => doc.getText('t').insert(0, 'x')),
    ).rejects.toBeInstanceOf(EditRefused);
    // Nothing changed: nothing stored.
    expect((await docs.edit(w.ws, 'notes', { userId: w.ada.id }, () => 1)).seq).toBeNull();
    // Edits to one doc run one after the other, none lost.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        docs.edit(w.ws, 'tasks', { userId: w.ada.id }, (doc) =>
          addRow(doc, { actor: w.ada.id, title: `Batch ${i}` }),
        ),
      ),
    );
    const titles = readDatabase(await w.state('tasks')).rows.map((r) => r.title);
    expect(titles.filter((t) => t.startsWith('Batch'))).toHaveLength(5);
    // Trusted edits (the caller checked): a new doc must say where it goes.
    await expect(
      docs.edit(w.ws, 'fresh', { trusted: true, userId: null }, (doc) =>
        doc.getText('t').insert(0, 'x'),
      ),
    ).rejects.toBeInstanceOf(EditRefused);
    await docs.edit(
      w.ws,
      'fresh',
      { trusted: true, userId: null },
      (doc) => doc.getText('t').insert(0, 'placed'),
      { scope: w.D.id },
    );
    const access = await w.app.inject({
      method: 'GET',
      url: `/api/workspaces/${w.ws}/pages/fresh/location`,
      headers: { authorization: `Bearer ${w.gus.token}` },
    });
    expect(access.statusCode).not.toBe(403);
    const g = w.device('gus-2', w.gus.token);
    g.client.start();
    await w.live(g);
    expect(g.text('fresh')).toBe('placed');
  });
});

describe('the job runner', () => {
  it('runs jobs, retries failures, and gives up on permanent ones', async () => {
    const w = await world();
    const seen: string[] = [];
    let flaky = 0;
    w.app.jobs.register('test.ok', async (job) => {
      seen.push((job.payload as { n: string }).n);
      return { done: true };
    });
    w.app.jobs.register('test.flaky', async () => {
      if (++flaky < 3) throw new Error(`try ${flaky}`);
      return 'third time';
    });
    w.app.jobs.register('test.bad', async () => {
      throw new PermanentJobError('no such database');
    });
    w.app.jobs.start();
    const [ok] = await w.store.jobs.enqueue([
      { workspaceId: w.ws, kind: 'test.ok', payload: { n: 'a' } },
    ]);
    const [fl] = await w.store.jobs.enqueue([{ workspaceId: w.ws, kind: 'test.flaky' }]);
    const [bad] = await w.store.jobs.enqueue([{ workspaceId: w.ws, kind: 'test.bad' }]);
    await until(async () => (await w.store.jobs.get(fl!))?.doneAt != null, 'flaky done');
    expect(seen).toEqual(['a']);
    expect(await w.store.jobs.get(ok!)).toMatchObject({ result: { done: true } });
    expect(await w.store.jobs.get(fl!)).toMatchObject({ result: 'third time', attempts: 3 });
    const failed = await w.store.jobs.get(bad!);
    expect(failed).toMatchObject({ attempts: 1, lastError: 'no such database' });
    expect(failed!.failedAt).not.toBeNull();
  });
});
