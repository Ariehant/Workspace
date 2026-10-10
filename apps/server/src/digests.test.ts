/**
 * Phase 6 M7: email digests. Real server, real Postgres, a desktop over a real socket,
 * and a mailer that keeps what it's given.
 *
 * Ada (owner) and Bob (member) are in Lab; its first teamspace (everyone edits) has
 * Ada's pages. Ada mentions Bob.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, getPageContent } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import type { Mail } from './mailer';
import { nextMorning } from './notify/digests';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-digests-'));
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

/** A paragraph mentioning someone. */
function mention(userId: string, text: string) {
  const p = new Y.XmlElement('paragraph');
  const m = new Y.XmlElement('mention');
  m.setAttribute('kind', 'person');
  m.setAttribute('userId', userId);
  p.insert(0, [new Y.XmlText(`${text} `), m]);
  return p;
}

async function world(mentionDelayMs = 1500) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const mails: Mail[] = [];
  const app = buildServer({
    config,
    store,
    files: new FsStorage(dir),
    mailer: { send: async (mail) => void mails.push(mail) },
    jobs: { pollMs: 20 },
    notify: { delayMs: 0, reminderPollMs: 60_000 },
    digests: { mentionDelayMs },
    indexDelayMs: 50,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  app.jobs.start();
  const port = (app.server.address() as AddressInfo).port;
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const call = async (
    method: string,
    url: string,
    token: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload,
      headers: { authorization: `Bearer ${token}`, ...headers },
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
  const bob = await signup('bob');
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
    emails: ['bob@lab.io'],
    role: 'member',
  });
  const code = (invite.body.invites[0].link as string).split('/invite/')[1];
  await call('POST', `/api/invites/${code}/accept`, bob.token);
  mails.length = 0; // (the invite)
  const a = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
    token: ada.token,
    deviceId: 'ada-1',
  });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  const settled = () => until(() => a.outbox.length === 0, 'outbox sent');
  const inbox = async (token: string) =>
    (await call('GET', `/api/workspaces/${ws}/notifications`, token)).body;
  /** A page in `tree` that mentions Bob. */
  const mentionBob = async (tree: string, id: string, title: string) => {
    createPage(a.doc(tree), { id, title });
    getPageContent(a.doc(id)).insert(0, [mention(bob.id, `About ${title},`)]);
    await settled();
  };
  return { app, store, ws, call, ada, bob, a, mails, inbox, mentionBob, settled };
}

