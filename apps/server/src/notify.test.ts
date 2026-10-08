/**
 * Notifications end to end (Phase 5 M6): real server, real Postgres, real sockets.
 *
 * Lab's first teamspace (everyone edits) has Ada's page "gear". Ada, Bob (member) and
 * Gus (guest, who can't read "gear").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  addComment,
  createPage,
  createThread,
  getPageContent,
  parseNotification,
  reminderKey,
  type NotificationData,
} from '@workspace/core';
import { addProperty, addRow, initDatabase, setCell } from '@workspace/database';
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
  dir = mkdtempSync(join(tmpdir(), 'workspace-notify-'));
});
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const config = () =>
  loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });

/** A paragraph (block `id`) of text and inline mentions. */
function paragraph(id: string, ...parts: (string | Record<string, unknown>)[]) {
  const p = new Y.XmlElement('paragraph');
  p.setAttribute('id', id);
  p.insert(
    0,
    parts.map((part) => {
      if (typeof part === 'string') return new Y.XmlText(part);
      const m = new Y.XmlElement('mention');
      for (const [k, v] of Object.entries(part)) m.setAttribute(k, v as string);
      return m;
    }),
  );
  return p;
}

async function server(store: PgStore, clock: { now: number }) {
  const app = buildServer({
    config: config(),
    store,
    files: new FsStorage(dir),
    mailer: null,
    notify: { delayMs: 0, reminderPollMs: 60_000, now: () => clock.now },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

async function world() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  cleanups.push(() => store.close());
  const clock = { now: Date.UTC(2026, 9, 1) };
  const app = await server(store, clock);
  cleanups.push(() => app.close());
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
  const [ada, bob, gus] = [await signup('ada'), await signup('bob'), await signup('gus')];
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  for (const [person, role] of [
    [bob, 'member'],
    [gus, 'guest'],
  ] as const) {
    const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
      emails: [`${person === bob ? 'bob' : 'gus'}@lab.io`],
      role,
    });
    const token = (invite.body.invites[0].link as string).split('/invite/')[1];
    expect((await call('POST', `/api/invites/${token}/accept`, person.token)).status).toBe(200);
  }
  const url = `ws://127.0.0.1:${port}/api/sync/${ws}`;
  const device = async (deviceId: string, token: string) => {
    const d = new TestDevice({ url, token, deviceId });
    cleanups.push(() => d.client.stop());
    d.client.start();
    await until(() => d.client.state.state === 'live', 'live');
    return d;
  };
  const settled = (d: TestDevice) => until(() => d.outbox.length === 0, 'outbox sent');
  const inbox = async (token: string, filter = 'all') =>
    (await call('GET', `/api/workspaces/${ws}/notifications?filter=${filter}`, token)).body as {
      notifications: NotificationData[];
      unread: number;
    };
  return { app, store, clock, ws, call, device, settled, inbox, ada, bob, gus };
}

