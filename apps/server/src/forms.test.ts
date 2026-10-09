/**
 * Phase 6 M2: forms on the server. Real server, real Postgres, real sockets.
 *
 * Ada (owner) has the database "parts" in the first teamspace T, with a form. Vi, a
 * member, may only view T; Xo isn't in the workspace.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  addOption,
  addProperty,
  addView,
  initDatabase,
  readDatabase,
  updateView,
  type FormConfig,
} from '@workspace/database';
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
  dir = mkdtempSync(join(tmpdir(), 'workspace-forms-'));
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
  const app = buildServer({ config, store, files: new FsStorage(dir), mailer: null });
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
  const vi = await signup('vi');
  const xo = await signup('xo');
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
    emails: ['vi@lab.io'],
    role: 'member',
  });
  const token = (invite.body.invites[0].link as string).split('/invite/')[1];
  expect((await call('POST', `/api/invites/${token}/accept`, vi.token)).status).toBe(200);
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
    .defaultScopeId as string;
  // Everyone may only view T (Ada has full access as the owner).
  expect(
    (
      await call('PUT', `/api/workspaces/${ws}/scopes/${T}/access`, ada.token, {
        principal: 'workspace',
        role: 'view',
      })
    ).status,
  ).toBe(200);

  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const a = new TestDevice({ url, token: ada.token, deviceId: 'ada-1' });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  createPage(a.doc('workspace'), { id: 'parts', title: 'Parts' });
  const db = a.doc('parts');
  initDatabase(db, { databaseId: 'parts' });
  const qty = addProperty(db, { name: 'Quantity', type: 'number' });
  const size = addProperty(db, { name: 'Size', type: 'select' });
  addOption(db, size, { id: 's', name: 'Small', color: 'blue' });
  addOption(db, size, { id: 'l', name: 'Large', color: 'red' });
  const owner = addProperty(db, { name: 'Owner', type: 'person' });
  const formId = addView(db, { viewSet: 'parts', name: 'Order form', type: 'form' });
  const tableId = readDatabase(db).views.find((v) => v.type === 'table')!.id;
  const setForm = (changes: Partial<FormConfig>) => {
    const form = readDatabase(db).views.find((v) => v.id === formId)!.form;
    updateView(db, formId, { form: { ...form, ...changes } });
  };
  setForm({
    title: 'Order a part',
    questions: [
      { propertyId: TITLE_PROPERTY_ID, label: 'Part', description: '', required: true },
      { propertyId: qty, label: 'How many?', description: '', required: false },
      { propertyId: size, label: '', description: '', required: false },
      { propertyId: owner, label: 'Who needs it', description: '', required: false },
    ],
    notify: true,
    createdBy: ada.id,
  });
  await until(() => a.outbox.length === 0, 'outbox sent');

  const rows = async () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await store.docState(ws, 'parts'))!);
    return readDatabase(doc).rows;
  };
  const base = `/api/workspaces/${ws}/forms/parts/${formId}`;
  return {
    app,
    store,
    ws,
    call,
    a,
    ada,
    vi,
    xo,
    ids: { qty, size, owner, formId, tableId },
    setForm,
    rows,
    base,
  };
}

const post = (fields: [string, string][]) => new URLSearchParams(fields).toString();

describe('forms', () => {
  it('someone who may only view the database responds from the app; the server writes the row', async () => {
    const w = await world();
    const { qty, size, owner } = w.ids;
    const ok = await w.call('POST', `${w.base}/submit`, w.vi.token, {
      answers: { [TITLE_PROPERTY_ID]: 'Bearing 608', [qty]: 4, [size]: 's', [owner]: [w.vi.id] },
    });
    expect(ok.status).toBe(201);
    const row = (await w.rows()).find((r) => r.id === ok.body.rowId)!;
    expect(row).toMatchObject({
      title: 'Bearing 608',
      createdBy: w.vi.id,
      values: { [qty]: 4, [size]: 's', [owner]: [w.vi.id] },
    });
    // Live on Ada's device, by Vi in the log.
    await until(
      () => readDatabase(w.a.doc('parts')).rows.some((r) => r.id === ok.body.rowId),
      'Ada sees the response',
    );
    // Ada was told (she asked to be).
    const inbox = await w.store.notifications.list(w.ws, w.ada.id);
    expect(inbox[0]).toMatchObject({ kind: 'form', pageId: ok.body.rowId, actorId: w.vi.id });
    expect(inbox[0]!.text).toContain('Bearing 608');

    // Wrong answers: nothing is written.
    const before = (await w.rows()).length;
    const bad = await w.call('POST', `${w.base}/submit`, w.vi.token, {
      answers: { [qty]: 'many', [size]: 'medium', sneaky: 1, [owner]: ['not-a-member'] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { propertyId: string }) => e.propertyId).sort()).toEqual(
      [TITLE_PROPERTY_ID, owner, qty, size, 'sneaky'].sort(),
    );
    expect((await w.rows()).length).toBe(before);
    // Not a form, or not someone in the workspace: no such form.
    const notForm = `/api/workspaces/${w.ws}/forms/parts/${w.ids.tableId}/submit`;
    expect((await w.call('POST', notForm, w.vi.token, { answers: {} })).status).toBe(404);
    expect(
      (
        await w.call('POST', `${w.base}/submit`, w.xo.token, {
          answers: { [TITLE_PROPERTY_ID]: 'x' },
        })
      ).status,
    ).toBe(404);
  });

  it('public links: anyone responds anonymously while the form is public and the link current', async () => {
    const w = await world();
    const { qty, size } = w.ids;
    // Only someone with full access makes the link.
    expect((await w.call('PUT', `${w.base}/link`, w.vi.token)).status).toBe(403);
    expect((await w.call('GET', `${w.base}/link`, w.ada.token)).body).toEqual({ link: null });
    const made = await w.call('PUT', `${w.base}/link`, w.ada.token);
    expect(made.status).toBe(200);
    const link = made.body.link as string;
    expect(link).toMatch(/^http:\/\/app\.test\/f\/[A-Za-z0-9_-]{22}$/);
    const path = new URL(link).pathname;

    // Not public yet: the link shows nothing.
    expect((await w.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    w.setForm({ audience: 'public' });
    await until(() => w.a.outbox.length === 0, 'outbox sent');

    const page = await w.app.inject({ method: 'GET', url: path });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['x-robots-tag']).toContain('noindex');
    expect(page.body).toContain('Order a part');
    expect(page.body).toContain('How many?');
    // Nobody signed in can pick people: that question isn't asked here.
    expect(page.body).not.toContain('Who needs it');
    expect(page.body).not.toContain('<script');

    const send = (fields: [string, string][]) =>
      w.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: post(fields),
      });
    const count = async () => (await w.rows()).length;
    const before = await count();
    const done = await send([
      [TITLE_PROPERTY_ID, 'Gear <b>12T</b>'],
      [qty, '3'],
      [size, 'l'],
    ]);
    expect(done.statusCode).toBe(200);
    expect(done.body).toContain('Thanks! Your response was recorded.');
    const row = (await w.rows()).at(-1)!;
    expect(row).toMatchObject({
      title: 'Gear <b>12T</b>',
      createdBy: null,
      values: { [qty]: 3, [size]: 'l' },
    });
    expect(await count()).toBe(before + 1);

    // A missing required answer: the form again, with the error and what was typed.
    const missing = await send([[qty, '7']]);
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toContain('Required');
    expect(missing.body).toContain('value="7"');
    // Fields that aren't questions (the person question included) are refused.
    const extra = await send([
      [TITLE_PROPERTY_ID, 'x'],
      [w.ids.owner, w.ada.id],
    ]);
    expect(extra.statusCode).toBe(400);
    // A robot that fills in the hidden field is thanked, and nothing is kept.
    const robot = await send([
      [TITLE_PROPERTY_ID, 'Buy now'],
      ['website', 'http://spam.example'],
    ]);
    expect(robot.statusCode).toBe(200);
    expect(await count()).toBe(before + 1);

    // A new link turns the old one off; turning it off ends it.
    const again = await w.call('PUT', `${w.base}/link`, w.ada.token);
    expect(again.body.link).not.toBe(link);
    expect((await w.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    const newPath = new URL(again.body.link as string).pathname;
    expect((await w.app.inject({ method: 'GET', url: newPath })).statusCode).toBe(200);
    expect((await w.call('DELETE', `${w.base}/link`, w.ada.token)).body).toEqual({ link: null });
    expect((await w.app.inject({ method: 'GET', url: newPath })).statusCode).toBe(404);
    // Garbage tokens.
    expect((await w.app.inject({ method: 'GET', url: '/f/nope' })).statusCode).toBe(404);
  });

  it('limits how fast one address posts to public forms', async () => {
    const w = await world();
    w.setForm({ audience: 'public' });
    await until(() => w.a.outbox.length === 0, 'outbox sent');
    const path = new URL((await w.call('PUT', `${w.base}/link`, w.ada.token)).body.link).pathname;
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await w.app.inject({
        method: 'POST',
        url: path,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: post([[TITLE_PROPERTY_ID, `Spam ${i}`]]),
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.at(-1)).toBe(429);
  });
});
