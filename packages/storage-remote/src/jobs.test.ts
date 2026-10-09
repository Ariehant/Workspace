import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
let other: PgStore;
beforeAll(async () => {
  const url = await createTestDatabase(inject('pgUrl'));
  store = new PgStore(url);
  await store.migrate();
  // A second "server" on the same database.
  other = new PgStore(url);
});
afterAll(async () => {
  await other.close();
  await store.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('job queue', () => {
  it('runs due jobs once, in order, and keeps their results', async () => {
    const ws = await store.createWorkspace('W', null);
    const jobs = store.jobs;
    const [later] = await jobs.enqueue([
      { workspaceId: ws.id, kind: 'q1', payload: { n: 2 }, runAt: Date.now() + 60_000 },
    ]);
    const [first] = await jobs.enqueue([{ workspaceId: ws.id, kind: 'q1', payload: { n: 1 } }]);
    const claimed = await jobs.claim(['q1'], 10, 30_000);
    expect(claimed.map((j) => j.id)).toEqual([first]);
    expect(claimed[0]).toMatchObject({ payload: { n: 1 }, attempts: 1 });
    // Locked: nobody else gets it.
    expect(await jobs.claim(['q1'], 10, 30_000)).toEqual([]);
    await jobs.complete(first!, { sent: true });
    expect(await jobs.get(first!)).toMatchObject({ result: { sent: true }, failedAt: null });
    expect((await jobs.get(first!))!.doneAt).not.toBeNull();
    expect((await jobs.get(later!))!.doneAt).toBeNull();
    // Other kinds aren't claimed.
    await jobs.enqueue([{ workspaceId: ws.id, kind: 'q2' }]);
    expect(await jobs.claim(['q1'], 10, 30_000)).toEqual([]);
  });

  it('two servers claiming at once never take the same job', async () => {
    const kind = 'race';
    await store.jobs.enqueue(
      Array.from({ length: 40 }, (_, i) => ({ workspaceId: null, kind, payload: { i } })),
    );
    const takes = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 ? other : store).jobs.claim([kind], 7, 30_000)),
    );
    const ids = takes.flat().map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(40);
  });

  it('retries a failed job later, then gives up when its attempts run out', async () => {
    const jobs = store.jobs;
    const [id] = await jobs.enqueue([{ workspaceId: null, kind: 'flaky', maxAttempts: 2 }]);
    await jobs.claim(['flaky'], 1, 30_000);
    expect(await jobs.fail(id!, 'HTTP 500', Date.now() + 50)).toBe(true);
    expect(await jobs.claim(['flaky'], 1, 30_000)).toEqual([]);
    await sleep(80);
    const again = await jobs.claim(['flaky'], 1, 30_000);
    expect(again[0]).toMatchObject({ id, attempts: 2, lastError: 'HTTP 500' });
    expect(await jobs.fail(id!, 'HTTP 500 again', Date.now())).toBe(false);
    expect((await jobs.get(id!))!.failedAt).not.toBeNull();
    // And a job can be given up on at once.
    const [bad] = await jobs.enqueue([{ workspaceId: null, kind: 'bad' }]);
    await jobs.claim(['bad'], 1, 30_000);
    expect(await jobs.fail(bad!, 'Invalid URL', null)).toBe(false);
  });

  it('runs a job again when its worker died (the lock ran out)', async () => {
    const jobs = store.jobs;
    const [id] = await jobs.enqueue([{ workspaceId: null, kind: 'crash', maxAttempts: 2 }]);
    expect(await jobs.claim(['crash'], 1, 50)).toHaveLength(1);
    await sleep(80);
    expect((await jobs.claim(['crash'], 1, 50))[0]).toMatchObject({ id, attempts: 2 });
    // The last attempt dies too: housekeeping marks it failed.
    await sleep(80);
    expect(await jobs.claim(['crash'], 1, 50)).toEqual([]);
    await jobs.cleanup(0);
    expect(await jobs.get(id!)).toMatchObject({ lastError: 'Stopped while running' });
  });

  it('keeps one open job per key; a finished one frees the key', async () => {
    const jobs = store.jobs;
    const job = { workspaceId: null, kind: 'tick', key: 'schedule:a' };
    const [a] = await jobs.enqueue([job]);
    expect(await jobs.enqueue([job])).toEqual([]);
    await jobs.claim(['tick'], 1, 30_000);
    await jobs.complete(a!);
    expect(await jobs.enqueue([job])).toHaveLength(1);
  });

  it('enqueues inside a transaction, or not at all', async () => {
    await expect(
      store.transaction(async (client) => {
        await store.jobs.enqueue([{ workspaceId: null, kind: 'tx' }], client);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');
    expect(await store.jobs.claim(['tx'], 10, 1000)).toEqual([]);
    await store.transaction((client) =>
      store.jobs.enqueue([{ workspaceId: null, kind: 'tx' }], client),
    );
    expect(await store.jobs.claim(['tx'], 10, 1000)).toHaveLength(1);
  });

  it('deletes finished jobs after a while', async () => {
    const jobs = store.jobs;
    const [id] = await jobs.enqueue([{ workspaceId: null, kind: 'old' }]);
    await jobs.claim(['old'], 1, 1000);
    await jobs.complete(id!);
    expect(await jobs.cleanup(Date.now() - 60_000)).toBe(0);
    expect(await jobs.cleanup(Date.now() + 1000)).toBeGreaterThanOrEqual(1);
    expect(await jobs.get(id!)).toBeNull();
  });

  it('lists recent jobs of a kind for a workspace', async () => {
    const ws = await store.createWorkspace('R', null);
    await store.jobs.enqueue([
      { workspaceId: ws.id, kind: 'run', payload: { n: 1 } },
      { workspaceId: ws.id, kind: 'run', payload: { n: 2 } },
      { workspaceId: ws.id, kind: 'other' },
    ]);
    const recent = await store.jobs.recent(ws.id, 'run');
    expect(recent.map((j) => j.payload)).toHaveLength(2);
  });
});