describe('notifications', () => {
  it('mentions in pages and comments, comments and replies to followers, live', async () => {
    const w = await world();
    const a = await w.device('ada-1', w.ada.token);
    const b = await w.device('bob-1', w.bob.token);
    createPage(a.doc('workspace'), { id: 'gear', title: 'Gearbox' });
    getPageContent(a.doc('gear')).insert(0, [paragraph('b0', 'Planetary, three stages.')]);
    await w.settled(a);

    // Ada mentions Bob, and Gus (who can't read the page).
    getPageContent(a.doc('gear')).insert(1, [
      paragraph('b1', 'Ask ', { kind: 'person', userId: w.bob.id }, ' and ', {
        kind: 'person',
        userId: w.gus.id,
      }),
    ]);
    await w.settled(a);
    await until(() => b.notifications.length === 1, 'Bob notified live');
    const live = parseNotification(b.notifications[0]!)!;
    expect(live).toMatchObject({
      kind: 'mention',
      pageId: 'gear',
      blockId: 'b1',
      actorId: w.ada.id,
      text: 'Ask and',
      readAt: null,
    });
    const bobs = await w.inbox(w.bob.token);
    expect(bobs.unread).toBe(1);
    expect(bobs.notifications.map((n) => n.id)).toEqual([live.id]);
    expect((await w.inbox(w.gus.token)).notifications).toEqual([]);

    // Editing the block again doesn't mention him again; Ada isn't told about herself.
    getPageContent(a.doc('gear')).insert(2, [paragraph('b2', 'More text')]);
    await w.settled(a);

    // Bob starts a thread (Ada follows the page she edited): she's told. He follows now.
    const t = createThread(b.doc('comments:gear'), {
      anchor: { kind: 'page' },
      author: w.bob.id,
      body: 'Is <@' + w.ada.id + '> sure about three?',
    });
    await w.settled(b);
    await until(async () => (await w.inbox(w.ada.token)).notifications.length === 1, 'Ada told');
    const [mentioned] = (await w.inbox(w.ada.token)).notifications;
    // Mentioned and following: one notification, the mention.
    expect(mentioned).toMatchObject({ kind: 'mention', threadId: t, actorId: w.bob.id });
    expect(mentioned!.text).toBe('Is @ada sure about three?');

    // Ada replies: Bob (who took part, and follows) gets a reply.
    await until(() => a.has('comments:gear'), 'Ada has the comments');
    addComment(a.doc('comments:gear'), t, w.ada.id, 'Yes, 64:1.');
    await w.settled(a);
    await until(
      async () => (await w.inbox(w.bob.token)).notifications.some((n) => n.kind === 'reply'),
      'Bob gets the reply',
    );
    expect(b.notifications.map((n) => parseNotification(n)!.kind)).toEqual(['mention', 'reply']);
    expect((await w.inbox(w.bob.token, 'mentions')).notifications).toHaveLength(1);

    // Read and archived.
    expect(
      (await w.call('POST', `/api/workspaces/${w.ws}/notifications/read`, w.bob.token, {})).status,
    ).toBe(200);
    expect((await w.inbox(w.bob.token)).unread).toBe(0);
    await w.call('POST', `/api/workspaces/${w.ws}/notifications/archive`, w.bob.token, {
      ids: [live.id],
    });
    expect((await w.inbox(w.bob.token, 'archived')).notifications.map((n) => n.id)).toEqual([
      live.id,
    ]);

    // Unfollowing: a new thread by Ada doesn't reach Bob.
    const follow = `/api/workspaces/${w.ws}/pages/gear/follow`;
    expect((await w.call('GET', follow, w.bob.token)).body).toEqual({ following: true });
    await w.call('PUT', follow, w.bob.token, { following: false });
    createThread(a.doc('comments:gear'), {
      anchor: { kind: 'page' },
      author: w.ada.id,
      body: 'Next?',
    });
    await w.settled(a);
    await w.app.notifier.run(w.ws);
    expect((await w.inbox(w.bob.token)).notifications.filter((n) => n.kind === 'comment')).toEqual(
      [],
    );
    // Gus can't follow a page he can't read.
    expect((await w.call('PUT', follow, w.gus.token, { following: true })).status).toBe(404);
  });

  it('sharing tells the person; losing access hides what was about it', async () => {
    const w = await world();
    const a = await w.device('ada-1', w.ada.token);
    const team = (
      await w.call('POST', `/api/workspaces/${w.ws}/teamspaces`, w.ada.token, {
        name: 'Drives',
        everyone: 'edit',
      })
    ).body.scope;
    a.hint = team.id;
    createPage(a.doc(team.treeDoc), { id: 'drive', title: 'Drive' });
    getPageContent(a.doc('drive')).insert(0, [
      paragraph('d1', 'For ', { kind: 'person', userId: w.bob.id }),
    ]);
    await w.settled(a);
    await until(
      async () => (await w.inbox(w.bob.token)).notifications.length === 1,
      'Bob mentioned',
    );
    // Everyone loses the teamspace: Bob's notification about it isn't listed any more.
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${team.id}/access`, w.ada.token, {
      principal: 'workspace',
      role: null,
    });
    expect(await w.inbox(w.bob.token)).toMatchObject({ notifications: [], unread: 0 });

    // Then Ada adds Bob himself: he's told.
    await w.call('PUT', `/api/workspaces/${w.ws}/scopes/${team.id}/access`, w.ada.token, {
      principal: `user:${w.bob.id}`,
      role: 'view',
    });
    const { notifications } = await w.inbox(w.bob.token);
    expect(notifications.map((n) => [n.kind, n.text, n.actorId])).toEqual([
      ['access', 'Added you to Drives', w.ada.id],
      ['mention', 'For', w.ada.id],
    ]);
  });

  it('reminders fire at 9:00 where their owner is, once, across a restart', async () => {
    const w = await world();
    expect(
      (await w.call('PATCH', '/api/auth/me', w.ada.token, { timeZone: 'Asia/Tokyo' })).status,
    ).toBe(200);
    expect(
      (await w.call('PATCH', '/api/auth/me', w.ada.token, { timeZone: 'Mars/Olympus' })).status,
    ).toBe(400);
    const a = await w.device('ada-1', w.ada.token);
    createPage(a.doc('workspace'), { id: 'todo', title: 'Todo' });
    getPageContent(a.doc('todo')).insert(0, [
      paragraph('r1', 'Order servos ', {
        kind: 'date',
        date: '2026-10-05',
        reminder: 'true',
        userId: w.ada.id,
      }),
    ]);
    await w.settled(a);
    const fireAt = Date.UTC(2026, 9, 5, 0); // 9:00 in Tokyo
    await until(
      async () => (await w.store.notifications.remindersOf(w.ws, 'todo')).length === 1,
      'reminder stored',
    );
    expect(await w.store.notifications.remindersOf(w.ws, 'todo')).toMatchObject([
      { userId: w.ada.id, blockId: 'r1', fireAt, text: 'Order servos' },
    ]);
    await w.app.notifier.fireReminders();
    expect((await w.inbox(w.ada.token)).notifications).toEqual([]);

    // A date property's reminder: for whoever set it, in their time zone.
    const db = a.doc('parts');
    initDatabase(db, { databaseId: 'parts' });
    const due = addProperty(db, { name: 'Due', type: 'date' });
    const row = addRow(db, {
      actor: w.ada.id,
      title: 'Servo',
      values: { [due]: { start: '2026-12-20', reminder: 'onDay' } },
    });
    createPage(a.doc('workspace'), { id: 'parts', title: 'Parts' });
    await w.settled(a);
    const propertyReminder = async () =>
      (await w.store.notifications.remindersOf(w.ws, 'parts'))[0];
    await until(async () => !!(await propertyReminder()), 'property reminder stored');
    expect(await propertyReminder()).toMatchObject({
      key: `${row}/prop:${due}`,
      userId: w.ada.id,
      pageId: row,
      blockId: `prop:${due}`,
      fireAt: Date.UTC(2026, 11, 20, 0),
      text: 'Due: Servo',
    });
    // Bob (in UTC) moves the date: now it's his.
    const b = await w.device('bob-1', w.bob.token);
    await until(() => b.has('parts'), 'Bob has the database');
    setCell(b.doc('parts'), row, due, { start: '2026-12-22', reminder: 'onDay' }, w.bob.id);
    await w.settled(b);
    await until(
      async () => (await propertyReminder())?.userId === w.bob.id,
      'reminder moved to Bob',
    );
    expect((await propertyReminder())!.fireAt).toBe(Date.UTC(2026, 11, 22, 9));
    await b.client.stop();

    // The server stops; the time comes; another starts and fires it (once).
    await a.client.stop();
    await w.app.close();
    w.clock.now = fireAt + 60_000;
    for (let i = 0; i < 2; i++) {
      const next = await server(w.store, w.clock);
      await next.notifier.start();
      await next.notifier.fireReminders();
      await next.close();
    }
    const again = await server(w.store, w.clock);
    cleanups.push(() => again.close());
    const res = await again.inject({
      method: 'GET',
      url: `/api/workspaces/${w.ws}/notifications`,
      headers: { authorization: `Bearer ${w.ada.token}` },
    });
    expect(res.json().notifications).toEqual([
      expect.objectContaining({
        kind: 'reminder',
        pageId: 'todo',
        blockId: 'r1',
        actorId: null,
        text: 'Order servos',
        key: reminderKey('todo', 'r1', fireAt),
      }),
    ]);
  });
});
