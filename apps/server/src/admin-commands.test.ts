import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { runAdmin } from './admin-commands';
import { verifyPassword } from './auth/passwords';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 2 });
  await store.migrate();
});
afterAll(() => store.close());

async function run(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runAdmin(store, argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, out, err };
}

describe('workspace-admin', () => {
  it('creates users with generated passwords and resets them', async () => {
    const created = await run('create-user', 'ada@lab.io', 'Ada', 'Lovelace');
    expect(created.code).toBe(0);
    expect(created.out[0]).toBe('Created ada@lab.io (admin)');
    const password = created.out[1]!.replace('Password: ', '');
    const ada = await store.accounts.userByEmail('ada@lab.io');
    expect(ada?.name).toBe('Ada Lovelace');
    expect(await verifyPassword(password, ada!.passwordHash!)).toBe(true);

    expect((await run('create-user', 'ada@lab.io')).code).toBe(1);
    expect((await run('create-user', 'not-an-email')).code).toBe(1);
    const bob = await run('create-user', 'bob@lab.io', '--admin');
    expect(bob.out[0]).toBe('Created bob@lab.io (admin)');
    expect((await store.accounts.userByEmail('bob@lab.io'))?.isAdmin).toBe(true);

    await store.accounts.createSession({
      userId: ada!.id,
      token: 'live',
      kind: 'web',
      deviceName: '',
      ttlMs: 60_000,
    });
    const reset = await run('reset-password', 'ADA@lab.io');
    const next = reset.out[0]!.split(': ')[1]!;
    expect(next).not.toBe(password);
    const after = await store.accounts.userByEmail('ada@lab.io');
    expect(await verifyPassword(next, after!.passwordHash!)).toBe(true);
    expect(await store.accounts.sessionByToken('live')).toBeNull();
    expect((await run('reset-password', 'nobody@lab.io')).err).toEqual([
      'No account for nobody@lab.io.',
    ]);
  });

  it('makes invites, lists, disables and promotes users', async () => {
    const invite = await run('create-invite', 'carol@lab.io', '--days', '3');
    expect(invite.out[0]).toBe('Invite code (valid 3 days, for carol@lab.io):');
    expect(await store.accounts.inviteValid(invite.out[1]!, 'carol@lab.io')).toBe(true);
    expect(await store.accounts.inviteValid(invite.out[1]!, 'dave@lab.io')).toBe(false);
    expect((await run('create-invite', '--days', '365')).code).toBe(1);

    await run('create-user', 'eve@lab.io', 'Eve');
    expect((await run('disable-user', 'eve@lab.io')).out).toEqual(['Disabled eve@lab.io']);
    await run('make-admin', 'eve@lab.io');
    const list = (await run('list-users')).out;
    expect(list).toContain('eve@lab.io\tEve\t(admin, disabled)');
    await run('enable-user', 'eve@lab.io');
    expect((await run('list-users')).out).toContain('eve@lab.io\tEve\t(admin)');
  });

  it('lists workspaces and knows its commands', async () => {
    const owner = await store.accounts.userByEmail('ada@lab.io');
    const ws = await store.createWorkspace('Lab', owner!.id);
    const { out } = await run('list-workspaces');
    expect(out).toContain(`${ws.id}\tLab\t1 members\t0 updates\t0.0 MB`);
    expect((await run('migrate')).out).toEqual(['Schema at version 10']);
    expect((await run('compact')).out).toEqual(['Compacted 0 docs']);
    const unknown = await run('frobnicate');
    expect(unknown.code).toBe(1);
    expect(unknown.err[0]).toContain('Usage: workspace-admin');
  });
});
