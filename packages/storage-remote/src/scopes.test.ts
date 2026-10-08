import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { MIGRATIONS } from './migrations';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

let n = 0;
const user = async (name: string) =>
  (await store.accounts.createUser({
    email: `${name.toLowerCase()}${++n}@lab.io`,
    name,
    passwordHash: null,
  }))!;

describe('Scopes', () => {
  it('a new workspace gets a first scope holding the workspace doc', async () => {
    const ada = await user('Ada');
    const team = await store.createWorkspace('Lab', ada.id);
    const model = await store.scopes.model(team.id);
    expect(model.scopes).toEqual([
      expect.objectContaining({ kind: 'teamspace', name: 'Lab', treeDoc: 'workspace' }),
    ]);
    const [scope] = model.scopes;
    expect(model.defaultScopeId).toBe(scope!.id);
    expect(model.entries.map((e) => [e.principal, e.role]).sort()).toEqual([
      [`user:${ada.id}`, 'full'],
      ['workspace', 'edit'],
    ]);
    expect(await store.scopes.placementOf(team.id, 'workspace')).toBe(scope!.id);

    const mine = await store.createWorkspace('Mine', ada.id, { firstScope: 'private' });
    const own = await store.scopes.model(mine.id);
    expect(own.scopes).toEqual([
      expect.objectContaining({ kind: 'private', ownerId: ada.id, treeDoc: 'workspace' }),
    ]);
    expect(own.entries.map((e) => e.principal)).toEqual([`user:${ada.id}`]);
  });

  it('creates scopes with their tree doc, changes access, and makes private scopes once', async () => {
    const bo = await user('Bo');
    const ws = await store.createWorkspace('W', bo.id);
    const s = store.scopes;
    const eng = await s.create({
      workspaceId: ws.id,
      kind: 'teamspace',
      name: 'Engineering',
      access: [{ principal: `user:${bo.id}`, role: 'full' }],
    });
    expect(eng.treeDoc).toBe(`tree:${eng.id}`);
    expect(await s.placementOf(ws.id, eng.treeDoc)).toBe(eng.id);
    await s.setAccess(eng.id, 'workspace', 'view');
    await s.setAccess(eng.id, 'workspace', 'comment');
    await s.setAccess(eng.id, `user:${bo.id}`, null);
    const model = await s.model(ws.id);
    expect(model.entries.filter((e) => e.scopeId === eng.id)).toEqual([
      { scopeId: eng.id, principal: 'workspace', role: 'comment' },
    ]);
    expect(await s.update(ws.id, eng.id, { name: 'Eng', inherit: false })).toBe(true);
    expect(await s.get(ws.id, eng.id)).toMatchObject({ name: 'Eng', inherit: false });
    const other = await store.createWorkspace('Other', bo.id);
    expect(await s.get(other.id, eng.id)).toBeNull();
    expect(await s.update(other.id, eng.id, { name: 'Stolen' })).toBe(false);

    const p1 = await s.privateScope(ws.id, bo.id);
    const p2 = await s.privateScope(ws.id, bo.id);
    expect(p2.id).toBe(p1.id);
    expect(p1).toMatchObject({ kind: 'private', ownerId: bo.id });
  });

  it('places a doc once, moves docs (recording the move) and keeps search in step', async () => {
    const cy = await user('Cy');
    const ws = await store.createWorkspace('Moves', cy.id);
    const s = store.scopes;
    const home = (await s.model(ws.id)).defaultScopeId!;
    const other = await s.create({ workspaceId: ws.id, kind: 'shared', name: '', access: [] });
    const results = await Promise.all([
      s.place(ws.id, 'page-1', home),
      s.place(ws.id, 'page-1', other.id),
    ]);
    expect(results[0]).toBe(results[1]);
    await s.place(ws.id, 'page-2', home);
    await s.place(ws.id, 'db-1', home);
    await store.search.setPages(ws.id, home, [
      { id: 'page-1', title: 'One', icon: null, inTrash: false, updatedAt: 1 },
    ]);
    await store.search.setRows(ws.id, 'db-1', home, [
      { id: 'row-1', title: 'Row', icon: null, inTrash: false, updatedAt: 1, props: '' },
    ]);

    const first = results[0];
    const to = first === home ? other.id : home;
    const moved = await s.move(ws.id, ['page-1', 'db-1', 'nope'], first, to, 7);
    expect(moved.sort()).toEqual(first === home ? ['db-1', 'page-1'] : ['page-1']);
    expect(await s.placementOf(ws.id, 'page-1')).toBe(to);
    expect(await s.movesSince(ws.id, 6)).toEqual(
      moved.map((docId) => ({ seq: 7, docId, fromScope: first, toScope: to })),
    );
    expect(await s.movesSince(ws.id, 7)).toEqual([]);
    expect((await store.search.search(ws.id, 'one', 20, [to])).map((h) => h.id)).toEqual([
      'page-1',
    ]);
    expect((await s.placements(ws.id)).get('page-2')).toBe(home);
  });

  it('migration 6 makes existing workspaces their owner’s private pages', async () => {
    const url = await createTestDatabase(inject('pgUrl'));
    const pool = new pg.Pool({ connectionString: url });
    await pool.query(
      'CREATE TABLE schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (let v = 0; v < 5; v++) {
      await pool.query(MIGRATIONS[v]!);
      await pool.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v + 1]);
    }
    await pool.query(
      `INSERT INTO users (id, email, name) VALUES
         ('11111111-1111-4111-8111-111111111111', 'o@x.io', 'Owner'),
         ('22222222-2222-4222-8222-222222222222', 'm@x.io', 'Member')`,
    );
    await pool.query(
      `INSERT INTO workspaces (id, name) VALUES ('33333333-3333-4333-8333-333333333333', 'Old')`,
    );
    await pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
         ('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'member'),
         ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', 'owner')`,
    );
    await pool.query(
      `INSERT INTO doc_updates (workspace_id, seq, doc_id, data) VALUES
         ('33333333-3333-4333-8333-333333333333', 1, 'workspace', '\\x00'),
         ('33333333-3333-4333-8333-333333333333', 2, 'page-a', '\\x00'),
         ('33333333-3333-4333-8333-333333333333', 3, 'page-a', '\\x00'),
         ('33333333-3333-4333-8333-333333333333', 4, 'members', '\\x00')`,
    );
    await pool.end();

    const old = new PgStore(url);
    await old.migrate();
    const ws = '33333333-3333-4333-8333-333333333333';
    const model = await old.scopes.model(ws);
    expect(model.scopes).toEqual([
      expect.objectContaining({
        kind: 'private',
        treeDoc: 'workspace',
        ownerId: '11111111-1111-4111-8111-111111111111',
      }),
    ]);
    expect(model.entries).toEqual([
      expect.objectContaining({
        principal: 'user:11111111-1111-4111-8111-111111111111',
        role: 'full',
      }),
    ]);
    const placements = await old.scopes.placements(ws);
    expect([...placements.keys()].sort()).toEqual(['page-a', 'workspace']);
    expect(model.defaultScopeId).toBe(model.scopes[0]!.id);
    await old.close();
  });
});
