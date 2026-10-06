import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { CloseCode, PROTOCOL_VERSION, encodeClient } from '@workspace/sync';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import type { SyncOptions } from './sync/endpoint';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-sync-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean, what: string, timeoutMs = 10_000) => {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A listening server on a fresh database, with a signed-in user and a workspace. */
async function setup(sync: SyncOptions = {}) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const app: FastifyInstance = buildServer({ config, store, files: new FsStorage(dir), sync });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await store.close();
  };
  cleanups.push(close);

  const signup = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email, name: email, password: 'long password', client: 'desktop' },
    });
    return { token: res.json().token as string, id: res.json().user.id as string };
  };
  const ada = await signup('ada@lab.io');
  const workspace = await store.createWorkspace('Lab', ada.id);
  const url = (workspaceId = workspace.id) => `ws://127.0.0.1:${port}/api/sync/${workspaceId}`;
  const devices: TestDevice[] = [];
  const device = (deviceId: string, token = ada.token, workspaceId = workspace.id) => {
    const d = new TestDevice({ url: url(workspaceId), token, deviceId });
    devices.push(d);
    cleanups.push(() => d.client.stop());
    return d;
  };
  return { app, store, ada, workspace, url, device, signup, close, port };
}

/** Open a raw socket and resolve with how it closed. */
function closeOf(url: string, headers: Record<string, string> = {}) {
  return new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    ws.on('unexpected-response', (_req, res) =>
      resolve({ code: res.statusCode ?? 0, reason: 'http' }),
    );
    ws.on('error', () => {});
    setTimeout(() => reject(new Error('no close')), 5000);
  });
}

