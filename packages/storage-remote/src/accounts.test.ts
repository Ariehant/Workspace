import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

const HOUR = 3_600_000;

describe('Accounts', () => {
  it('makes the first user the admin and keeps emails unique, case-insensitively', async () => {
    const a = store.accounts;
    expect(await a.countUsers()).toBe(0);
    const first = await a.createUser({ email: ' Ada@Lab.io ', name: 'Ada', passwordHash: 'h1' });
    expect(first).toMatchObject({ email: 'ada@lab.io', name: 'Ada', isAdmin: true });
    expect(first).not.toHaveProperty('passwordHash');
    const second = await a.createUser({ email: 'bob@lab.io', name: 'Bob', passwordHash: null });
    expect(second?.isAdmin).toBe(false);
    expect(await a.createUser({ email: 'ADA@lab.io', name: 'X', passwordHash: null })).toBeNull();
    expect((await a.userByEmail('ada@LAB.io'))?.passwordHash).toBe('h1');
    expect((await a.listUsers()).map((u) => u.name)).toEqual(['Ada', 'Bob']);
    await a.setAdmin(second!.id, true);
    expect((await a.userById(second!.id))?.isAdmin).toBe(true);
    const temp = await a.createUser({ email: 'tmp@lab.io', name: 'T', passwordHash: null });
    await a.deleteUser(temp!.id);
    expect(await a.userById(temp!.id)).toBeNull();
  });

  it('only one of several racing first sign-ups becomes admin', async () => {
    const fresh = new PgStore(await createTestDatabase(inject('pgUrl')));
    await fresh.migrate();
    const users = await Promise.all(
      [1, 2, 3, 4].map((i) =>
        fresh.accounts.createUser({ email: `u${i}@x.io`, name: `U${i}`, passwordHash: null }),
      ),
    );
    expect(users.filter((u) => u?.isAdmin)).toHaveLength(1);
    await fresh.close();
  });

  it('finds live sessions by token only', async () => {
    const a = store.accounts;
    const user = await a.createUser({ email: 's@lab.io', name: 'S', passwordHash: null });
    const s1 = await a.createSession({
      userId: user!.id,
      token: 'tok-1',
      kind: 'web',
      deviceName: 'Firefox',
      ttlMs: HOUR,
    });
    await a.createSession({
      userId: user!.id,
      token: 'tok-2',
      kind: 'desktop',
      deviceName: 'Laptop',
      ttlMs: HOUR,
    });
    await a.createSession({
      userId: user!.id,
      token: 'tok-old',
      kind: 'web',
      deviceName: '',
      ttlMs: -1,
    });
    const found = await a.sessionByToken('tok-1');
    expect(found?.session.id).toBe(s1.id);
    expect(found?.user).toMatchObject({ id: user!.id, email: 's@lab.io', isAdmin: false });
    expect(found?.user.createdAt).toBeInstanceOf(Date);
    expect(await a.sessionByToken('tok-old')).toBeNull();
    expect(await a.sessionByToken('nope')).toBeNull();
    expect(await a.listSessions(user!.id)).toHaveLength(2);

    // The token itself is never stored.
    const { rows } = await store.pool.query(
      "SELECT 1 FROM sessions WHERE token_hash::text LIKE '%tok%'",
    );
    expect(rows).toHaveLength(0);

    // Sliding expiry only ever extends.
    await a.touchSession(s1.id, 10 * HOUR);
    const [slid] = (await a.listSessions(user!.id)).filter((s) => s.id === s1.id);
    expect(slid!.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * HOUR);

    // Someone else can't revoke it; its owner can.
    const other = await a.createUser({ email: 'o@lab.io', name: 'O', passwordHash: null });
    expect(await a.revokeSession(other!.id, s1.id)).toBe(false);
    expect(await a.revokeSession(user!.id, s1.id)).toBe(true);
    expect(await a.sessionByToken('tok-1')).toBeNull();

    // Revoke all but the current one.
    const s3 = await a.createSession({
      userId: user!.id,
      token: 'tok-3',
      kind: 'web',
      deviceName: '',
      ttlMs: HOUR,
    });
    await a.revokeAllSessions(user!.id, s3.id);
    expect(await a.sessionByToken('tok-2')).toBeNull();
    expect(await a.sessionByToken('tok-3')).not.toBeNull();

    // Disabling the account ends everything.
    await a.setDisabled(user!.id, true);
    expect(await a.sessionByToken('tok-3')).toBeNull();
    expect((await a.userById(user!.id))?.disabledAt).toBeInstanceOf(Date);
    await a.setDisabled(user!.id, false);
    expect((await a.userById(user!.id))?.disabledAt).toBeNull();
    expect(await a.sessionByToken('tok-3')).toBeNull();
  });

  it('uses invites once, for the right email, before they expire', async () => {
    const a = store.accounts;
    const admin = (await a.userByEmail('ada@lab.io'))!;
    const user = await a.createUser({ email: 'inv@lab.io', name: 'I', passwordHash: null });
    await a.createInvite({ code: 'open', email: null, createdBy: admin.id, ttlMs: HOUR });
    await a.createInvite({ code: 'for-c', email: 'C@lab.io', createdBy: admin.id, ttlMs: HOUR });
    await a.createInvite({ code: 'late', email: null, createdBy: admin.id, ttlMs: -1 });

    expect(await a.inviteValid('open', 'anyone@x.io')).toBe(true);
    expect(await a.inviteValid('for-c', 'd@lab.io')).toBe(false);
    expect(await a.inviteValid('for-c', 'c@LAB.io')).toBe(true);
    expect(await a.inviteValid('late', 'c@lab.io')).toBe(false);
    expect(await a.inviteValid('unknown', 'c@lab.io')).toBe(false);

    expect(await a.consumeInvite('open', 'inv@lab.io', user!.id)).toBe(true);
    expect(await a.consumeInvite('open', 'inv@lab.io', user!.id)).toBe(false);
    expect(await a.inviteValid('open', 'inv@lab.io')).toBe(false);
  });

  it('links OIDC identities', async () => {
    const a = store.accounts;
    const user = await a.createUser({ email: 'id@lab.io', name: 'Id', passwordHash: null });
    expect(await a.userByIdentity('gitlab', 'sub-1')).toBeNull();
    await a.linkIdentity('gitlab', 'sub-1', user!.id, 'id@lab.io');
    await a.linkIdentity('gitlab', 'sub-1', user!.id, 'id@lab.io');
    expect((await a.userByIdentity('gitlab', 'sub-1'))?.id).toBe(user!.id);
    expect(await a.userByIdentity('other', 'sub-1')).toBeNull();
  });

  it('hands out OIDC states and desktop codes once', async () => {
    const a = store.accounts;
    const pending = {
      state: 'st-1',
      provider: 'gitlab',
      codeVerifier: 'v',
      nonce: 'n',
      client: 'desktop' as const,
      desktopPort: 41234,
      deviceName: 'Laptop',
      desktopChallenge: 'ch',
      invite: null,
    };
    await a.putOidcState(pending, HOUR);
    await a.putOidcState({ ...pending, state: 'st-old' }, -1);
    expect(await a.takeOidcState('st-1')).toEqual(pending);
    expect(await a.takeOidcState('st-1')).toBeNull();
    expect(await a.takeOidcState('st-old')).toBeNull();

    const user = (await a.userByEmail('ada@lab.io'))!;
    const code = { userId: user.id, deviceName: 'Laptop', challenge: 'ch' };
    await a.putAuthCode({ ...code, code: 'code-1', ttlMs: HOUR });
    await a.putAuthCode({ ...code, code: 'code-old', ttlMs: -1 });
    expect(await a.takeAuthCode('code-1')).toEqual(code);
    expect(await a.takeAuthCode('code-1')).toBeNull();
    expect(await a.takeAuthCode('code-old')).toBeNull();
  });

  it('keeps per-user settings', async () => {
    const a = store.accounts;
    const user = await a.createUser({ email: 'set@lab.io', name: 'S', passwordHash: null });
    await a.setSetting(user!.id, 'ui.theme', 'dark');
    await a.setSetting(user!.id, 'w1:ui.tabs', { tabs: [1, 2] });
    await a.setSetting(user!.id, 'ui.theme', 'light');
    expect(await a.settings(user!.id)).toEqual({
      'ui.theme': 'light',
      'w1:ui.tabs': { tabs: [1, 2] },
    });
    await a.setSetting(user!.id, 'ui.theme', null);
    expect(await a.settings(user!.id)).toEqual({ 'w1:ui.tabs': { tabs: [1, 2] } });
    expect(await a.settingCount(user!.id)).toBe(1);
  });
});
