import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { User } from './accounts';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

const DAY = 24 * 3_600_000;
let n = 0;
async function user(name: string): Promise<User> {
  const u = await store.accounts.createUser({
    email: `${name.toLowerCase()}${++n}@lab.io`,
    name,
    passwordHash: null,
  });
  return u!;
}

describe('Teams', () => {
  it('lists members with their role and keeps at least one owner', async () => {
    const ada = await user('Ada');
    const bob = await user('Bob');
    const ws = await store.createWorkspace('Lab', ada.id);
    const t = store.teams;
    expect(await t.addMember(ws.id, bob.id, 'member')).toBe(true);
    expect(await t.addMember(ws.id, bob.id, 'admin')).toBe(false);
    expect((await t.members(ws.id)).map((m) => [m.name, m.role])).toEqual([
      ['Ada', 'owner'],
      ['Bob', 'member'],
    ]);

    // The only owner can't step down or be removed...
    expect(await t.setRole(ws.id, ada.id, 'admin')).toBe(false);
    expect(await t.removeMember(ws.id, ada.id)).toBe(false);
    // ...until there's another.
    expect(await t.setRole(ws.id, bob.id, 'owner')).toBe(true);
    expect(await t.setRole(ws.id, ada.id, 'member')).toBe(true);
    expect(await store.roleOf(ws.id, ada.id)).toBe('member');
    expect(await t.setRole(ws.id, bob.id, 'member')).toBe(false);
    expect(await t.setRole(ws.id, 'c7c4a0a6-5d4f-4f62-9a2b-000000000000', 'member')).toBe(false);
  });

  it('two owners demoting each other at once leave one owner', async () => {
    const a = await user('A');
    const b = await user('B');
    const ws = await store.createWorkspace('Race', a.id);
    await store.teams.addMember(ws.id, b.id, 'owner');
    const results = await Promise.all([
      store.teams.setRole(ws.id, a.id, 'member'),
      store.teams.setRole(ws.id, b.id, 'member'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const roles = (await store.teams.members(ws.id)).map((m) => m.role);
    expect(roles.filter((r) => r === 'owner')).toHaveLength(1);
  });

  it('invites: once, before expiry, for the invited email only', async () => {
    const owner = await user('Owner');
    const cy = await user('Cy');
    const ws = await store.createWorkspace('Invites', owner.id);
    const t = store.teams;
    const invite = await t.createInvite({
      workspaceId: ws.id,
      email: ` ${cy.email.toUpperCase()} `,
      role: 'member',
      token: 'tok-cy',
      invitedBy: owner.id,
      ttlMs: 7 * DAY,
    });
    expect(invite.email).toBe(cy.email);
    expect(await t.pendingInvites(ws.id)).toHaveLength(1);
    expect(await t.inviteInfo('tok-cy')).toMatchObject({
      workspace: { id: ws.id, name: 'Invites' },
      email: cy.email,
      role: 'member',
      invitedByName: 'Owner',
      status: 'valid',
    });
    expect(await t.inviteInfo('nope')).toBeNull();

    // Someone else signed in can't use it.
    const eve = await user('Eve');
    expect(await t.acceptInvite('tok-cy', eve)).toEqual({ ok: false, reason: 'wrong_account' });
    expect(await store.roleOf(ws.id, eve.id)).toBeNull();

    expect(await t.acceptInvite('tok-cy', cy)).toEqual({
      ok: true,
      workspaceId: ws.id,
      role: 'member',
    });
    expect(await store.roleOf(ws.id, cy.id)).toBe('member');
    // Again as the same person: no change; as someone else: used up.
    expect(await t.acceptInvite('tok-cy', cy)).toEqual({
      ok: true,
      workspaceId: ws.id,
      role: 'member',
    });
    expect(await t.acceptInvite('tok-cy', { id: eve.id, email: cy.email })).toEqual({
      ok: false,
      reason: 'accepted',
    });
    expect((await t.inviteInfo('tok-cy'))?.status).toBe('accepted');
    expect(await t.pendingInvites(ws.id)).toHaveLength(0);

    await t.createInvite({
      workspaceId: ws.id,
      email: 'late@lab.io',
      role: 'guest',
      token: 'tok-late',
      invitedBy: owner.id,
      ttlMs: -1000,
    });
    expect((await t.inviteInfo('tok-late'))?.status).toBe('expired');
    expect(await t.acceptInvite('tok-late', { id: cy.id, email: 'late@lab.io' })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await t.acceptInvite('missing', cy)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a new invite replaces the pending one; revoked invites stop working', async () => {
    const owner = await user('Own');
    const dee = await user('Dee');
    const ws = await store.createWorkspace('Again', owner.id);
    const t = store.teams;
    const base = { workspaceId: ws.id, email: dee.email, invitedBy: owner.id, ttlMs: DAY };
    await t.createInvite({ ...base, role: 'guest', token: 'first' });
    const second = await t.createInvite({ ...base, role: 'admin', token: 'second' });
    expect((await t.inviteInfo('first'))?.status).toBe('revoked');
    expect((await t.pendingInvites(ws.id)).map((i) => i.id)).toEqual([second.id]);
    expect(await t.revokeInvite(ws.id, second.id)).toBe(true);
    expect(await t.revokeInvite(ws.id, second.id)).toBe(false);
    expect(await t.acceptInvite('second', dee)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('accepting never lowers an existing role', async () => {
    const owner = await user('O');
    const eli = await user('Eli');
    const ws = await store.createWorkspace('Ranks', owner.id);
    const t = store.teams;
    await t.addMember(ws.id, eli.id, 'admin');
    const base = { workspaceId: ws.id, email: eli.email, invitedBy: owner.id, ttlMs: DAY };
    await t.createInvite({ ...base, role: 'guest', token: 'low' });
    expect(await t.acceptInvite('low', eli)).toMatchObject({ ok: true, role: 'admin' });
    await t.setRole(ws.id, eli.id, 'guest');
    await t.createInvite({ ...base, role: 'member', token: 'high' });
    expect(await t.acceptInvite('high', eli)).toMatchObject({ ok: true, role: 'member' });
  });

  it('groups hold only the workspace’s members, and lose them when they leave', async () => {
    const owner = await user('Gail');
    const fay = await user('Fay');
    const outsider = await user('Out');
    const ws = await store.createWorkspace('Groups', owner.id);
    const other = await store.createWorkspace('Other', outsider.id);
    const t = store.teams;
    await t.addMember(ws.id, fay.id, 'member');

    const eng = (await t.createGroup(ws.id, ' Engineering '))!;
    expect(eng.name).toBe('Engineering');
    expect(await t.createGroup(ws.id, 'Engineering')).toBeNull();
    expect(await t.createGroup(other.id, 'Engineering')).not.toBeNull();
    const ops = (await t.createGroup(ws.id, 'Ops'))!;
    expect(await t.renameGroup(ws.id, ops.id, 'Engineering')).toBe('taken');
    expect(await t.renameGroup(ws.id, ops.id, 'Operations')).toBe('ok');
    expect(await t.renameGroup(other.id, ops.id, 'Stolen')).toBe('missing');

    expect(await t.addToGroup(ws.id, eng.id, fay.id)).toBe(true);
    expect(await t.addToGroup(ws.id, eng.id, fay.id)).toBe(true);
    expect(await t.addToGroup(ws.id, eng.id, owner.id)).toBe(true);
    expect(await t.addToGroup(ws.id, eng.id, outsider.id)).toBe(false);
    expect(await t.addToGroup(other.id, eng.id, outsider.id)).toBe(false);
    expect((await t.groups(ws.id)).map((g) => [g.name, g.members.length])).toEqual([
      ['Engineering', 2],
      ['Operations', 0],
    ]);

    expect(await t.removeMember(ws.id, fay.id)).toBe(true);
    expect((await t.groups(ws.id))[0]!.members).toEqual([owner.id]);
    expect(await t.removeFromGroup(ws.id, eng.id, owner.id)).toBe(true);
    expect(await t.removeFromGroup(ws.id, eng.id, owner.id)).toBe(false);
    expect(await t.deleteGroup(other.id, eng.id)).toBe(false);
    expect(await t.deleteGroup(ws.id, eng.id)).toBe(true);
    expect((await t.groups(ws.id)).map((g) => g.name)).toEqual(['Operations']);
  });

  it('stores an avatar with the account', async () => {
    const u = await user('Pic');
    await store.accounts.setAvatar(u.id, 'data:image/png;base64,AAAA');
    expect((await store.accounts.userById(u.id))?.avatar).toBe('data:image/png;base64,AAAA');
    const ws = await store.createWorkspace('Pics', u.id);
    expect((await store.teams.members(ws.id))[0]!.avatar).toBe('data:image/png;base64,AAAA');
    expect(await store.teams.workspaceIdsOf(u.id)).toEqual([ws.id]);
    expect(await store.teams.usersByIds([u.id])).toEqual([
      { id: u.id, name: 'Pic', avatar: 'data:image/png;base64,AAAA' },
    ]);
  });
});
