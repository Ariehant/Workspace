/**
 * The Unsplash cover gallery (Phase 7 M6), against a stand-in for Unsplash's API: searches
 * go through the server with its key, picks are reported, and it's off without a key.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';

const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** Unsplash, as far as the server uses it; it records what it's asked. */
async function fakeUnsplash() {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    const url = new URL(req.url!, 'http://x');
    if (url.pathname === '/search/photos') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: [
            {
              id: 'p1',
              description: null,
              alt_description: 'A robot arm',
              urls: {
                small: 'https://images.example/p1?w=400',
                regular: 'https://images.example/p1?w=1080',
                raw: 'https://images.example/p1?ixid=abc',
              },
              user: { name: 'Ada Lens', links: { html: 'https://unsplash.example/@ada' } },
              links: { download_location: `${base}/photos/p1/download?ixid=abc` },
            },
          ],
        }),
      );
    } else if (url.pathname === '/photos/p1/download') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"url":"x"}');
    } else res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return { base, seen };
}

async function serverWith(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-unsplash-'));
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 4 });
  await store.migrate();
  const app = buildServer({
    config: loadConfig({
      DATABASE_URL: 'postgres://unused',
      LOG_LEVEL: 'silent',
      FILES_DIR: dir,
      SIGNUP: 'open',
      PUBLIC_URL: 'http://app.test',
      ...env,
    }),
    store,
    files: new FsStorage(dir),
    mailer: null,
  });
  cleanups.push(
    () => app.close(),
    () => store.close(),
    () => rmSync(dir, { recursive: true, force: true }),
  );
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'x-workspace-client': 'test' },
    payload: { email: 'ada@lab.io', name: 'Ada', password: 'long password', client: 'desktop' },
  });
  const token = signup.json().token as string;
  const call = (method: 'GET' | 'POST', url: string, payload?: object, auth = true) =>
    app.inject({
      method,
      url,
      payload,
      headers: auth ? { authorization: `Bearer ${token}` } : {},
    });
  return { app, call };
}

describe('Unsplash covers', () => {
  it('search through the server with its key, and report picks', async () => {
    const unsplash = await fakeUnsplash();
    const { call } = await serverWith({
      UNSPLASH_ACCESS_KEY: 'secret-key',
      UNSPLASH_API_URL: unsplash.base,
    });
    expect((await call('GET', '/api/auth/config')).json()).toMatchObject({ unsplash: true });

    const found = await call('GET', '/api/unsplash/photos?query=robot%20arm');
    expect(found.statusCode).toBe(200);
    expect(found.json().photos).toEqual([
      {
        id: 'p1',
        description: 'A robot arm',
        thumb: 'https://images.example/p1?w=400',
        full: 'https://images.example/p1?ixid=abc&w=2400&q=80&fm=jpg&fit=crop',
        author: 'Ada Lens',
        authorUrl: 'https://unsplash.example/@ada?utm_source=workspace&utm_medium=referral',
        downloadLocation: `${unsplash.base}/photos/p1/download?ixid=abc`,
      },
    ]);
    const search = unsplash.seen.at(-1)!;
    expect(search.headers.authorization).toBe('Client-ID secret-key');
    expect(new URL(search.url!, 'http://x').searchParams.get('query')).toBe('robot arm');
    // The key never reaches the browser.
    expect(found.body).not.toContain('secret-key');

    const picked = await call('POST', '/api/unsplash/picked', {
      downloadLocation: `${unsplash.base}/photos/p1/download?ixid=abc`,
    });
    expect(picked.statusCode).toBe(200);
    expect(unsplash.seen.at(-1)!.url).toBe('/photos/p1/download?ixid=abc');
    // Only Unsplash's addresses get the key.
    expect(
      (
        await call('POST', '/api/unsplash/picked', {
          downloadLocation: 'https://evil.example/photos/1',
        })
      ).statusCode,
    ).toBe(400);
    // Signed in only.
    expect((await call('GET', '/api/unsplash/photos?query=x', undefined, false)).statusCode).toBe(
      401,
    );
  });

  it('is off without a key', async () => {
    const { call } = await serverWith({});
    expect((await call('GET', '/api/auth/config')).json()).toMatchObject({ unsplash: false });
    expect((await call('GET', '/api/unsplash/photos?query=x')).statusCode).toBe(404);
  });
});