describe('email digests', () => {
  it('the next morning is 9:00 in the person’s time zone', () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nextMorning(at('2026-10-10T08:00:00Z'), 'UTC')).toBe(at('2026-10-10T09:00:00Z'));
    expect(nextMorning(at('2026-10-10T10:00:00Z'), 'UTC')).toBe(at('2026-10-11T09:00:00Z'));
    expect(nextMorning(at('2026-10-10T10:00:00Z'), 'Asia/Tokyo')).toBe(at('2026-10-11T00:00:00Z'));
  });

  it('mentions: one email for what is unread, without pages lost since; unsubscribe works', async () => {
    const w = await world();
    const T = (await w.call('GET', `/api/workspaces/${w.ws}/scopes`, w.ada.token)).body
      .defaultScopeId as string;
    const drives = (
      await w.call('POST', `/api/workspaces/${w.ws}/teamspaces`, w.ada.token, {
        name: 'Drives',
        everyone: 'edit',
      })
    ).body.scope;
    w.a.hint = T;
    await w.mentionBob('workspace', 'gear', 'Gear');
    w.a.hint = drives.id;
    await w.mentionBob(drives.treeDoc, 'drive', 'Drive');
    await until(async () => (await w.inbox(w.bob.token)).notifications.length === 2, 'mentions');
    // Within the 10 minutes (here 1.5 s), everyone loses "Drives".
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${drives.id}/access`, w.ada.token, {
      principal: 'workspace',
      role: null,
    });
    await until(() => w.mails.length === 1, 'the email');
    await settle();
    expect(w.mails).toHaveLength(1);
    const mail = w.mails[0]!;
    expect(mail).toMatchObject({ to: 'bob@lab.io', subject: 'ada mentioned you in “Gear”' });
    expect(mail.text).toContain('About Gear,');
    expect(mail.text).toContain(`http://app.test/w/${w.ws}#page=gear`);
    expect(mail.text).not.toContain('Drive');
    const unsubscribe = /<(http:\/\/app\.test\/email\/unsubscribe\?[^>]+)>/.exec(
      mail.headers!['List-Unsubscribe']!,
    )![1]!;
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.text).toContain(unsubscribe);

    // Two more mentions: one email with both (not the one sent already).
    w.a.hint = T;
    await w.mentionBob('workspace', 'wheel', 'Wheel');
    await w.mentionBob('workspace', 'axle', 'Axle');
    await until(() => w.mails.length === 2, 'the second email');
    expect(w.mails[1]!.subject).toBe('2 updates in Lab');
    expect(w.mails[1]!.text).toContain('“Wheel”');
    expect(w.mails[1]!.text).toContain('“Axle”');
    expect(w.mails[1]!.text).not.toContain('Gear');

    // Read in time: no email.
    await w.call('POST', `/api/workspaces/${w.ws}/notifications/read`, w.bob.token, {});
    await w.mentionBob('workspace', 'hub', 'Hub');
    await until(async () => (await w.inbox(w.bob.token)).unread === 1, 'unread');
    await w.call('POST', `/api/workspaces/${w.ws}/notifications/read`, w.bob.token, {});
    await settle(2500);
    expect(w.mails).toHaveLength(2);

    // One click (as a mail client does it): no more emails. A page first, for people.
    const url = new URL(unsubscribe);
    const shown = await w.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(shown.statusCode).toBe(200);
    expect(shown.body).toContain('<form method="post"');
    expect((await w.call('GET', '/api/auth/me/email', w.bob.token)).body).toEqual({
      digest: 'mentions',
      available: true,
    });
    const wrong = await w.app.inject({
      method: 'POST',
      url: `${url.pathname}?u=${w.bob.id}&t=${'0'.repeat(64)}`,
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(wrong.statusCode).toBe(404);
    const clicked = await w.app.inject({
      method: 'POST',
      url: url.pathname + url.search,
      payload: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(clicked.statusCode).toBe(200);
    expect((await w.call('GET', '/api/auth/me/email', w.bob.token)).body.digest).toBe('never');
    await w.mentionBob('workspace', 'gearbox', 'Gearbox');
    await settle(2500);
    expect(w.mails).toHaveLength(2);
  });

  it('daily: one email at 9:00 in their time zone; never: none', async () => {
    const w = await world();
    expect(
      (await w.call('PUT', '/api/auth/me/email', w.bob.token, { digest: 'daily' })).body,
    ).toEqual({ digest: 'daily', available: true });
    expect(
      (await w.call('PUT', '/api/auth/me/email', w.bob.token, { digest: 'hourly' })).status,
    ).toBe(400);
    await w.call('PATCH', '/api/auth/me', w.bob.token, { timeZone: 'Asia/Tokyo' });
    await w.call('PUT', '/api/auth/me/email', w.ada.token, { digest: 'never' });
    await w.mentionBob('workspace', 'gear', 'Gear');
    await w.mentionBob('workspace', 'wheel', 'Wheel');
    await until(async () => (await w.inbox(w.bob.token)).notifications.length === 2, 'mentions');
    await settle();
    // One job for Bob, at his next 9:00; none for Ada.
    const { rows } = await w.store.pool.query<{ key: string; run_at: Date }>(
      `SELECT key, run_at FROM jobs WHERE kind = 'email.digest' AND done_at IS NULL`,
    );
    expect(rows.map((r) => r.key)).toEqual([`digest:${w.bob.id}`]);
    expect(
      Math.abs(rows[0]!.run_at.getTime() - nextMorning(Date.now(), 'Asia/Tokyo')),
    ).toBeLessThan(60_000);
    expect(w.mails).toEqual([]);
    // 9:00 comes.
    await w.store.pool.query(`UPDATE jobs SET run_at = now() WHERE kind = 'email.digest'`);
    await until(() => w.mails.length === 1, 'the daily email');
    expect(w.mails[0]).toMatchObject({ to: 'bob@lab.io', subject: '2 updates in Lab' });
    expect(w.mails[0]!.text).toContain('a daily email');
  });

  it('no mail server: nothing is lined up, and settings say so', async () => {
    const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 4 });
    await store.migrate();
    const app = buildServer({
      config: loadConfig({
        DATABASE_URL: 'postgres://unused',
        LOG_LEVEL: 'silent',
        FILES_DIR: dir,
        SIGNUP: 'open',
      }),
      store,
      files: new FsStorage(dir),
      mailer: null,
    });
    cleanups.push(
      () => app.close(),
      () => store.close(),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email: 'eve@lab.io', name: 'Eve', password: 'long password', client: 'desktop' },
    });
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me/email',
      headers: { authorization: `Bearer ${res.json().token}` },
    });
    expect(me.json()).toEqual({ digest: 'mentions', available: false });
  });
});
