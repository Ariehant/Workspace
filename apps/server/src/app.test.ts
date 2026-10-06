import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage, fileKey } from './files';

let dir: string;
let store: PgStore;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-server-'));
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = () =>
  loadConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent', FILES_DIR: dir });

describe('server', () => {
  it('answers health and readiness', async () => {
    const app = buildServer({ config: config(), store, files: new FsStorage(dir) });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, version: '0.1.0' });
    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true, checks: { database: 'ok', files: 'ok' } });
    await app.close();
  });

  it('is not ready when the database is down', async () => {
    const down = new PgStore('postgres://postgres@127.0.0.1:1/none');
    const app = buildServer({ config: config(), store: down, files: new FsStorage(dir) });
    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.files).toBe('ok');
    expect(ready.json().checks.database).not.toBe('ok');
    await app.close();
    await down.close();
  });
});

describe('file storage (folder)', () => {
  it('stores, reads and deletes files by workspace and id', async () => {
    const files = new FsStorage(dir);
    const key = fileKey('8d5f0a39-4a43-4f6b-9a8e-2f0c1f3c5d6e', `${'a'.repeat(64)}.png`);
    expect(await files.has(key)).toBe(false);
    await files.put(key, new Uint8Array([1, 2, 3]), 'image/png');
    expect(await files.has(key)).toBe(true);
    const got = await files.get(key);
    expect(got?.size).toBe(3);
    const chunks: Buffer[] = [];
    for await (const chunk of got!.body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    await files.delete(key);
    expect(await files.get(key)).toBeNull();
  });

  it('rejects keys that could leave the folder', async () => {
    expect(() => fileKey('../etc', 'passwd')).toThrow();
    expect(() => fileKey('8d5f0a39-4a43-4f6b-9a8e-2f0c1f3c5d6e', '../../x')).toThrow();
    await expect(new FsStorage(dir).put('../escape', new Uint8Array(), 'x')).rejects.toThrow();
  });
});
