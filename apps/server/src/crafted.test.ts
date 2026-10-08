/**
 * Phase 5 exit check, crafted clients: raw sockets that skip the app and the sync client,
 * sending whatever they like. Every attempt to reach what the person may not is denied,
 * and nothing they shouldn't see arrives in their stream.
 *
 * Lab: Ada (owner) has "plan" in the first teamspace (everyone edits) and "diary" in her
 * private pages. Mo is a member; Gus a guest with access to nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MEMBERS_DOC_ID, createPage, createThread, readThreads } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import {
  PROTOCOL_VERSION,
  decodeAwareness,
  decodeServer,
  encodeAwareness,
  encodeClient,
  type ClientMessage,
  type ServerMessage,
} from '@workspace/sync';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-crafted-'));
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
const settle = () => new Promise((r) => setTimeout(r, 300));

/** An update that writes `text` into a fresh doc's text. */
function update(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

/** A socket speaking the protocol directly, keeping everything the server sends. */
class Raw {
  readonly received: ServerMessage[] = [];
  closed: number | null = null;
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) =>
      this.received.push(decodeServer(new Uint8Array(data as Buffer))),
    );
    socket.on('close', (code) => (this.closed = code));
  }

  static async open(
    url: string,
    token: string,
    hello: { mode: 'replica' | 'partial'; known?: string[] },
  ) {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    cleanups.push(() => socket.close());
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    const raw = new Raw(socket);
    raw.send({
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      mode: hello.mode,
      cursor: 0,
      deviceId: `raw-${Math.random()}`,
      known: hello.known ?? [],
    });
    await until(() => raw.received.some((m) => m.type === 'access'), 'access');
    if (hello.mode === 'replica') {
      await until(() => raw.received.some((m) => m.type === 'caught-up'), 'caught up');
    }
    return raw;
  }

  send(message: ClientMessage) {
    this.socket.send(encodeClient(message));
  }

  /** Every doc anything the server sent was about. */
  docs(): Set<string> {
    const docs = new Set<string>();
    for (const m of this.received) {
      if (m.type === 'updates' || m.type === 'backfill') for (const i of m.items) docs.add(i.docId);
      if (m.type === 'state' || m.type === 'awareness') docs.add(m.docId);
    }
    return docs;
  }

  /** Everything the server sent, as text (to look for content). */
  text(): string {
    return this.received
      .map((m) => {
        if (m.type === 'updates' || m.type === 'backfill') {
          return m.items.map((i) => Buffer.from(i.update).toString('latin1')).join('');
        }
        if (m.type === 'state' || m.type === 'awareness')
          return Buffer.from(m.update).toString('latin1');
        return JSON.stringify(m);
      })
      .join('\n');
  }

  acks() {
    return this.received.flatMap((m) => (m.type === 'ack' ? m.items : []));
  }
}

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  const app = buildServer({
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      LOG_LEVEL: 'silent',
      FILES_DIR: dir,
      SIGNUP: 'open',
      PUBLIC_URL: 'http://app.test',
    }),
    store,
    files: new FsStorage(dir),
    mailer: null,
    indexDelayMs: 0,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
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
  const [ada, mo, gus] = [await signup('ada'), await signup('mo'), await signup('gus')];
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  for (const [person, email, role] of [
    [mo, 'mo@lab.io', 'member'],
    [gus, 'gus@lab.io', 'guest'],
  ] as const) {
    const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [email],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await call('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  }
  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const a = new TestDevice({ url, token: ada.token, deviceId: 'ada-1' });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  const settled = () => until(() => a.outbox.length === 0, 'outbox sent');
  const scopes = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body as {
    defaultScopeId: string;
  };
  const T = scopes.defaultScopeId;
  createPage(a.doc('workspace'), { id: 'plan', title: 'Gear plan' });
  a.doc('plan').getText('t').insert(0, 'plan body');
  await settled();
  const P = (await call('POST', `/api/workspaces/${ws}/private`, ada.token)).body.scope as {
    id: string;
    treeDoc: string;
  };
  a.hint = P.id;
  createPage(a.doc(P.treeDoc), { id: 'diary', title: 'Dear diary' });
  a.doc('diary').getText('t').insert(0, 'my secret');
  await settled();
  a.hint = null;
  return { app, store, ws, url, call, a, ada, mo, gus, T, P, settled };
}

describe('crafted clients', () => {
  it('a guest with access to nothing: claims, opens, pushes and watches are all refused', async () => {
    const w = await world();
    // A replica claiming to hold Ada's scopes already.
    const gus = await Raw.open(w.url, w.gus.token, { mode: 'replica', known: [w.P.id, w.T] });
    // A partial client asking for the docs by name.
    const probe = await Raw.open(w.url, w.gus.token, { mode: 'partial' });
    for (const docId of ['diary', 'plan', 'workspace', w.P.treeDoc]) {
      probe.send({ type: 'open', docId });
    }
    // Pushes: to Ada's page, to a new doc placed in her private scope, to the members doc.
    gus.send({
      type: 'push',
      items: [
        { localId: 1, docId: 'diary', update: update('pwned') },
        { localId: 2, docId: 'planted', update: update('planted'), scope: w.P.id },
        { localId: 3, docId: MEMBERS_DOC_ID, update: update('forged member') },
        { localId: 4, docId: 'plan', update: update('pwned') },
      ],
    });
    // Watching Ada's page, and sending a cursor there as Ada.
    const ada = new TestDevice({ url: w.url, token: w.ada.token, deviceId: 'ada-2' });
    cleanups.push(() => ada.client.stop());
    ada.client.start();
    await until(() => ada.client.state.state === 'live', 'Ada live');
    ada.client.presence.watch('diary');
    gus.send({ type: 'watch', docId: 'diary' });
    const forged = JSON.stringify({ user: { id: w.ada.id, name: 'Ada' }, cursor: 1 });
    gus.send({
      type: 'awareness',
      docId: 'diary',
      update: encodeAwareness([{ clientID: 99, clock: 1, state: forged }]),
    });

    await until(() => gus.acks().length === 4, 'acks');
    expect(gus.acks().map((i) => [i.localId, i.denied, i.seq])).toEqual([
      [1, true, 0],
      [2, true, 0],
      [3, true, 0],
      [4, true, 0],
    ]);
    await until(
      () => probe.received.filter((m) => m.type === 'refused').length === 4,
      'opens refused',
    );
    await settle();
    // Nothing of Ada's reached him: no docs but the members doc everyone reads, and the
    // server's (empty) copy of the doc he tried to plant, after the denial.
    expect(
      [...gus.docs(), ...probe.docs()].filter((d) => d !== MEMBERS_DOC_ID && d !== 'planted'),
    ).toEqual([]);
    for (const m of gus.received) {
      if (m.type !== 'state' || m.docId !== 'planted') continue;
      const copy = new Y.Doc();
      Y.applyUpdate(copy, m.update);
      expect(copy.getText('t').toString()).toBe('');
    }
    for (const secret of ['my secret', 'plan body', 'Dear diary', 'Gear plan']) {
      expect(gus.text()).not.toContain(secret);
      expect(probe.text()).not.toContain(secret);
    }
    expect(gus.received.find((m) => m.type === 'access')).toEqual({ type: 'access', scopes: [] });
    // His cursor went nowhere, and nothing he pushed was stored.
    expect(ada.presence).toEqual([]);
    for (const docId of ['diary', 'plan', 'planted', MEMBERS_DOC_ID]) {
      const state = await w.store.docState(w.ws, docId);
      expect(state ? Buffer.from(state).toString('latin1') : '').not.toMatch(
        /pwned|planted|forged/,
      );
    }
  });

  it('a member: their own docs only, as themselves', async () => {
    const w = await world();
    const mo = await Raw.open(w.url, w.mo.token, { mode: 'partial' });
    mo.send({ type: 'open', docId: 'diary' });
    mo.send({ type: 'open', docId: 'plan' });
    await until(
      () =>
        mo.received.some((m) => m.type === 'refused') &&
        mo.received.some((m) => m.type === 'state'),
      'open answered',
    );
    expect(mo.received.filter((m) => m.type === 'refused')).toEqual([
      { type: 'refused', docId: 'diary' },
    ]);
    expect(mo.text()).toContain('plan body');
    expect(mo.text()).not.toContain('my secret');

    // A thread written as Ada; a new doc hinted into Ada's private pages; the members doc:
    // denied. A doc in the teamspace (where Mo may edit) is stored.
    const forgedThread = new Y.Doc();
    createThread(forgedThread, { anchor: { kind: 'page' }, author: w.ada.id, body: 'I quit' });
    mo.send({
      type: 'push',
      items: [
        { localId: 1, docId: 'comments:plan', update: Y.encodeStateAsUpdate(forgedThread) },
        { localId: 2, docId: 'mo-page', update: update('hidden'), scope: w.P.id },
        { localId: 3, docId: MEMBERS_DOC_ID, update: update('admin') },
        { localId: 4, docId: 'mo-notes', update: update('fine'), scope: w.T },
      ],
    });
    await until(() => mo.acks().length === 4, 'acks');
    expect(mo.acks().map((i) => [i.localId, i.denied])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, false],
    ]);
    const comments = new Y.Doc();
    const state = await w.store.docState(w.ws, 'comments:plan');
    if (state) Y.applyUpdate(comments, state);
    expect(readThreads(comments)).toEqual([]);
    expect(await w.store.scopes.placementOf(w.ws, 'mo-page')).not.toBe(w.P.id);

    // His cursor, sent as Ada, reaches Ada as Mo.
    const ada = new TestDevice({ url: w.url, token: w.ada.token, deviceId: 'ada-2' });
    cleanups.push(() => ada.client.stop());
    ada.client.start();
    await until(() => ada.client.state.state === 'live', 'Ada live');
    ada.client.presence.watch('plan');
    await settle();
    mo.send({ type: 'watch', docId: 'plan' });
    mo.send({
      type: 'awareness',
      docId: 'plan',
      update: encodeAwareness([
        { clientID: 5, clock: 1, state: JSON.stringify({ user: { id: w.ada.id, name: 'Ada' } }) },
      ]),
    });
    await until(() => ada.presence.length > 0, 'presence');
    expect(JSON.parse(decodeAwareness(ada.presence[0]!.update)[0]!.state).user.id).toBe(w.mo.id);
  });

  it('the REST API answers outsiders as if the page didn’t exist', async () => {
    const w = await world();
    const page = `/api/workspaces/${w.ws}/pages/diary`;
    for (const [method, url, body] of [
      ['GET', `${page}/backlinks`],
      ['GET', `${page}/publish`],
      ['PUT', `${page}/publish`, { slug: 'stolen-diary' }],
      ['GET', `${page}/analytics`],
      ['POST', `${page}/views`],
      ['PUT', `${page}/follow`, { following: true }],
      ['GET', `/api/workspaces/${w.ws}/docs/diary/versions`],
      ['POST', `/api/workspaces/${w.ws}/docs/diary/versions`, { reason: 'restore' }],
      ['POST', `/api/workspaces/${w.ws}/pages/diary/share`, { scope: w.P.id }],
    ] as [string, string, object?][]) {
      for (const who of [w.mo, w.gus]) {
        const res = await w.call(method, url, who.token, body);
        expect([403, 404], `${method} ${url}`).toContain(res.status);
      }
    }
    const search = await w.call('GET', `/api/workspaces/${w.ws}/search?q=secret`, w.mo.token);
    expect(JSON.stringify(search.body)).not.toContain('diary');
    expect((await w.app.inject({ method: 'GET', url: '/p/stolen-diary' })).statusCode).toBe(404);
  });
});
