import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';

let dir: string;
let store: PgStore;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-web-'));
  mkdirSync(join(dir, 'web', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>Workspace</title>');
  writeFileSync(join(dir, 'web', 'assets', 'app-1234.js'), 'console.log(1)');
  store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 4 });
  await store.migrate();
});
afterAll(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const server = (webDir: string | null) =>
  buildServer({
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      LOG_LEVEL: 'silent',
      FILES_DIR: join(dir, 'files'),
      SIGNUP: 'open',
      ...(webDir ? { WEB_DIR: webDir } : {}),
    }),
    store,
    files: new FsStorage(join(dir, 'files')),
  });

describe('web app', () => {
  it('serves the build, with index.html for app routes and JSON 404s for the API', async () => {
    const app = server(join(dir, 'web'));
    const root = await app.inject({ url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Workspace</title>');
    expect(root.headers['x-frame-options']).toBe('DENY');
    expect(root.headers['cache-control']).toBe('no-cache');
    const route = await app.inject({ url: '/w/5d1c/anything?x=1' });
    expect(route.body).toContain('<title>Workspace</title>');
    const asset = await app.inject({ url: '/assets/app-1234.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toContain('immutable');
    const api = await app.inject({ url: '/api/nothing' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('not_found');
    expect(
      (await app.inject({ method: 'POST', url: '/w/x', headers: { 'x-workspace-client': 't' } }))
        .statusCode,
    ).toBe(404);
    await app.close();

    const without = server(null);
    expect((await without.inject({ url: '/' })).statusCode).toBe(404);
    await without.close();
  });

  it('keeps per-user settings, and says where pages live', async () => {
    const app = server(null);
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 't' },
      payload: { email: 'web@lab.io', name: 'Web', password: 'long password' },
    });
    const cookie = signup.cookies.find((c) => c.name === 'ws_session')!.value;
    const as = { cookie: `ws_session=${cookie}`, 'x-workspace-client': 'web' };
    const put = (key: string, value: unknown, headers: Record<string, string> = as) =>
      app.inject({ method: 'PUT', url: `/api/settings/${key}`, payload: { value }, headers });

    expect((await put('ui.theme', 'dark')).statusCode).toBe(200);
    expect((await put('ws-1:ui.tabs', { tabs: [], active: 0 })).statusCode).toBe(200);
    const all = await app.inject({ url: '/api/settings', headers: as });
    expect(all.json()).toEqual({
      settings: { 'ui.theme': 'dark', 'ws-1:ui.tabs': { tabs: [], active: 0 } },
    });
    await put('ui.theme', null);
    expect(
      Object.keys((await app.inject({ url: '/api/settings', headers: as })).json().settings),
    ).toEqual(['ws-1:ui.tabs']);
    expect((await put('bad key!', 1)).statusCode).toBe(400);
    expect((await put('big', 'x'.repeat(70_000))).statusCode).toBe(413);
    // The cookie alone (a cross-site form) can't change them.
    expect((await put('ui.theme', 'dark', { cookie: as.cookie })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/settings' })).statusCode).toBe(401);

    const user = signup.json().user.id as string;
    const ws = await store.createWorkspace('W', user);
    // The workspace's first scope (the creator may read it).
    const scope = (await store.scopes.model(ws.id)).defaultScopeId;
    await store.search.setPages(ws.id, scope, [
      { id: 'db', title: 'Parts', icon: null, inTrash: false, updatedAt: 1 },
    ]);
    await store.search.setRows(ws.id, 'db', scope, [
      { id: 'row', title: 'Servo', icon: null, inTrash: false, updatedAt: 1, props: '' },
    ]);
    const where = (id: string) =>
      app.inject({ url: `/api/workspaces/${ws.id}/pages/${id}/location`, headers: as });
    expect((await where('row')).json()).toEqual({ databaseId: 'db' });
    expect((await where('db')).json()).toEqual({ databaseId: null });
    expect((await where('unknown')).statusCode).toBe(404);
    await app.close();
  });
});
