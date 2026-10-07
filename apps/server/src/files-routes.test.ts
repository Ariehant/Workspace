import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';

let dir: string;
const cleanups: (() => Promise<unknown>)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-files-'));
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

const idOf = (bytes: Buffer, ext = '.png') =>
  `${createHash('sha256').update(bytes).digest('hex')}${ext}`;

async function setup() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 4 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: join(dir, 'files'),
    SIGNUP: 'open',
    MAX_FILE_MB: '1',
  });
  const app = buildServer({ config, store, files: new FsStorage(join(dir, 'files')) });
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const signup = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 't' },
      payload: { email, name: email, password: 'long password', client: 'desktop' },
    });
    return { token: res.json().token as string, id: res.json().user.id as string };
  };
  const ada = await signup('ada@lab.io');
  const ws = await store.createWorkspace('Lab', ada.id);
  const url = (fileId: string, workspace = ws.id) => `/api/workspaces/${workspace}/files/${fileId}`;
  const put = (fileId: string, bytes: Buffer, token = ada.token, headers = {}) =>
    app.inject({
      method: 'PUT',
      url: url(fileId),
      payload: bytes,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent('Gripper drawing é.png'),
        'x-file-mime': 'image/png',
        ...headers,
      },
    });
  const get = (fileId: string, token = ada.token, method: 'GET' | 'HEAD' = 'GET') =>
    app.inject({ method, url: url(fileId), headers: { authorization: `Bearer ${token}` } });
  return { app, store, ws, ada, signup, put, get, url };
}

describe('attachments API', () => {
  it('uploads once, checks the hash, and serves the file back', async () => {
    const s = await setup();
    const bytes = Buffer.from('fake png bytes');
    const id = idOf(bytes);
    expect((await s.get(id, s.ada.token, 'HEAD')).statusCode).toBe(404);

    const created = await s.put(id, bytes);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id, existed: false });
    expect((await s.put(id, bytes)).json()).toEqual({ id, existed: true });

    const res = await s.get(id);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(bytes)).toBe(true);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      etag: `"${id}"`,
    });
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(decodeURIComponent(res.headers['x-file-name'] as string)).toBe('Gripper drawing é.png');
    expect((await s.get(id, s.ada.token, 'HEAD')).statusCode).toBe(200);
    const usage = await s.app.inject({
      url: `/api/workspaces/${s.ws.id}/storage`,
      headers: { authorization: `Bearer ${s.ada.token}` },
    });
    expect(usage.json()).toEqual({ bytes: bytes.length });

    // Content that doesn't match the id is refused.
    const other = idOf(Buffer.from('something else'));
    expect((await s.put(other, bytes)).json().error).toBe('hash_mismatch');
    expect((await s.get(other)).statusCode).toBe(404);
  });

  it('refuses outsiders, guests, other content types and large files', async () => {
    const s = await setup();
    const bytes = Buffer.from('x');
    const id = idOf(bytes);
    await s.put(id, bytes);
    const bob = await s.signup('bob@lab.io');
    expect((await s.get(id, bob.token)).statusCode).toBe(404);
    expect((await s.put(id, bytes, bob.token)).statusCode).toBe(404);
    expect((await s.app.inject({ url: s.url(id) })).statusCode).toBe(401);

    await s.store.pool.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'guest')`,
      [s.ws.id, bob.id],
    );
    expect((await s.get(id, bob.token)).statusCode).toBe(200);
    const mine = Buffer.from('guest file');
    expect((await s.put(idOf(mine), mine, bob.token)).statusCode).toBe(403);

    expect(
      (await s.put(idOf(mine), mine, s.ada.token, { 'content-type': 'image/png' })).statusCode,
    ).toBe(415);
    const big = Buffer.alloc(1.5 * 1024 * 1024, 1);
    const tooBig = await s.put(idOf(big), big);
    expect(tooBig.statusCode).toBe(413);
    expect((await s.get(idOf(big))).statusCode).toBe(404);
    expect((await s.get('not-a-file-id')).statusCode).toBe(400);
  });

  it('never serves active content inline', async () => {
    const s = await setup();
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const id = idOf(svg, '.svg');
    await s.put(id, svg, s.ada.token, { 'x-file-mime': 'image/svg+xml' });
    const res = await s.get(id);
    expect(res.headers['content-disposition']).toMatch(/^attachment;/);
  });
});
