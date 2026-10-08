import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { MEMBERS_DOC_ID, listMembers } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { CloseCode } from '@workspace/sync';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import type { Mail } from './mailer';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-members-'));
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

/** A listening server (invite-only sign-up) whose mail goes to `mail`. */
async function setup({ mailer = true } = {}) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'invite',
    PUBLIC_URL: 'http://app.test',
  });
  const mail: Mail[] = [];
  const app = buildServer({
    config,
    store,
    files: new FsStorage(dir),
    mailer: mailer ? { send: async (m) => void mail.push(m) } : null,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );

  const call = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    token?: string,
    payload?: object,
  ) => {
    const res = await app.inject({
      method,
      url,
      payload,
      headers: token ? { authorization: `Bearer ${token}` } : { 'x-workspace-client': 'test' },
    });
    // Loosely typed: the tests read whatever each route returns.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.statusCode, body: res.json() as Record<string, any> };
  };
  const signup = async (email: string, invite?: string) => {
    const res = await call('POST', '/api/auth/signup', undefined, {
      email,
      name: email.split('@')[0]!.replace(/^./, (c) => c.toUpperCase()),
      password: 'long password',
      client: 'desktop',
      ...(invite ? { invite } : {}),
    });
    return {
      status: res.status,
      body: res.body,
      token: res.body.token as string,
      id: res.body.user?.id as string,
    };
  };
  const tokenOf = (link: string) => link.split('/invite/')[1]!;
  const device = (deviceId: string, token: string, workspaceId: string) => {
    const d = new TestDevice({
      url: `ws://127.0.0.1:${port}/api/sync/${workspaceId}`,
      token,
      deviceId,
    });
    cleanups.push(() => d.client.stop());
    return d;
  };
  return { app, store, call, signup, mail, tokenOf, device };
}

/** An owner with a workspace, and a helper to bring people in by invite. */
async function team(s: Awaited<ReturnType<typeof setup>>) {
  const ada = await s.signup('ada@lab.io');
  const created = await s.call('POST', '/api/workspaces', ada.token, { name: 'Lab' });
  const ws = created.body.workspace.id as string;
  const join = async (email: string, role: 'admin' | 'member' | 'guest') => {
    const res = await s.call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [email],
      role,
    });
    const person = await s.signup(email, s.tokenOf(res.body.invites[0].link));
    expect(person.status).toBe(201);
    return person;
  };
  return { ada, ws, join };
}

