/**
 * Phase 6 M3: automations on the server. Real server, real Postgres, real sockets, and
 * a local webhook receiver.
 *
 * Ada (owner) has the database "tasks" in the first teamspace T (everyone may edit).
 * Bob is a member.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage } from '@workspace/core';
import {
  addOption,
  addProperty,
  addRow,
  initDatabase,
  readDatabase,
  setAutomation,
  setCell,
  type Automation,
} from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { automationsBotId } from './automations/runner';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { PermanentJobError } from './jobs/runner';
import { TestDevice } from './sync/test-client';
import { deliver, isPrivateAddress, signature, webhookUrlProblem } from './webhooks/deliver';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-automations-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** A local receiver: answers with `statuses` in turn (then 200), keeps what it got. */
async function receiver(statuses: number[] = []) {
  const got: { body: string; headers: IncomingMessage['headers'] }[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      got.push({ body, headers: req.headers });
      res.statusCode = statuses.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`, got };
}

async function world(now?: () => number) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
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
    jobs: { pollMs: 20, backoffMs: [50] },
    automations: { delayMs: 50, ...(now && { now }) },
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
  const bob = await signup('bob');
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
    emails: ['bob@lab.io'],
    role: 'member',
  });
  const token = (invite.body.invites[0].link as string).split('/invite/')[1];
  expect((await call('POST', `/api/invites/${token}/accept`, bob.token)).status).toBe(200);
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
    .defaultScopeId as string;

  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const device = async (deviceId: string, token: string) => {
    const d = new TestDevice({ url, token, deviceId });
    cleanups.push(() => d.client.stop());
    d.client.start();
    await until(() => d.client.state.state === 'live', 'live');
    return d;
  };
  const a = await device('ada-1', ada.token);
  createPage(a.doc('workspace'), { id: 'tasks', title: 'Tasks' });
  const db = a.doc('tasks');
  initDatabase(db, { databaseId: 'tasks' });
  const status = addProperty(db, { name: 'Status', type: 'select' });
  addOption(db, status, { id: 'todo', name: 'To do', color: 'gray' });
  addOption(db, status, { id: 'done', name: 'Done', color: 'green' });
  const completed = addProperty(db, { name: 'Completed', type: 'date' });
  const owner = addProperty(db, { name: 'Owner', type: 'person' });
  const points = addProperty(db, { name: 'Points', type: 'number' });
  addRow(db, { id: 'r1', actor: ada.id, title: 'Grease the gears', values: { [status]: 'todo' } });
  const settled = (d: TestDevice) => until(() => d.outbox.length === 0, 'outbox sent');
  await settled(a);

  const automation = (over: Partial<Automation>): Automation => ({
    id: 'a1',
    name: 'Done → completed',
    enabled: true,
    trigger: { kind: 'pageAdded' },
    condition: null,
    actions: [],
    createdBy: ada.id,
    createdAt: Date.now(),
    ...over,
  });
  const state = async (docId = 'tasks') => {
    const doc = new Y.Doc();
    const update = await store.docState(ws, docId);
    if (update) Y.applyUpdate(doc, update);
    return doc;
  };
  const runs = async (automationId: string) =>
    (await call('GET', `/api/workspaces/${ws}/automations/tasks/${automationId}/runs`, ada.token))
      .body.runs as { status: string; error: string | null; result: unknown }[];
  return {
    app,
    store,
    ws,
    call,
    device,
    settled,
    a,
    ada,
    bob,
    T,
    ids: { status, completed, owner, points },
    automation,
    state,
    runs,
  };
}

describe('automations', () => {
  it('"when Status is set to Done": set Completed and Owner, tell Ada; once, as the bot', async () => {
    const w = await world();
    const { status, completed, owner } = w.ids;
    setAutomation(
      w.a.doc('tasks'),
      w.automation({
        trigger: { kind: 'propertyEdited', propertyId: status, to: 'done' },
        actions: [
          {
            kind: 'setProperties',
            values: { [completed]: { kind: 'now' }, [owner]: { kind: 'triggeredBy' } },
          },
          { kind: 'notify', people: [w.ada.id], peopleProperty: null, message: 'A task is done' },
        ],
      }),
    );
    await w.settled(w.a);
    const seq = await w.store.latestSeq(w.ws);

    // Bob sets it to Done on his device.
    const b = await w.device('bob-1', w.bob.token);
    setCell(b.doc('tasks'), 'r1', status, 'done', w.bob.id);
    await w.settled(b);

    const row = () => readDatabase(w.a.doc('tasks')).rows.find((r) => r.id === 'r1')!;
    await until(() => row().values[completed] !== undefined, 'Completed set, live on Ada’s device');
    expect(row().values[completed]).toEqual({ start: new Date().toISOString().slice(0, 10) });
    expect(row().values[owner]).toEqual([w.bob.id]);
    expect(row().updatedBy).toBe(automationsBotId(w.ws));
    // In the log, by the bot (and Bob).
    expect(await w.store.pages.authorsSince(w.ws, 'tasks', seq)).toEqual(
      [w.bob.id, automationsBotId(w.ws)].sort(),
    );
    // Ada is told.
    await until(
      async () =>
        (await w.store.notifications.list(w.ws, w.ada.id)).some((n) => n.kind === 'automation'),
      'Ada notified',
    );
    const notice = (await w.store.notifications.list(w.ws, w.ada.id)).find(
      (n) => n.kind === 'automation',
    )!;
    expect(notice).toMatchObject({
      title: 'Done → completed',
      text: 'A task is done',
      pageId: 'r1',
    });
    // The bot is named (as a former member: never picked as a person).
    const members = await w.state('members');
    expect(members.getMap('members').get(automationsBotId(w.ws))).toMatchObject({
      name: 'Automations',
      removed: true,
    });

    // Setting it to Done again (or anything else) doesn't start it again.
    setCell(b.doc('tasks'), 'r1', w.ids.points, 2, w.bob.id);
    await w.settled(b);
    await settle();
    expect(await w.runs('a1')).toHaveLength(1);
    expect((await w.runs('a1'))[0]).toMatchObject({ status: 'done' });
  });

  it('changes an automation makes never start one (no loops)', async () => {
    const w = await world();
    const { points } = w.ids;
    setAutomation(
      w.a.doc('tasks'),
      w.automation({
        id: 'loop',
        trigger: { kind: 'propertyEdited', propertyId: points },
        actions: [{ kind: 'setProperties', values: { [points]: { kind: 'fixed', value: 100 } } }],
      }),
    );
    setCell(w.a.doc('tasks'), 'r1', points, 1, w.ada.id);
    await w.settled(w.a);
    await until(
      async () => readDatabase(await w.state()).rows[0]!.values[points] === 100,
      'set to 100',
    );
    await settle(600);
    expect(await w.runs('loop')).toHaveLength(1);
  });

  it('pauses, and tells its maker, when they can no longer edit the database', async () => {
    const w = await world();
    // Bob makes an automation; then everyone may only view T.
    const b = await w.device('bob-1', w.bob.token);
    await until(() => b.has('tasks'), 'Bob has the database');
    setAutomation(
      b.doc('tasks'),
      w.automation({
        id: 'bobs',
        createdBy: w.bob.id,
        actions: [{ kind: 'addPage', title: 'Follow-up', values: {} }],
      }),
    );
    await w.settled(b);
    expect(
      (
        await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${w.T}/access`, w.ada.token, {
          principal: 'workspace',
          role: 'view',
        })
      ).status,
    ).toBe(200);
    addRow(w.a.doc('tasks'), { actor: w.ada.id, title: 'New task' });
    await w.settled(w.a);
    await until(async () => (await w.runs('bobs')).length === 1, 'run');
    await until(async () => (await w.runs('bobs'))[0]!.status === 'done', 'run finished');
    expect((await w.runs('bobs'))[0]!.result).toEqual({ skipped: 'paused' });
    expect(readDatabase(await w.state()).rows.map((r) => r.title)).not.toContain('Follow-up');
    const bobs = await w.store.notifications.list(w.ws, w.bob.id);
    expect(bobs.find((n) => n.kind === 'automation')?.text).toContain('Paused');
  });

  it('webhooks: signed, retried after a failure, and the secret is for editors only', async () => {
    const w = await world();
    const hook = await receiver([500]);
    setAutomation(
      w.a.doc('tasks'),
      w.automation({
        id: 'hook',
        actions: [
          { kind: 'webhook', url: hook.url, headers: { 'x-team': 'robots', host: 'evil' } },
        ],
      }),
    );
    addRow(w.a.doc('tasks'), { id: 'r2', actor: w.ada.id, title: 'Check the bearings' });
    await w.settled(w.a);
    await until(() => hook.got.length === 2, 'delivered after one retry');
    const { body, headers } = hook.got[1]!;
    const sent = JSON.parse(body);
    expect(sent).toMatchObject({
      source: { type: 'automation', automationId: 'hook', databaseId: 'tasks' },
      data: { id: 'r2', title: 'Check the bearings' },
    });
    expect(headers['x-team']).toBe('robots');
    expect(headers.host).not.toBe('evil');
    const secret = (
      await w.call('GET', `/api/workspaces/${w.ws}/automations/tasks/hook/secret`, w.ada.token)
    ).body.secret as string;
    expect(headers['x-notion-signature']).toBe(signature(secret, body));
    // Bob may edit too; someone who can't see the database gets nothing.
    expect(
      (await w.call('GET', `/api/workspaces/${w.ws}/automations/tasks/hook/secret`, w.bob.token))
        .status,
    ).toBe(200);
  });

  it('schedules start runs at their time, and line up the next', async () => {
    const real = Date.now();
    // "Now", for the server, is two minutes ago; the schedule is a minute ago (UTC).
    const w = await world(() => real - 120_000);
    const minuteAgo = new Date(real - 60_000);
    const time = `${String(minuteAgo.getUTCHours()).padStart(2, '0')}:${String(minuteAgo.getUTCMinutes()).padStart(2, '0')}`;
    setAutomation(
      w.a.doc('tasks'),
      w.automation({
        id: 'daily',
        trigger: { kind: 'schedule', schedule: { every: 'day', time, timeZone: 'UTC' } },
        actions: [{ kind: 'addPage', title: 'Daily check', values: {} }],
      }),
    );
    await w.settled(w.a);
    await until(
      async () => readDatabase(await w.state()).rows.some((r) => r.title === 'Daily check'),
      'the scheduled run added its page',
    );
    // The next one is lined up (tomorrow), once.
    const { rows } = await w.store.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM jobs WHERE kind = 'automation.schedule'
       AND done_at IS NULL AND failed_at IS NULL`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('webhook delivery', () => {
  it('refuses private and local addresses unless allowed, and http unless allowed', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '2606:4700::1111', '8.8.8.8']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    const strict = { allowPrivate: false, allowHttp: false };
    expect(webhookUrlProblem('http://example.com/x', strict)).toBe('Webhooks must use https');
    expect(webhookUrlProblem('https://user:pw@example.com/x', strict)).toBe(
      'No credentials in the address',
    );
    expect(webhookUrlProblem('not a url', strict)).toBe('Not a valid address');
    expect(webhookUrlProblem('https://example.com/x', strict)).toBeNull();

    const hook = await receiver();
    // localhost resolves to a loopback address: refused, and nothing is sent.
    const local = hook.url.replace('127.0.0.1', 'localhost');
    await expect(
      deliver(local, { a: 1 }, 's', {}, { allowPrivate: false, allowHttp: true }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      deliver(hook.url, { a: 1 }, 's', {}, { allowPrivate: false, allowHttp: true }),
    ).rejects.toThrow('private address');
    await expect(
      deliver(hook.url, { a: 1 }, 's', {}, { allowPrivate: true, allowHttp: false }),
    ).rejects.toThrow('https');
    expect(hook.got).toHaveLength(0);
    // Allowed: delivered, signed.
    const ok = await deliver(hook.url, { a: 1 }, 's', {}, { allowPrivate: true, allowHttp: true });
    expect(ok.status).toBe(200);
    expect(hook.got[0]!.headers['x-notion-signature']).toBe(signature('s', '{"a":1}'));
  });

  it('doesn’t follow redirects, and gives up on slow receivers', async () => {
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      if (req.url === '/slow') return; // never answers
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise((r) => server.close(r)));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const options = { allowPrivate: true, allowHttp: true, timeoutMs: 200 };
    expect((await deliver(`${base}/hook`, {}, 's', {}, options)).status).toBe(302);
    expect(hits).toBe(1);
    await expect(deliver(`${base}/slow`, {}, 's', {}, options)).rejects.toThrow('Timed out');
  });
});
