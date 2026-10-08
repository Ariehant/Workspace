/**
 * Who can read and write what, end to end: real server, real Postgres, real sockets.
 *
 * The workspace "Lab" (made on the web: its first scope is a teamspace everyone edits):
 * - T, the first teamspace: pages "plan" and "spec" (spec is then shared on its own)
 * - P, Ada's private pages: "diary"
 * - V, a teamspace everyone may only view: "notice"
 * - S, the shared "spec": inherits T, and Gus (a guest) may comment
 *
 * People: Ada (owner), Mo (member), Gus (guest), Xo (not in the workspace).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MEMBERS_DOC_ID, createPage, listStubs } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import {
  CloseCode,
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type ServerMessage,
} from '@workspace/sync';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import WebSocket from 'ws';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-access-'));
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
  const [ada, mo, gus, xo] = [
    await signup('ada'),
    await signup('mo'),
    await signup('gus'),
    await signup('xo'),
  ];
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  for (const [person, role] of [
    [mo, 'member'],
    [gus, 'guest'],
  ] as const) {
    const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [`${person === mo ? 'mo' : 'gus'}@lab.io`],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await call('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  }
  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const device = (deviceId: string, token: string) => {
    const d = new TestDevice({ url, token, deviceId });
    cleanups.push(() => d.client.stop());
    return d;
  };
  const live = (d: TestDevice) => until(() => d.client.state.state === 'live', 'live');
  const settled = (d: TestDevice) => until(() => d.outbox.length === 0, 'outbox sent');
  /** A partial client's `open`: the doc's state, or 'refused'. */
  const open = (token: string, docId: string) =>
    new Promise<'refused' | 'state'>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      socket.on('open', () => {
        socket.send(
          encodeClient({
            type: 'hello',
            protocol: PROTOCOL_VERSION,
            mode: 'partial',
            cursor: 0,
            deviceId: 'probe',
            known: [],
          }),
        );
        socket.send(encodeClient({ type: 'open', docId }));
      });
      socket.on('message', (data) => {
        const message: ServerMessage = decodeServer(new Uint8Array(data as Buffer));
        if (message.type === 'refused' || message.type === 'state') {
          socket.close();
          resolve(message.type === 'refused' ? 'refused' : 'state');
        }
      });
      socket.on('error', reject);
    });

  // Ada builds the workspace.
  const a = device('ada-1', ada.token);
  a.client.start();
  await live(a);
  const scopes = async (token: string) =>
    (await call('GET', `/api/workspaces/${ws}/scopes`, token)).body as {
      defaultScopeId: string;
      scopes: { id: string; kind: string; treeDoc: string; role: string }[];
    };
  const T = (await scopes(ada.token)).defaultScopeId;
  createPage(a.doc('workspace'), { id: 'plan', title: 'Gear plan' });
  createPage(a.doc('workspace'), { id: 'spec', title: 'Spec sheet' });
  a.doc('plan').getText('t').insert(0, 'plan body');
  a.doc('spec').getText('t').insert(0, 'spec body');
  await settled(a);

  const P = (await call('POST', `/api/workspaces/${ws}/private`, ada.token)).body.scope;
  a.hint = P.id;
  createPage(a.doc(P.treeDoc), { id: 'diary', title: 'Dear diary' });
  a.doc('diary').getText('t').insert(0, 'my secret');
  await settled(a);

  const V = (
    await call('POST', `/api/workspaces/${ws}/teamspaces`, ada.token, {
      name: 'Notices',
      everyone: 'view',
    })
  ).body.scope;
  a.hint = V.id;
  createPage(a.doc(V.treeDoc), { id: 'notice', title: 'Notice board' });
  a.doc('notice').getText('t').insert(0, 'read me');
  await settled(a);

  const shared = await call('POST', `/api/workspaces/${ws}/pages/spec/share`, ada.token, {
    scope: T,
  });
  expect(shared.status).toBe(201);
  const S = shared.body.scope;
  expect(
    (
      await call('PUT', `/api/workspaces/${ws}/scopes/${S.id}/access`, ada.token, {
        principal: `user:${gus.id}`,
        role: 'comment',
      })
    ).status,
  ).toBe(200);
  a.hint = S.id;
  a.doc('comments:spec').getText('t').insert(0, 'first comment');
  await settled(a);
  a.hint = null;

  return {
    app,
    store,
    ws,
    call,
    device,
    live,
    settled,
    open,
    scopes,
    a,
    ada,
    mo,
    gus,
    xo,
    T,
    P,
    V,
    S,
  };
}