describe('invites', () => {
  it('invite by email; the invitee signs up with the link and is in', async () => {
    const s = await setup();
    const { ada, ws } = await team(s);

    const res = await s.call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: ['Bob@Lab.io', 'bob@lab.io', 'ada@lab.io'],
      role: 'member',
    });
    expect(res.status).toBe(201);
    expect(res.body.skipped).toEqual(['ada@lab.io']);
    expect(res.body.invites).toHaveLength(1);
    const invite = res.body.invites[0];
    expect(invite).toMatchObject({ email: 'bob@lab.io', role: 'member', emailed: true });
    expect(invite.link).toMatch(/^http:\/\/app\.test\/invite\/[\w-]+$/);
    expect(s.mail).toEqual([
      expect.objectContaining({ to: 'bob@lab.io', subject: 'Ada invited you to Lab' }),
    ]);
    expect(s.mail[0]!.text).toContain(invite.link);
    const token = s.tokenOf(invite.link);

    // What the link shows, signed out.
    expect((await s.call('GET', `/api/invites/${token}`)).body.invite).toEqual({
      workspace: 'Lab',
      email: 'bob@lab.io',
      role: 'member',
      invitedBy: 'Ada',
      status: 'valid',
    });
    expect((await s.call('GET', '/api/invites/nope')).status).toBe(404);
    expect((await s.call('GET', `/api/workspaces/${ws}/invites`, ada.token)).body.invites).toEqual([
      expect.objectContaining({ email: 'bob@lab.io', role: 'member' }),
    ]);

    // Sign-up is invite-only: no invite, or someone else's, doesn't work.
    expect((await s.signup('eve@lab.io')).status).toBe(403);
    expect((await s.signup('eve@lab.io', token)).status).toBe(403);

    const bob = await s.signup('bob@lab.io', token);
    expect(bob.status).toBe(201);
    expect((await s.call('GET', '/api/workspaces', bob.token)).body.workspaces).toEqual([
      expect.objectContaining({ id: ws, name: 'Lab', role: 'member' }),
    ]);
    // Accepting again (the web app does after signing up) is harmless.
    expect((await s.call('POST', `/api/invites/${token}/accept`, bob.token)).body).toEqual({
      workspace: { id: ws, name: 'Lab', role: 'member' },
    });
    expect((await s.call('GET', `/api/invites/${token}`)).body.invite.status).toBe('accepted');
    expect((await s.call('GET', `/api/workspaces/${ws}/invites`, ada.token)).body.invites).toEqual(
      [],
    );

    const members = await s.call('GET', `/api/workspaces/${ws}/members`, bob.token);
    expect(members.body.role).toBe('member');
    expect(
      members.body.members.map((m: { name: string; role: string }) => [m.name, m.role]),
    ).toEqual([
      ['Ada', 'owner'],
      ['Bob', 'member'],
    ]);
  });

  it('an existing account accepts while signed in, but only as the invited email', async () => {
    const s = await setup({ mailer: false });
    const { ada, ws, join } = await team(s);
    const cy = await join('cy@lab.io', 'member');
    const other = await s.call('POST', '/api/workspaces', cy.token, { name: 'Cy’s' });

    // Ada (in Lab already) is invited to Cy's workspace; Bob must not use her link.
    const res = await s.call(
      'POST',
      `/api/workspaces/${other.body.workspace.id}/invites`,
      cy.token,
      {
        emails: ['ada@lab.io'],
        role: 'guest',
      },
    );
    expect(res.body.invites[0].emailed).toBe(false);
    const token = s.tokenOf(res.body.invites[0].link);
    const bob = await join('bob@lab.io', 'member');
    const wrong = await s.call('POST', `/api/invites/${token}/accept`, bob.token);
    expect(wrong).toEqual({
      status: 403,
      body: {
        error: 'wrong_account',
        message: 'This invite is for ada@lab.io, and you’re signed in as bob@lab.io.',
      },
    });
    expect((await s.call('POST', `/api/invites/${token}/accept`)).status).toBe(401);
    const ok = await s.call('POST', `/api/invites/${token}/accept`, ada.token);
    expect(ok.body.workspace).toMatchObject({ name: 'Cy’s', role: 'guest' });
    expect((await s.call('POST', `/api/invites/${token}/accept`, bob.token)).status).toBe(410);

    // Withdrawn invites stop working.
    const again = await s.call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: ['dee@lab.io'],
      role: 'guest',
    });
    const id = again.body.invites[0].id;
    expect((await s.call('DELETE', `/api/workspaces/${ws}/invites/${id}`, ada.token)).status).toBe(
      200,
    );
    expect((await s.call('DELETE', `/api/workspaces/${ws}/invites/${id}`, ada.token)).status).toBe(
      404,
    );
    const dee = await s.signup('dee@lab.io', s.tokenOf(again.body.invites[0].link));
    expect(dee.status).toBe(403);
  });
});

