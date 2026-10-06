import { describe, expect, it } from 'vitest';
import { SyncHub } from './hub';
import { MemoryLogStore } from './memory';
import { TestNet, seeded, sleep, until } from './test-net';
import { DOC_IDS, Replica, contents, contentsOf } from './test-replica';

const WS = 'ws-1';

/**
 * Three devices make random edits to random docs while the network misbehaves: links
 * drop (losing messages in flight, acks included), devices stay offline for a while and
 * keep editing, messages are duplicated, the server restarts and compacts docs. In the
 * end, every doc must be identical on every device and on the server.
 */
async function fuzz(seed: number, steps: number) {
  const rng = seeded(seed);
  const store = new MemoryLogStore();
  const hubOptions = { batchRows: 7, batchBytes: 600 };
  const net = new TestNet(new SyncHub(store, hubOptions), rng);
  net.duplicate = 0.05;
  const replicas = ['A', 'B', 'C'].map((id) => new Replica(id, net, WS, rng));
  const offlineFor = new Map<string, number>();
  for (const r of replicas) r.client.start();

  for (let step = 0; step < steps; step++) {
    for (const [id, left] of offlineFor) {
      if (left <= 1) {
        offlineFor.delete(id);
        net.offline.delete(id);
      } else offlineFor.set(id, left - 1);
    }
    const r = rng();
    const replica = replicas[Math.floor(rng() * replicas.length)]!;
    if (r < 0.55) {
      replica.edit(rng);
    } else if (r < 0.63) {
      for (const link of net.linksOf(replica.id)) link.cut();
      if (rng() < 0.5) {
        net.offline.add(replica.id);
        offlineFor.set(replica.id, 5 + Math.floor(rng() * 30));
      }
    } else if (r < 0.65) {
      net.restart(new SyncHub(store, hubOptions));
    } else if (r < 0.69) {
      store.compact(WS, DOC_IDS[Math.floor(rng() * DOC_IDS.length)]!);
      net.hub.notify(WS);
    } else {
      await sleep(rng() < 0.5 ? 0 : 1);
    }
  }

  // Heal: everyone online, and wait until everything is delivered and acknowledged.
  net.offline.clear();
  net.duplicate = 0;
  for (const r of replicas) r.client.retryNow();
  const latest = () =>
    (store as unknown as { logs: Map<string, { last: number }> }).logs.get(WS)?.last ?? 0;
  await until(
    () =>
      replicas.every(
        (r) => r.client.state.state === 'live' && r.outbox.length === 0 && r.cursor === latest(),
      ),
    20_000,
    `seed ${seed} to settle`,
  ).catch((error) => {
    const state = replicas.map((r) => ({
      id: r.id,
      state: r.client.state,
      outbox: r.outbox.length,
      cursor: r.cursor,
      links: net.linksOf(r.id).length,
    }));
    throw new Error(`${(error as Error).message}: latest ${latest()} ${JSON.stringify(state)}`);
  });

  for (const docId of DOC_IDS) {
    const server = contentsOf(await store.docState(WS, docId));
    for (const r of replicas) {
      expect(contents(r.doc(docId)), `seed ${seed}, ${docId} on ${r.id}`).toEqual(server);
    }
  }
  for (const r of replicas) {
    expect(r.cursorRegressions, `seed ${seed}: cursor went back on ${r.id}`).toBe(0);
    r.client.stop();
  }
  return { updates: latest() };
}

describe('convergence', () => {
  it('converges under drops, offline edits, duplicates, restarts and compaction', async () => {
    // More seeds with SYNC_FUZZ_SEEDS=200 (the package has no Node types: it runs in browsers too).
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    const seeds = Number(env?.SYNC_FUZZ_SEEDS ?? 25);
    let total = 0;
    for (let seed = 1; seed <= seeds; seed++) total += (await fuzz(seed, 400)).updates;
    // The runs really exercised something.
    expect(total).toBeGreaterThan(seeds * 100);
  }, 120_000);
});