describe('access', () => {
  it('reads, writes, search and location follow each person’s roles', async () => {
    const w = await world();
    const { T, P, V, S } = w;
    const readable = {
      ada: [
        'plan',
        'spec',
        'diary',
        'notice',
        'comments:spec',
        'workspace',
        P.treeDoc,
        V.treeDoc,
        S.treeDoc,
      ],
      mo: ['plan', 'spec', 'notice', 'comments:spec', 'workspace', V.treeDoc, S.treeDoc],
      gus: ['spec', 'comments:spec', S.treeDoc],
    };
    const all = [...new Set([...readable.ada])];

    // Sharing moved "spec" out of T's tree: a stub stays in place.
    expect(listStubs(w.a.doc('workspace'))).toEqual([
      expect.objectContaining({ id: 'spec', scope: S.id }),
    ]);

    const mo = w.device('mo-1', w.mo.token);
    const gus = w.device('gus-1', w.gus.token);
    mo.client.start();
    gus.client.start();
    await w.live(mo);
    await w.live(gus);
    for (const [who, device] of [
      ['mo', mo],
      ['gus', gus],
    ] as const) {
      for (const docId of all) {
        expect(device.has(docId), `${who} has ${docId}`).toBe(readable[who].includes(docId));
      }
      // Everyone in the workspace has the members doc.
      expect(device.has(MEMBERS_DOC_ID), `${who} has the members doc`).toBe(true);
      // The same through `open` (the web app).
      for (const docId of all) {
        const token = who === 'mo' ? w.mo.token : w.gus.token;
        expect(await w.open(token, docId), `${who} opens ${docId}`).toBe(
          readable[who].includes(docId) ? 'state' : 'refused',
        );
      }
    }
    expect(mo.text('plan')).toBe('plan body');
    expect(gus.text('spec')).toBe('spec body');
    expect(gus.scopes.map((s) => [s.id, s.role])).toEqual([[S.id, 'comment']]);
    expect(Object.fromEntries(mo.scopes.map((s) => [s.id, s.role]))).toEqual({
      [T]: 'edit',
      [V.id]: 'view',
      [S.id]: 'edit',
    });

    // Writes: what may be written is stored; the rest is undone (server copy) or taken away.
    const state = async (docId: string) => {
      const doc = new (await import('yjs')).Doc();
      const update = await w.store.docState(w.ws, docId);
      if (update) (await import('yjs')).applyUpdate(doc, update);
      return doc.getText('t').toString();
    };
    mo.doc('plan').getText('t').insert(0, 'mo: ');
    mo.doc('notice').getText('t').insert(0, 'mo was here ');
    mo.doc('diary').getText('t').insert(0, 'peek');
    mo.doc('comments:spec').getText('t').insert(0, 'mo comments; ');
    mo.doc(MEMBERS_DOC_ID).getMap('members').set(w.mo.id, { name: 'Mo', role: 'owner' });
    gus.doc('spec').getText('t').insert(0, 'gus edits ');
    gus.doc('comments:spec').getText('t').insert(0, 'gus comments; ');
    gus.doc('plan').getText('t').insert(0, 'gus guesses');
    await w.settled(mo);
    await w.settled(gus);
    await until(() => mo.resets.includes('notice') && gus.resets.includes('spec'), 'undone');
    expect(await state('plan')).toBe('mo: plan body');
    expect(await state('notice')).toBe('read me');
    expect(mo.text('notice')).toBe('read me');
    expect(await state('diary')).toBe('my secret');
    expect(mo.has('diary')).toBe(false);
    expect(await state('spec')).toBe('spec body');
    expect(gus.text('spec')).toBe('spec body');
    expect(await state('comments:spec')).toContain('mo comments; ');
    expect(await state('comments:spec')).toContain('gus comments; ');
    expect(await state('plan')).not.toContain('gus');
    expect(gus.revoked).toContain('plan');
    expect(mo.resets).toContain(MEMBERS_DOC_ID);

    // New docs: placed where the hint says, if the person may edit there; else refused.
    // (The hint is read as the push goes out: one at a time.)
    for (const [hint, docId] of [
      [P.id, 'mo-in-private'],
      [V.id, 'mo-in-notices'],
      [T, 'mo-in-team'],
    ] as const) {
      mo.hint = hint;
      mo.doc(docId).getText('t').insert(0, 'x');
      await w.settled(mo);
    }
    gus.hint = null;
    gus.doc('gus-new').getText('t').insert(0, 'x');
    await w.settled(gus);
    const placed = await w.store.scopes.placements(w.ws);
    expect(placed.get('mo-in-private')).toBeUndefined();
    expect(placed.get('mo-in-notices')).toBeUndefined();
    expect(placed.get('mo-in-team')).toBe(T);
    expect(placed.get('gus-new')).toBeUndefined();
    expect(await w.store.docState(w.ws, 'mo-in-private')).toBeNull();

    // A stub in a tree Mo may edit doesn't open someone else's page.
    createPage(mo.doc('workspace'), { id: 'decoy', title: 'Decoy' });
    mo.doc('workspace')
      .getMap('pages')
      .set('diary', new (await import('yjs')).Map([['scope', T]]));
    await w.settled(mo);
    expect(await w.open(w.mo.token, 'diary')).toBe('refused');
    // A doc nobody wrote yet (a new page) opens empty.
    expect(await w.open(w.gus.token, 'brand-new-page')).toBe('state');

    // Search and location: only what each person may read.
    await w.app.indexer.run(w.ws);
    const search = async (token: string, q: string) =>
      (await w.call('GET', `/api/workspaces/${w.ws}/search?q=${q}`, token)).body.results.map(
        (r: { id: string }) => r.id,
      );
    expect(await search(w.ada.token, 'diary')).toEqual(['diary']);
    expect(await search(w.mo.token, 'diary')).toEqual([]);
    expect(await search(w.mo.token, 'notice')).toEqual(['notice']);
    expect(await search(w.gus.token, 'spec')).toEqual(['spec']);
    expect(await search(w.gus.token, 'gear')).toEqual([]);
    const where = (token: string, id: string) =>
      w.call('GET', `/api/workspaces/${w.ws}/pages/${id}/location`, token);
    expect((await where(w.ada.token, 'diary')).status).toBe(200);
    expect((await where(w.mo.token, 'diary')).status).toBe(404);
    expect((await where(w.gus.token, 'plan')).status).toBe(404);

    // Scope routes: who can see and change what.
    expect((await w.scopes(w.gus.token)).scopes.map((s) => s.id)).toEqual([S.id]);
    const put = (token: string, scopeId: string, principal: string, role: string | null) =>
      w.call('PUT', `/api/workspaces/${w.ws}/scopes/${scopeId}/access`, token, { principal, role });
    expect((await put(w.mo.token, V.id, `user:${w.mo.id}`, 'full')).status).toBe(403);
    expect((await put(w.gus.token, S.id, `user:${w.gus.id}`, 'full')).status).toBe(403);
    expect((await put(w.mo.token, P.id, `user:${w.mo.id}`, 'full')).status).toBe(404);
    expect((await put(w.ada.token, V.id, `user:${w.xo.id}`, 'view')).status).toBe(400);
    expect(
      (await w.call('POST', `/api/workspaces/${w.ws}/pages/plan/share`, w.mo.token, { scope: T }))
        .status,
    ).toBe(403);
    expect(
      (
        await w.call('POST', `/api/workspaces/${w.ws}/pages/notice/move`, w.mo.token, {
          from: V.id,
          to: T,
        })
      ).status,
    ).toBe(403);
    expect(
      (await w.call('POST', `/api/workspaces/${w.ws}/teamspaces`, w.gus.token, { name: 'G' }))
        .status,
    ).toBe(403);
    expect((await w.call('GET', `/api/workspaces/${w.ws}/scopes`, w.xo.token)).status).toBe(404);
  });

  it('outsiders are refused; access changes reach open and returning devices', async () => {
    const w = await world();
    const xo = w.device('xo-1', w.xo.token);
    xo.client.start();
    await until(() => xo.client.state.state === 'unauthorized', 'refused');
    expect(xo.closes.at(-1)!.code).toBe(CloseCode.forbidden);

    const gus = w.device('gus-1', w.gus.token);
    gus.client.start();
    await w.live(gus);
    expect(gus.text('spec')).toBe('spec body');

    // Taken away while connected: the docs go.
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${w.S.id}/access`, w.ada.token, {
      principal: `user:${w.gus.id}`,
      role: null,
    });
    await until(() => !gus.has('spec') && !gus.has('comments:spec'), 'revoked');
    expect(gus.known).toEqual([]);

    // Given back while away: on reconnecting, the docs come whole.
    gus.client.stop();
    w.a.doc('spec').getText('t').insert(9, ' v2');
    await w.settled(w.a);
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${w.S.id}/access`, w.ada.token, {
      principal: `user:${w.gus.id}`,
      role: 'view',
    });
    gus.client.start();
    await until(() => gus.text('spec') === 'spec body v2', 'backfilled');
    expect(gus.known).toEqual([w.S.id]);

    // Moved out of a scope while away: gone on reconnecting.
    gus.client.stop();
    const moved = await w.call('POST', `/api/workspaces/${w.ws}/pages/spec/move`, w.ada.token, {
      from: w.S.id,
      to: w.P.id,
    });
    expect(moved.status).toBe(200);
    gus.client.start();
    await until(() => !gus.has('spec'), 'moved away');

    // Downgraded while offline: the offline edit is refused and undone, nothing is lost
    // on the server.
    const mo = w.device('mo-1', w.mo.token);
    mo.client.start();
    await w.live(mo);
    mo.client.stop();
    mo.doc('plan').getText('t').insert(0, 'offline edit ');
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${w.T}/access`, w.ada.token, {
      principal: 'workspace',
      role: 'view',
    });
    mo.client.start();
    await until(() => mo.resets.includes('plan'), 'refused and reset');
    expect(mo.text('plan')).toBe('plan body');
    expect(mo.client.state.state).toBe('live');

    // A group grant reaches its members.
    const group = (
      await w.call('POST', `/api/workspaces/${w.ws}/groups`, w.ada.token, { name: 'Eng' })
    ).body.group;
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${w.P.id}/access`, w.ada.token, {
      principal: `group:${group.id}`,
      role: 'view',
    });
    expect(mo.has('diary')).toBe(false);
    await w.call(
      'PUT',
      `/api/workspaces/${w.ws}/groups/${group.id}/members/${w.mo.id}`,
      w.ada.token,
    );
    await until(() => mo.text('diary') === 'my secret', 'shared through the group');
  });
});
