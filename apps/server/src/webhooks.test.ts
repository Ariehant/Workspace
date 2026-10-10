/**
 * Phase 6 M7: integration webhooks. Real server, real Postgres, a desktop over a real
 * socket, and a local receiver.
 *
 * Ada (owner) has "Robots" (with "Arm design" and the database "Parts" under it) and
 * "Secrets", in the first teamspace. Her integration "Lab bot" is connected to Robots.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  createPage,
  createThread,
  deleteComment,
  editComment,
  listPages,
  movePage,
  restorePage,
  setPageOptions,
  setPageTitle,
  trashPage,
  commentsDocId,
  readThreads,
} from '@workspace/core';
import { addProperty, addRow, initDatabase, setCell, trashRow } from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';
import { WEBHOOK_EVENTS } from './webhooks/integration-events';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-webhooks-'));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

/** A local receiver: answers `status()` (200 by default), keeps what it got. */
async function receiver() {
  const got: { body: string; json: Json; headers: IncomingMessage['headers'] }[] = [];
  const control = { status: 200 };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      got.push({ body, json: JSON.parse(body) as Json, headers: req.headers });
      res.statusCode = control.status;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  const events = () => got.filter((g) => g.json.type).map((g) => g.json);
  return { url, got, control, events };
}

const ROBOTS = '0e1f2a3b-0000-4000-8000-000000000001';
const ARM = '0e1f2a3b-0000-4000-8000-000000000002';
const PARTS = '0e1f2a3b-0000-4000-8000-000000000003';
const SECRETS = '0e1f2a3b-0000-4000-8000-000000000004';

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
    WEBHOOK_ALLOW_PRIVATE: 'true',
    WEBHOOK_ALLOW_HTTP: 'true',
  });
  const app = buildServer({
    config,
    store,
    files: new FsStorage(dir),
    mailer: null,
    jobs: { pollMs: 20, backoffMs: [30] },
    automations: { delayMs: 50 },
    webhookEvents: { delayMs: 50, mergeMs: 400 },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  app.jobs.start();
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
    return { status: res.statusCode, body: res.json() as Json };
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
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
    .defaultScopeId as string;
  const a = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
    token: ada.token,
    deviceId: 'ada-1',
  });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  const settled = () => until(() => a.outbox.length === 0, 'outbox sent');
  createPage(a.doc('workspace'), { id: ROBOTS, title: 'Robots' });
  createPage(a.doc('workspace'), { id: ARM, title: 'Arm design', parentId: ROBOTS });
  createPage(a.doc('workspace'), { id: PARTS, title: 'Parts', parentId: ROBOTS, kind: 'database' });
  createPage(a.doc('workspace'), { id: SECRETS, title: 'Secrets' });
  a.doc(ARM).getText('t').insert(0, 'arm notes');
  a.doc(SECRETS).getText('t').insert(0, 'hush');
  initDatabase(a.doc(PARTS), { databaseId: PARTS });
  await settled();

  const made = await call('POST', `/api/workspaces/${ws}/integrations`, ada.token, {
    name: 'Lab bot',
  });
  const bot = { id: made.body.integration.id as string, token: made.body.token as string };
  const shared = (
    await call('POST', `/api/workspaces/${ws}/pages/${ROBOTS}/share`, ada.token, { scope: T })
  ).body.scope as { id: string; treeDoc: string };
  const share = async (role: string | null) => {
    const res = await call('PUT', `/api/workspaces/${ws}/scopes/${shared.id}/access`, ada.token, {
      principal: `user:${bot.id}`,
      role,
    });
    expect(res.status).toBe(200);
  };
  await share('edit');
  a.hint = shared.id;
  await until(
    () => listPages(a.doc(shared.treeDoc)).some((p) => p.id === ROBOTS),
    'Robots in its own tree',
  );
  const hook = `/api/workspaces/${ws}/integrations/${bot.id}/webhook`;
  /** Subscribe and verify with the token the receiver got. */
  const subscribe = async (url: string, got: { json: Json }[], events: readonly string[]) => {
    const res = await call('PUT', hook, ada.token, { url, events });
    expect(res.status).toBe(200);
    await until(() => got.some((g) => g.json.verification_token), 'verification token');
    const token = got.find((g) => g.json.verification_token)!.json.verification_token as string;
    expect((await call('POST', `${hook}/verify`, ada.token, { token })).body.webhook).toMatchObject(
      { verified: true },
    );
    return token;
  };
  return {
    app,
    store,
    ws,
    call,
    ada,
    bot,
    a,
    settled,
    share,
    shared,
    tree: () => a.doc(shared.treeDoc),
    hook,
    subscribe,
  };
}

