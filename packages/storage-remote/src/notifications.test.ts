import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

async function user(name: string) {
  const u = await store.accounts.createUser({
    email: `${name}-${randomUUID()}@lab.io`,
    name,
    passwordHash: null,
  });
  return u!.id;
}

describe('notifications store', () => {
  it('stores, lists by filter, marks read and archives; keys make one', async () => {
    const ws = await store.createWorkspace('W', null);
    const ada = await user('Ada');
    const bob = await user('Bob');
    const n = store.notifications;
    const base = { workspaceId: ws.id, userId: bob, pageId: 'p1', title: 'Gearbox', docId: 'p1' };
    const mention = await n.add({
      ...base,
      kind: 'mention',
      actorId: ada,
      text: 'Ask @Bob',
      key: 'm1',
    });
    expect(mention).toMatchObject({ kind: 'mention', actorId: ada, readAt: null });
    expect(await n.add({ ...base, kind: 'mention', text: 'again', key: 'm1' })).toBeNull();
    const reply = await n.add({ ...base, kind: 'reply', threadId: 't1', text: 'Fine' });
    expect((await n.list(ws.id, bob)).map((x) => x.id)).toEqual([reply!.id, mention!.id]);
    expect((await n.list(ws.id, bob, { filter: 'mentions' })).map((x) => x.id)).toEqual([
      mention!.id,
    ]);
    expect(await n.list(ws.id, ada)).toEqual([]);

    await n.setRead(ws.id, bob, [mention!.id], true);
    expect((await n.list(ws.id, bob, { filter: 'unread' })).map((x) => x.id)).toEqual([reply!.id]);
    await n.setArchived(ws.id, bob, [reply!.id], true);
    expect((await n.list(ws.id, bob, { filter: 'archived' })).map((x) => x.id)).toEqual([
      reply!.id,
    ]);
    expect(await n.unread(ws.id, bob)).toEqual([]);
    await n.setRead(ws.id, bob, null, false);
    expect(await n.unread(ws.id, bob)).toHaveLength(1);
  });

  it('follows: automatic ones never override a choice', async () => {
    const ws = await store.createWorkspace('W', null);
    const ada = await user('Ada');
    const n = store.notifications;
    await n.setFollowing(ws.id, 'p', ada, true, true);
    expect(await n.followers(ws.id, 'p')).toEqual([ada]);
    await n.setFollowing(ws.id, 'p', ada, false);
    await n.setFollowing(ws.id, 'p', ada, true, true);
    expect(await n.isFollowing(ws.id, 'p', ada)).toBe(false);
  });

  it('reminders: replaced per doc, due once, again when their time changes', async () => {
    const ws = await store.createWorkspace('W', null);
    const ada = await user('Ada');
    const n = store.notifications;
    const r = { key: 'b1@2026-10-05', userId: ada, pageId: 'p', blockId: 'b1', text: 'Order' };
    await n.replaceReminders(ws.id, 'p', [{ ...r, fireAt: 1000 }]);
    const due = await n.dueReminders(5000);
    expect(due.filter((d) => d.workspaceId === ws.id)).toMatchObject([
      { key: r.key, fireAt: 1000 },
    ]);
    await n.reminderFired(due.find((d) => d.workspaceId === ws.id)!);
    expect((await n.dueReminders(5000)).filter((d) => d.workspaceId === ws.id)).toEqual([]);
    // Same time: still fired. A new time: due again.
    await n.replaceReminders(ws.id, 'p', [{ ...r, fireAt: 1000 }]);
    expect((await n.dueReminders(5000)).filter((d) => d.workspaceId === ws.id)).toEqual([]);
    await n.replaceReminders(ws.id, 'p', [{ ...r, fireAt: 2000 }]);
    expect((await n.dueReminders(5000)).filter((d) => d.workspaceId === ws.id)).toHaveLength(1);
    await n.replaceReminders(ws.id, 'p', []);
    expect(await n.remindersOf(ws.id, 'p')).toEqual([]);
  });

  it('log followers: a cursor per workspace', async () => {
    const ws = await store.createWorkspace('W', null);
    const n = store.notifications;
    await store.appendUpdates(ws.id, [{ docId: 'd', data: new Uint8Array([0, 0]) }]);
    expect(await n.followersBehind('notify')).toContain(ws.id);
    await n.setFollowerSeq(ws.id, 'notify', await store.latestSeq(ws.id));
    expect(await n.followersBehind('notify')).not.toContain(ws.id);
    await n.setFollowerSeq(ws.id, 'notify', 0);
    expect(await n.followerSeq(ws.id, 'notify')).toBe(await store.latestSeq(ws.id));
  });
});