describe('roles', () => {
  it('owners and admins manage; members and guests don’t; outsiders see nothing', async () => {
    const s = await setup({ mailer: false });
    const { ada, ws, join } = await team(s);
    const al = await join('al@lab.io', 'admin');
    const mo = await join('mo@lab.io', 'member');
    const gu = await join('gu@lab.io', 'guest');
    const outsider = await s.store.accounts.createUser({
      email: 'x@lab.io',
      name: 'X',
      passwordHash: null,
    });
    const xToken = 'x-session-token';
    await s.store.accounts.createSession({
      userId: outsider!.id,
      token: xToken,
      kind: 'desktop',
      deviceName: '',
      ttlMs: 3_600_000,
    });
    const url = `/api/workspaces/${ws}`;

    expect((await s.call('GET', `${url}/members`, xToken)).status).toBe(404);
    expect((await s.call('GET', `${url}/members`, gu.token)).status).toBe(403);
    expect((await s.call('GET', `${url}/groups`, gu.token)).status).toBe(403);
    expect((await s.call('GET', `${url}/members`, mo.token)).status).toBe(200);
    expect(
      (await s.call('POST', `${url}/invites`, mo.token, { emails: ['z@lab.io'], role: 'guest' }))
        .status,
    ).toBe(403);
    expect((await s.call('GET', `${url}/invites`, mo.token)).status).toBe(403);
    expect(
      (await s.call('PATCH', `${url}/members/${gu.id}`, mo.token, { role: 'member' })).status,
    ).toBe(403);

    // Admins manage members, but not owners.
    expect(
      (await s.call('PATCH', `${url}/members/${gu.id}`, al.token, { role: 'member' })).status,
    ).toBe(200);
    expect(
      (await s.call('PATCH', `${url}/members/${mo.id}`, al.token, { role: 'owner' })).body,
    ).toMatchObject({ error: 'forbidden' });
    expect(
      (await s.call('PATCH', `${url}/members/${ada.id}`, al.token, { role: 'member' })).status,
    ).toBe(403);
    expect((await s.call('DELETE', `${url}/members/${ada.id}`, al.token)).status).toBe(403);
    expect((await s.call('DELETE', `${url}/members/${gu.id}`, al.token)).status).toBe(200);
    expect((await s.call('DELETE', `${url}/members/${gu.id}`, al.token)).status).toBe(404);
    expect((await s.call('GET', `${url}/members`, gu.token)).status).toBe(404);

    // The last owner can't step down or leave; with a second owner they can.
    expect(
      (await s.call('PATCH', `${url}/members/${ada.id}`, ada.token, { role: 'admin' })).body,
    ).toMatchObject({ error: 'last_owner' });
    expect((await s.call('DELETE', `${url}/members/${ada.id}`, ada.token)).body).toMatchObject({
      error: 'last_owner',
    });
    expect(
      (await s.call('PATCH', `${url}/members/${mo.id}`, ada.token, { role: 'owner' })).status,
    ).toBe(200);
    // Anyone can leave.
    expect((await s.call('DELETE', `${url}/members/${al.id}`, al.token)).status).toBe(200);
    expect((await s.call('DELETE', `${url}/members/${ada.id}`, ada.token)).status).toBe(200);
    const left = await s.call('GET', `${url}/members`, mo.token);
    expect(left.body.members.map((m: { name: string; role: string }) => [m.name, m.role])).toEqual([
      ['Mo', 'owner'],
    ]);
  });

  it('groups: owners and admins manage them, for the workspace’s members only', async () => {
    const s = await setup({ mailer: false });
    const { ada, ws, join } = await team(s);
    const mo = await join('mo@lab.io', 'member');
    const url = `/api/workspaces/${ws}/groups`;
    expect((await s.call('POST', url, mo.token, { name: 'Eng' })).status).toBe(403);
    const eng = (await s.call('POST', url, ada.token, { name: 'Eng' })).body.group;
    expect((await s.call('POST', url, ada.token, { name: 'Eng' })).status).toBe(409);
    expect((await s.call('PUT', `${url}/${eng.id}/members/${mo.id}`, ada.token)).status).toBe(200);
    const stranger = await s.store.accounts.createUser({
      email: 's@lab.io',
      name: 'S',
      passwordHash: null,
    });
    expect(
      (await s.call('PUT', `${url}/${eng.id}/members/${stranger!.id}`, ada.token)).status,
    ).toBe(404);
    expect(
      (await s.call('PATCH', `${url}/${eng.id}`, ada.token, { name: 'Engineering' })).status,
    ).toBe(200);
    expect((await s.call('GET', url, mo.token)).body.groups).toEqual([
      { id: eng.id, name: 'Engineering', members: [mo.id] },
    ]);
    expect((await s.call('DELETE', `${url}/${eng.id}/members/${mo.id}`, ada.token)).status).toBe(
      200,
    );
    expect((await s.call('DELETE', `${url}/${eng.id}`, ada.token)).status).toBe(200);
    expect((await s.call('GET', url, mo.token)).body.groups).toEqual([]);
  });
});