describe('integration webhooks', () => {
  it('are verified with the token sent to them, which signs every event', async () => {
    const w = await world();
    const r = await receiver();
    // Only owners and admins, and only web addresses.
    expect(
      (await w.call('PUT', w.hook, w.ada.token, { url: 'ftp://x', events: ['page.created'] }))
        .status,
    ).toBe(400);
    expect(
      (await w.call('PUT', w.hook, w.ada.token, { url: r.url, events: ['page.nope'] })).status,
    ).toBe(400);
    expect(
      (await w.call('PUT', w.hook, w.ada.token, { url: r.url, events: ['page.created'] })).status,
    ).toBe(200);
    await until(() => r.got.length === 1, 'verification request');
    const token = r.got[0]!.json.verification_token as string;
    expect(token).toMatch(/^secret_/);
    // Unverified: nothing is sent, and a wrong token doesn't turn it on.
    createPage(w.tree(), { title: 'Before', parentId: ROBOTS });
    await w.settled();
    await settle();
    expect(r.events()).toEqual([]);
    expect(
      (await w.call('POST', `${w.hook}/verify`, w.ada.token, { token: 'secret_x' })).status,
    ).toBe(400);
    expect(
      (await w.call('POST', `${w.hook}/verify`, w.ada.token, { token })).body.webhook,
    ).toMatchObject({ verified: true, events: ['page.created'] });
    // Settings show it (never the token).
    const listed = (await w.call('GET', `/api/workspaces/${w.ws}/integrations`, w.ada.token)).body
      .integrations[0];
    expect(listed.webhook).toMatchObject({ url: r.url, verified: true, paused: false });
    expect(JSON.stringify(listed)).not.toContain(token);

    const id = createPage(w.tree(), { title: 'Gripper', parentId: ROBOTS });
    await w.settled();
    await until(() => r.events().length === 1, 'page.created');
    const { body, headers, json } = r.got.at(-1)!;
    expect(json).toMatchObject({
      type: 'page.created',
      entity: { id, type: 'page' },
      workspace_id: w.ws,
      workspace_name: 'Lab',
      integration_id: w.bot.id,
      subscription_id: w.bot.id,
      attempt_number: 1,
      authors: [{ id: w.ada.id, type: 'person' }],
      data: { parent: { id: ROBOTS, type: 'page' } },
    });
    expect(Date.parse(json.timestamp)).toBeGreaterThan(Date.now() - 60_000);
    // Notion's documented check: HMAC-SHA256 of the raw body with the verification token.
    const calculated = `sha256=${createHmac('sha256', token).update(body).digest('hex')}`;
    const received = String(headers['x-notion-signature']);
    expect(
      received.length === calculated.length &&
        timingSafeEqual(Buffer.from(received), Buffer.from(calculated)),
    ).toBe(true);
    // A new URL needs verifying again.
    const r2 = await receiver();
    await w.call('PUT', w.hook, w.ada.token, { url: r2.url, events: ['page.created'] });
    await until(() => r2.got.length === 1, 'second verification');
    expect(r2.got[0]!.json.verification_token).not.toBe(token);
    createPage(w.tree(), { title: 'Wrist', parentId: ROBOTS });
    await w.settled();
    await settle();
    expect(r.events()).toHaveLength(1);
    expect(r2.events()).toHaveLength(0);
  });

  it('each event fires once for its change, and never for pages it can’t read', async () => {
    const w = await world();
    const r = await receiver();
    await w.subscribe(r.url, r.got, WEBHOOK_EVENTS);
    const tree = w.tree();
    const count = (type: string, id: string) =>
      r.events().filter((e) => e.type === type && e.entity.id === id).length;
    const step = async (type: string, id: string, n = 1) => {
      await w.settled();
      await until(() => count(type, id) >= n, `${type} for ${id}`);
    };

    // Pages in its trees.
    const gripper = createPage(tree, { title: 'Gripper', parentId: ROBOTS });
    await step('page.created', gripper);
    setPageTitle(tree, gripper, 'Gripper v2');
    await step('page.properties_updated', gripper);
    expect(r.events().find((e) => e.type === 'page.properties_updated')!.data).toMatchObject({
      parent: { id: ROBOTS, type: 'page' },
      updated_properties: ['title'],
    });
    // Two edits within the minute: one event.
    w.a.doc(gripper).getText('t').insert(0, 'two fingers');
    await w.settled();
    await settle(100);
    w.a.doc(gripper).getText('t').insert(0, 'servo, ');
    await step('page.content_updated', gripper);
    setPageOptions(tree, gripper, { locked: true });
    await step('page.locked', gripper);
    setPageOptions(tree, gripper, { locked: false });
    await step('page.unlocked', gripper);
    movePage(tree, gripper, { parentId: ARM });
    await step('page.moved', gripper);
    trashPage(tree, gripper);
    await step('page.deleted', gripper);
    restorePage(tree, gripper);
    await step('page.undeleted', gripper);
    const db = createPage(tree, { title: 'Motors', parentId: ROBOTS, kind: 'database' });
    await step('database.created', db);

    // Rows and the schema of its database.
    const parts = w.a.doc(PARTS);
    const row = addRow(parts, { actor: w.ada.id, title: 'Servo' });
    await step('page.created', row);
    expect(r.events().find((e) => e.entity.id === row)!.data.parent).toEqual({
      id: PARTS,
      type: 'database',
    });
    const stock = addProperty(parts, { name: 'Stock', type: 'number' });
    await step('database.schema_updated', PARTS);
    setCell(parts, row, stock, 4, w.ada.id);
    await step('page.properties_updated', row);
    expect(
      r.events().find((e) => e.type === 'page.properties_updated' && e.entity.id === row)!.data
        .updated_properties,
    ).toEqual([stock]);
    trashRow(parts, row);
    await step('page.deleted', row);

    // Comments on its pages.
    const comments = w.a.doc(commentsDocId(ARM));
    const thread = createThread(comments, {
      anchor: { kind: 'page' },
      author: w.ada.id,
      body: 'Hi',
    });
    await w.settled();
    const commentId = readThreads(comments)[0]!.comments[0]!.id;
    await step('comment.created', commentId);
    expect(r.events().find((e) => e.type === 'comment.created')!.data).toMatchObject({
      page_id: ARM,
      parent: { id: ARM, type: 'page' },
    });
    editComment(comments, thread, commentId, 'Hi again');
    await step('comment.updated', commentId);
    deleteComment(comments, thread, commentId);
    await step('comment.deleted', commentId);

    // Nothing from pages it can't read.
    const hidden = createPage(w.a.doc('workspace'), { title: 'Hidden', parentId: SECRETS });
    w.a.doc(SECRETS).getText('t').insert(0, 'hush');
    setPageTitle(w.a.doc('workspace'), SECRETS, 'Secrets!');
    await w.settled();
    await settle(1000);
    expect(r.events().filter((e) => [hidden, SECRETS].includes(e.entity.id))).toEqual([]);

    // Each once.
    const seen = new Map<string, number>();
    for (const e of r.events()) {
      const key = `${e.type}:${e.entity.id}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
    expect(seen.size).toBe(16);

    // Access is checked when sending: content changed, then the page unshared within the
    // minute it waits, is never sent.
    w.a.doc(ARM).getText('t').insert(0, 'late ');
    await w.settled();
    await settle(150);
    await w.share(null);
    await settle(1000);
    expect(count('page.content_updated', ARM)).toBe(0);
  });

  it('only the events asked for; paused after 3 days of failures, and the maker told', async () => {
    const w = await world();
    const r = await receiver();
    await w.subscribe(r.url, r.got, ['page.created']);
    const tree = w.tree();
    const first = createPage(tree, { title: 'One', parentId: ROBOTS });
    setPageTitle(tree, first, 'One!');
    await w.settled();
    await until(() => r.events().length === 1, 'page.created');
    await settle();
    expect(r.events().map((e) => e.type)).toEqual(['page.created']);

    // Failing: retried, then counted as failing (not paused yet).
    r.control.status = 500;
    createPage(tree, { title: 'Two', parentId: ROBOTS });
    await w.settled();
    await until(() => r.events().length === 9, 'eight attempts');
    expect(
      r
        .events()
        .slice(1)
        .map((e) => e.attempt_number),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await until(
      async () => (await w.store.integrationWebhooks.get(w.ws, w.bot.id))!.failingSince !== null,
      'failing',
    );
    expect((await w.store.integrationWebhooks.get(w.ws, w.bot.id))!.pausedAt).toBeNull();

    // Three days of that: paused, and Ada hears of it.
    await w.store.pool.query(
      `UPDATE integration_webhooks SET failing_since = now() - interval '4 days'`,
    );
    r.control.status = 410;
    createPage(tree, { title: 'Three', parentId: ROBOTS });
    await w.settled();
    await until(
      async () => (await w.store.integrationWebhooks.get(w.ws, w.bot.id))!.pausedAt !== null,
      'paused',
    );
    const inbox = (await w.call('GET', `/api/workspaces/${w.ws}/notifications`, w.ada.token)).body;
    expect(inbox.notifications[0]).toMatchObject({
      kind: 'automation',
      title: 'Lab bot',
      text: expect.stringContaining('Webhook paused'),
    });
    const listed = (await w.call('GET', `/api/workspaces/${w.ws}/integrations`, w.ada.token)).body
      .integrations[0];
    expect(listed.webhook).toMatchObject({ paused: true, lastError: 'HTTP 410' });

    // Paused: nothing sent. Resumed: changes from then on.
    const before = r.events().length;
    createPage(tree, { title: 'Four', parentId: ROBOTS });
    await w.settled();
    await settle();
    expect(r.events()).toHaveLength(before);
    r.control.status = 200;
    expect((await w.call('POST', `${w.hook}/resume`, w.ada.token)).body.webhook).toMatchObject({
      paused: false,
      failingSince: null,
    });
    const five = createPage(tree, { title: 'Five', parentId: ROBOTS });
    await w.settled();
    await until(() => r.events().some((e) => e.entity.id === five), 'after resuming');
    expect(r.events()).toHaveLength(before + 1);

    // Deleted: nothing more.
    expect((await w.call('DELETE', w.hook, w.ada.token)).status).toBe(200);
    createPage(tree, { title: 'Six', parentId: ROBOTS });
    await w.settled();
    await settle();
    expect(r.events()).toHaveLength(before + 1);
  });
});
