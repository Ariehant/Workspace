import { describe, expect, it } from 'vitest';
import { TokenBucket, WorkspaceApiError, WorkspaceClient, normaliseServer } from './client';

/** A fake clock whose `sleep` moves time forward at once. */
function clock(start = 1_000_000) {
  let now = start;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('the token bucket', () => {
  it('lets a burst through, then 3 a second', async () => {
    const c = clock();
    const bucket = new TokenBucket(3, 30, c.now, c.sleep);
    for (let i = 0; i < 30; i++) await bucket.take();
    expect(c.sleeps).toEqual([]);
    const before = c.now();
    for (let i = 0; i < 3; i++) await bucket.take();
    expect(c.now() - before).toBeGreaterThanOrEqual(999);
    expect(c.now() - before).toBeLessThanOrEqual(1002);
  });
});

describe('the client', () => {
  it('sends the token and the Notion-Version header', async () => {
    const f = fakeFetch(() => json({ object: 'user', id: 'bot' }));
    const client = new WorkspaceClient({
      server: 'notes.example.com/',
      token: 'ntn_x',
      fetch: f.fn,
    });
    await client.request('GET', '/users/me');
    expect(f.calls[0]!.url).toBe('https://notes.example.com/v1/users/me');
    expect(f.calls[0]!.init.headers).toMatchObject({
      authorization: 'Bearer ntn_x',
      'notion-version': '2022-06-28',
    });
  });

  it('waits for Retry-After on a 429, then retries', async () => {
    const c = clock();
    let n = 0;
    const f = fakeFetch(() =>
      ++n === 1
        ? json({ object: 'error', status: 429, code: 'rate_limited', message: 'slow' }, 429, {
            'retry-after': '2',
          })
        : json({ object: 'list', results: [], has_more: false, next_cursor: null }),
    );
    const client = new WorkspaceClient({
      server: 'https://w.test',
      token: 't',
      fetch: f.fn,
      now: c.now,
      sleep: c.sleep,
    });
    await client.request('POST', '/search', {});
    expect(f.calls).toHaveLength(2);
    expect(c.sleeps).toContain(2000);
  });

  it('gives up after too many 429s, with rate_limited', async () => {
    const c = clock();
    const f = fakeFetch(() =>
      json({ object: 'error', status: 429, code: 'rate_limited', message: 'slow' }, 429, {
        'retry-after': '1',
      }),
    );
    const client = new WorkspaceClient({
      server: 'https://w.test',
      token: 't',
      fetch: f.fn,
      now: c.now,
      sleep: c.sleep,
      maxRetries: 2,
    });
    await expect(client.request('GET', '/users/me')).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(f.calls).toHaveLength(3);
  });

  it('reads every page of a list, and the server time of the first', async () => {
    const f = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { start_cursor?: string };
      return body.start_cursor === 'c2'
        ? json({ object: 'list', results: [3], has_more: false, next_cursor: null })
        : json({ object: 'list', results: [1, 2], has_more: true, next_cursor: 'c2' }, 200, {
            date: 'Sun, 22 Nov 2026 10:00:00 GMT',
          });
    });
    const client = new WorkspaceClient({ server: 'https://w.test', token: 't', fetch: f.fn });
    const { results, serverTime } = await client.all<number>('POST', '/databases/d/query', {
      filter: { x: 1 },
    });
    expect(results).toEqual([1, 2, 3]);
    expect(serverTime).toBe(Date.parse('2026-11-22T10:00:00Z'));
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual({
      filter: { x: 1 },
      page_size: 100,
      start_cursor: 'c2',
    });
  });

  it('pages a GET list through the query string', async () => {
    const f = fakeFetch((url) =>
      url.includes('start_cursor=c2')
        ? json({ object: 'list', results: ['b'], has_more: false, next_cursor: null })
        : json({ object: 'list', results: ['a'], has_more: true, next_cursor: 'c2' }),
    );
    const client = new WorkspaceClient({ server: 'https://w.test', token: 't', fetch: f.fn });
    expect((await client.all<string>('GET', '/users')).results).toEqual(['a', 'b']);
    expect(f.calls[0]!.url).toBe('https://w.test/v1/users?page_size=100');
  });

  it('explains a bad token, an unreachable server, and a server that is not Workspace', async () => {
    const bad = new WorkspaceClient({
      server: 'https://w.test',
      token: 'ntn_secret',
      fetch: fakeFetch(() =>
        json(
          { object: 'error', status: 401, code: 'unauthorized', message: 'API token is invalid.' },
          401,
        ),
      ).fn,
    });
    const error = await bad.request('GET', '/users/me').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error).toMatchObject({ code: 'unauthorized', status: 401 });
    expect((error as Error).message).not.toContain('ntn_secret');

    const down = new WorkspaceClient({
      server: 'https://w.test',
      token: 't',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    await expect(down.request('GET', '/users/me')).rejects.toMatchObject({
      code: 'network',
      message: "Can't reach w.test.",
    });

    const other = new WorkspaceClient({
      server: 'https://w.test',
      token: 't',
      fetch: fakeFetch(() => new Response('<html>hello</html>', { status: 200 })).fn,
    });
    await expect(other.request('GET', '/users/me')).rejects.toMatchObject({
      code: 'not_workspace',
    });
  });

  it('passes the server message through for other errors', async () => {
    const client = new WorkspaceClient({
      server: 'https://w.test',
      token: 't',
      fetch: fakeFetch(() =>
        json(
          { object: 'error', status: 400, code: 'validation_error', message: 'No property "x1".' },
          400,
        ),
      ).fn,
    });
    await expect(client.request('POST', '/databases/d/query', {})).rejects.toMatchObject({
      code: 'validation_error',
      message: 'No property "x1".',
    });
  });
});

describe('server addresses', () => {
  it('adds https and drops a trailing slash', () => {
    expect(normaliseServer(' notes.example.com/ ')).toBe('https://notes.example.com');
    expect(normaliseServer('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(normaliseServer('https://example.com/workspace/')).toBe('https://example.com/workspace');
    expect(() => normaliseServer('ftp://x')).toThrow('https://');
  });
});