describe('the members doc', () => {
  it('reaches devices live, follows profile and role changes, and only the server writes it', async () => {
    const s = await setup({ mailer: false });
    const { ada, ws, join } = await team(s);
    const a = s.device('ada-laptop', ada.token, ws);
    a.client.start();
    const names = () =>
      listMembers(a.doc(MEMBERS_DOC_ID)).map((m) => [m.name, m.role, m.removed] as const);
    await until(() => names().length === 1, 'the owner listed');
    expect(names()).toEqual([['Ada', 'owner', false]]);

    const bob = await join('bob@lab.io', 'member');
    await until(() => names().length === 2, 'Bob listed');
    const b = s.device('bob-laptop', bob.token, ws);
    b.client.start();
    await until(() => listMembers(b.doc(MEMBERS_DOC_ID)).length === 2, 'Bob sees both');

    // A new name and picture show everywhere.
    const avatar = 'data:image/png;base64,iVBORw0KGgo=';
    const me = await s.call('PATCH', '/api/auth/me', bob.token, { name: 'Bob B.', avatar });
    expect(me.body.user).toMatchObject({ name: 'Bob B.', avatar });
    await until(() => names().some(([n]) => n === 'Bob B.'), 'the new name');
    expect(listMembers(a.doc(MEMBERS_DOC_ID)).find((m) => m.name === 'Bob B.')?.avatar).toBe(
      avatar,
    );
    expect(
      (await s.call('PATCH', '/api/auth/me', bob.token, { avatar: 'data:text/html,<b>' })).status,
    ).toBe(400);

    // A device can't write the members doc: Bob promoting himself goes nowhere.
    const closesBefore = b.closes.length;
    b.doc(MEMBERS_DOC_ID)
      .getMap('members')
      .set(bob.id, { name: 'Bob B.', avatar: null, role: 'owner', removed: false });
    await until(() => b.outbox.length === 0, 'the push acknowledged');
    expect(b.closes.length).toBe(closesBefore);
    const merged = await s.store.docState(ws, MEMBERS_DOC_ID);
    const { Doc, applyUpdate } = await import('yjs');
    const server = new Doc();
    applyUpdate(server, merged!);
    expect(listMembers(server).find((m) => m.id === bob.id)?.role).toBe('member');
    expect(listMembers(a.doc(MEMBERS_DOC_ID)).find((m) => m.id === bob.id)?.role).toBe('member');

    // A role change reaches Bob's open sockets (new access, no reconnect); removal
    // closes them for good.
    const closesNow = b.closes.length;
    await s.call('PATCH', `/api/workspaces/${ws}/members/${bob.id}`, ada.token, { role: 'guest' });
    await until(
      () => names().some(([n, role]) => n === 'Bob B.' && role === 'guest'),
      'the new role',
    );
    expect(b.closes.length).toBe(closesNow);
    await s.call('DELETE', `/api/workspaces/${ws}/members/${bob.id}`, ada.token);
    await until(() => b.closes.some((c) => c.code === CloseCode.forbidden), 'Bob is out');
    await until(() => names().some(([, , removed]) => removed), 'Bob marked removed');
    expect(names()).toEqual([
      ['Ada', 'owner', false],
      ['Bob B.', 'guest', true],
    ]);
  });
});