describe('sync endpoint', () => {
  it('checks the session and membership on connect', async () => {
    const s = await setup();
    const bob = await s.signup('bob@lab.io');
    expect(await closeOf(s.url())).toEqual({
      code: CloseCode.unauthenticated,
      reason: 'Sign in again',
    });
    expect((await closeOf(s.url(), { authorization: 'Bearer forged' })).code).toBe(
      CloseCode.unauthenticated,
    );
    expect((await closeOf(s.url(), { authorization: `Bearer ${bob.token}` })).code).toBe(
      CloseCode.forbidden,
    );
    const other = await s.store.createWorkspace('Other', bob.id);
    expect((await closeOf(s.url(other.id), { authorization: `Bearer ${s.ada.token}` })).code).toBe(
      CloseCode.forbidden,
    );
    // Unknown workspaces look the same as other people's.
    expect(
      (
        await closeOf(s.url('00000000-0000-4000-8000-000000000000'), {
          authorization: `Bearer ${s.ada.token}`,
        })
      ).code,
    ).toBe(CloseCode.forbidden);
    // Not a sync URL at all.
    expect((await closeOf(`ws://127.0.0.1:${s.port}/api/sync/nope`)).code).toBe(404);

    // Browsers: the cookie only counts from our own origin.
    const cookie = { cookie: `ws_session=${s.ada.token}` };
    expect((await closeOf(s.url(), cookie)).code).toBe(CloseCode.unauthenticated);
    expect((await closeOf(s.url(), { ...cookie, origin: 'https://evil.test' })).code).toBe(
      CloseCode.unauthenticated,
    );
    const ok = new WebSocket(s.url(), { headers: { ...cookie, origin: 'http://app.test' } });
    await new Promise((resolve) => ok.on('open', resolve));
    ok.send(
      encodeClient({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        mode: 'replica',
        cursor: 0,
        deviceId: 'web',
      }),
    );
    const first = await new Promise<Buffer>((resolve) =>
      ok.once('message', (d) => resolve(d as Buffer)),
    );
    expect(first[0]).toBe(11); // caught-up
    ok.close();
  });

  it('keeps two devices in sync, live and after being offline', async () => {
    const s = await setup();
    const a = s.device('laptop');
    const b = s.device('robot-pc');
    a.client.start();
    b.client.start();
    await until(() => a.client.state.state === 'live' && b.client.state.state === 'live', 'live');

    a.doc('workspace').getMap('m').set('title', 'Arm');
    a.doc('page-1').getText('t').insert(0, 'Joint limits');
    await until(() => b.text('page-1') === 'Joint limits', 'live edit reaches B');
    expect(b.doc('workspace').getMap('m').get('title')).toBe('Arm');

    // B goes offline and both edit the same page.
    b.client.stop();
    b.doc('page-1').getText('t').insert(0, 'B: ');
    a.doc('page-1').getText('t').insert(12, ' (deg)');
    a.doc('page-2').getText('t').insert(0, 'New page');
    await until(() => a.outbox.length === 0, 'A acknowledged');
    b.client.start();
    await until(
      () =>
        b.outbox.length === 0 &&
        a.text('page-1') === b.text('page-1') &&
        b.text('page-2') === 'New page',
      'converged',
    );
    expect(a.text('page-1')).toBe('B: Joint limits (deg)');
    const latest = await s.store.latestSeq(s.workspace.id);
    await until(() => a.cursor === latest && b.cursor === latest, 'cursors at the end');
  });

  it('catches up a large log in batches, and after compaction', async () => {
    const s = await setup();
    // 1200 updates to 3 docs, written straight to the log.
    const source = new Y.Doc();
    const docs = ['workspace', 'p1', 'p2'].map(() => new Y.Doc());
    const updates: { docId: string; data: Uint8Array }[] = [];
    ['workspace', 'p1', 'p2'].forEach((id, i) => {
      docs[i]!.on('update', (u: Uint8Array) => updates.push({ docId: id, data: u }));
    });
    for (let i = 0; i < 1200; i++) docs[i % 3]!.getText('t').insert(0, `${i},`);
    source.destroy();
    for (let i = 0; i < updates.length; i += 200) {
      await s.store.appendUpdates(s.workspace.id, updates.slice(i, i + 200));
    }

    const fresh = s.device('fresh');
    fresh.client.start();
    await until(() => fresh.client.state.state === 'live', 'caught up');
    expect(fresh.cursor).toBe(1200);
    expect(fresh.updatesReceived).toBeGreaterThan(2);
    ['workspace', 'p1', 'p2'].forEach((id, i) =>
      expect(fresh.text(id)).toBe(docs[i]!.getText('t').toString()),
    );

    // Compact p1, then a device that had seen half of it catches up.
    await s.store.compactDoc(s.workspace.id, 'p1');
    const half = s.device('half');
    half.cursor = 600;
    for (const u of updates.slice(0, 600)) Y.applyUpdate(half.doc(u.docId), u.data);
    half.outbox = [];
    half.client.start();
    await until(() => half.client.state.state === 'live', 'half caught up');
    ['workspace', 'p1', 'p2'].forEach((id, i) =>
      expect(half.text(id)).toBe(docs[i]!.getText('t').toString()),
    );
    expect(half.cursor).toBe(await s.store.latestSeq(s.workspace.id));
  });

  it('compacts long logs on a timer and sends the result to connected devices', async () => {
    const s = await setup({ compactThreshold: 5, compactEveryMs: 50 });
    const a = s.device('a');
    const b = s.device('b');
    a.client.start();
    b.client.start();
    await until(() => b.client.state.state === 'live', 'live');
    for (let i = 0; i < 10; i++) a.doc('p').getText('t').insert(0, `${i}`);
    await until(() => b.text('p') === a.text('p') && a.outbox.length === 0, 'synced');
    // The timer merges p's 10 rows into one under a new seq, and wakes the sockets.
    await until(() => b.cursor >= 11 && a.cursor >= 11, 'cursors past the compacted row');
    const { rows } = await s.store.pool.query('SELECT count(*)::int AS n FROM doc_updates');
    expect(rows[0].n).toBe(1);
    expect(b.text('p')).toBe(a.text('p'));

    // A device that never saw any of it gets the merged row.
    const c = s.device('c');
    c.client.start();
    await until(() => c.client.state.state === 'live', 'c live');
    expect(c.text('p')).toBe(a.text('p'));
  });

  it('keeps workspaces apart', async () => {
    const s = await setup();
    const second = await s.store.createWorkspace('Second', s.ada.id);
    const a = s.device('a');
    const other = s.device('other', s.ada.token, second.id);
    a.client.start();
    other.client.start();
    await until(() => other.client.state.state === 'live', 'live');
    a.doc('p').getText('t').insert(0, 'secret');
    await until(() => a.outbox.length === 0, 'stored');
    await new Promise((r) => setTimeout(r, 100));
    expect(other.docs.has('p')).toBe(false);
    expect(await s.store.latestSeq(second.id)).toBe(0);
    expect(await s.store.docState(second.id, 'p')).toBeNull();
  });

  it('closes sockets whose session ends or whose member leaves, and read-only pushes', async () => {
    const s = await setup({ recheckMs: 50 });
    const a = s.device('a');
    a.client.start();
    await until(() => a.client.state.state === 'live', 'live');
    // Syncing counts as using the session: its expiry slides forward.
    await s.store.pool.query(
      `UPDATE sessions SET last_seen_at = now() - interval '1 day', expires_at = now() + interval '1 day'`,
    );
    const slid = async () =>
      (
        await s.store.pool.query(
          `SELECT expires_at > now() + interval '100 days' AS ok FROM sessions`,
        )
      ).rows[0].ok;
    const start = Date.now();
    while (!(await slid()) && Date.now() - start < 5000)
      await new Promise((r) => setTimeout(r, 20));
    expect(await slid()).toBe(true);
    await s.store.accounts.revokeAllSessions(s.ada.id);
    await until(() => a.client.state.state === 'unauthorized', 'signed out');
    expect(a.closes.at(-1)).toEqual({ code: CloseCode.unauthenticated, reason: 'Signed out' });

    const bob = await s.signup('bob@lab.io');
    await s.store.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`,
      [s.workspace.id, bob.id],
    );
    const guest = s.device('guest', bob.token);
    guest.client.start();
    await until(() => guest.client.state.state === 'live', 'guest live');
    guest.doc('p').getText('t').insert(0, 'nope');
    await until(() => guest.client.state.state === 'unauthorized', 'guest refused');
    expect(await s.store.latestSeq(s.workspace.id)).toBe(0);

    await s.store.pool.query(`UPDATE workspace_members SET role = 'member' WHERE user_id = $1`, [
      bob.id,
    ]);
    const member = s.device('member', bob.token);
    member.client.start();
    await until(() => member.client.state.state === 'live', 'member live');
    await s.store.pool.query('DELETE FROM workspace_members WHERE user_id = $1', [bob.id]);
    await until(() => member.client.state.state === 'unauthorized', 'removed');
    expect(member.closes.at(-1)!.code).toBe(CloseCode.forbidden);
  });

  it('drops sockets that stop answering pings', async () => {
    const s = await setup({ heartbeatMs: 50 });
    const ws = new WebSocket(s.url(), {
      headers: { authorization: `Bearer ${s.ada.token}` },
      autoPong: false,
    });
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.on('error', () => {});
    expect(await closed).toBe(1006);
  });

  it('refuses text frames and oversized messages', async () => {
    const s = await setup();
    const open = async () => {
      const ws = new WebSocket(s.url(), { headers: { authorization: `Bearer ${s.ada.token}` } });
      ws.on('error', () => {});
      await new Promise((resolve) => ws.on('open', resolve));
      return {
        ws,
        closed: new Promise<number>((resolve) => ws.on('close', (code) => resolve(code))),
      };
    };
    const text = await open();
    text.ws.send('hello');
    expect(await text.closed).toBe(CloseCode.protocol);
    const big = await open();
    big.ws.send(new Uint8Array(17 * 1024 * 1024));
    expect(await big.closed).toBe(1009);
  });

  it('tells devices to come back when the server shuts down', async () => {
    const s = await setup();
    const a = s.device('a');
    a.client.start();
    await until(() => a.client.state.state === 'live', 'live');
    await s.close();
    await until(() => a.client.state.state !== 'live', 'offline');
    // The first close is the server's goodbye; retries that find nobody listening follow.
    expect(a.closes[0]).toEqual({ code: CloseCode.goingAway, reason: 'Server restarting' });
    a.client.stop();
  });
});
