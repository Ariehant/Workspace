import { describe, expect, it } from 'vitest';
import { SyncHub, type Access, type DocPolicy } from './hub';
import type { AccessScope } from './messages';
import { MemoryLogStore } from './memory';
import { TestNet, seeded, sleep, until } from './test-net';
import { DOC_IDS, Replica, contents, contentsOf } from './test-replica';

const WS = 'ws-1';

/** JSON with sorted keys (map entries come out in any order). */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

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

/**
 * The same, with access: device C may read `page-c` only some of the time (the access
 * flips during the run, while C is connected or offline), and may never change `page-b`
 * (its edits there are refused and undone). In the end A and B match the server on every
 * doc, and C on exactly the docs it may read, without the others.
 */
async function fuzzWithAccess(seed: number, steps: number) {
  const rng = seeded(seed);
  const store = new MemoryLogStore();
  const hubOptions = { batchRows: 7, batchBytes: 600 };
  const net = new TestNet(new SyncHub(store, hubOptions), rng);
  net.duplicate = 0.05;
  const scopeOf = (docId: string) => (docId === 'page-c' ? 'secret' : 'main');
  const scope = (id: string): AccessScope => ({
    id,
    kind: 'teamspace',
    name: id,
    treeDoc: id === 'main' ? 'workspace' : `tree:${id}`,
    parent: '',
    role: 'edit',
  });
  let cSees = rng() < 0.5;
  const cAccess = (): Access & { policy: DocPolicy; scopes: AccessScope[] } => {
    const sees = cSees;
    const readable = (docId: string) => sees || scopeOf(docId) === 'main';
    const scopes = sees ? [scope('main'), scope('secret')] : [scope('main')];
    return {
      scopes,
      policy: {
        canRead: readable,
        canWrite: (docId) => readable(docId) && docId !== 'page-b',
      },
      reconcile: async (known) => {
        const now = new Set(scopes.map((s) => s.id));
        const had = new Set(known);
        const docsIn = (ids: string[]) => DOC_IDS.filter((d) => ids.includes(scopeOf(d)));
        const lostScopes = [...had].filter((id) => !now.has(id));
        return {
          gained: docsIn([...now].filter((id) => !had.has(id))),
          lost: docsIn(lostScopes),
          lostScopes,
        };
      },
    };
  };
  const replicas = [
    new Replica('A', net, WS, rng),
    new Replica('B', net, WS, rng),
    new Replica('C', net, WS, rng, cAccess),
  ];
  const c = replicas[2]!;
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
    } else if (r < 0.6) {
      // C's access to page-c flips; its connected sockets hear about it now.
      cSees = !cSees;
      const access = cAccess();
      for (const link of net.linksOf('C')) {
        link.connection?.reauthorize({
          policy: access.policy,
          scopes: access.scopes,
          gained: cSees ? ['page-c'] : [],
          lost: cSees ? [] : ['page-c'],
          lostScopes: cSees ? [] : ['secret'],
          reconcile: access.reconcile,
        });
      }
    } else if (r < 0.67) {
      for (const link of net.linksOf(replica.id)) link.cut();
      if (rng() < 0.5) {
        net.offline.add(replica.id);
        offlineFor.set(replica.id, 5 + Math.floor(rng() * 30));
      }
    } else if (r < 0.69) {
      net.restart(new SyncHub(store, hubOptions));
    } else if (r < 0.72) {
      store.compact(WS, DOC_IDS[Math.floor(rng() * DOC_IDS.length)]!);
      net.hub.notify(WS);
    } else {
      await sleep(rng() < 0.5 ? 0 : 1);
    }
  }

  net.offline.clear();
  net.duplicate = 0;
  for (const r of replicas) r.client.retryNow();
  const latest = () =>
    (store as unknown as { logs: Map<string, { last: number }> }).logs.get(WS)?.last ?? 0;
  const readable = (docId: string) => cSees || scopeOf(docId) === 'main';
  const matches = async () => {
    for (const docId of DOC_IDS) {
      const server = canonical(contentsOf(await store.docState(WS, docId)));
      for (const r of replicas) {
        if (r === c && !readable(docId)) {
          if (c.docs.has(docId)) return false;
          continue;
        }
        if (canonical(contents(r.doc(docId))) !== server) return false;
      }
    }
    return true;
  };
  const start = Date.now();
  for (;;) {
    const settled = replicas.every(
      (r) => r.client.state.state === 'live' && r.outbox.length === 0 && r.cursor === latest(),
    );
    if (settled && (await matches())) break;
    if (Date.now() - start > 20_000) break;
    await sleep(5);
  }

  for (const docId of DOC_IDS) {
    const server = contentsOf(await store.docState(WS, docId));
    for (const r of replicas) {
      if (r === c && !readable(docId)) {
        expect(c.docs.has(docId), `seed ${seed}: C still has ${docId}`).toBe(false);
        continue;
      }
      if (canonical(contents(r.doc(docId))) !== canonical(server)) {
        console.log(explain(seed, docId, r, store, server));
      }
      expect(contents(r.doc(docId)), `seed ${seed}, ${docId} on ${r.id}`).toEqual(server);
    }
  }
  expect(c.known.includes('secret'), `seed ${seed}: C's known scopes`).toBe(cSees);
  for (const r of replicas) r.client.stop();
  return { resets: c.resets };
}

/** What a replica saw of a doc, and the server's rows of it (for a failed run). */
function explain(
  seed: number,
  docId: string,
  replica: Replica,
  store: MemoryLogStore,
  server: unknown,
): string {
  type Row = { seq: number; docId: string; deviceId: string | null; data: Uint8Array };
  const logs = (store as unknown as { logs: Map<string, { rows: Row[] }> }).logs;
  const rows = (logs.get(WS)?.rows ?? [])
    .filter((row) => row.docId === docId)
    .map((row) => `${row.seq} ${row.deviceId} ${JSON.stringify(contentsOf(row.data).t)}`);
  const seen = replica.trace.filter(
    (line) => line.includes(docId) || line.startsWith('access') || line.startsWith('revoke'),
  );
  return [
    `seed ${seed}: ${docId} on ${replica.id}`,
    ...seen,
    'server rows:',
    ...rows,
    `here:   ${canonical(contents(replica.doc(docId)))}`,
    `server: ${canonical(server)}`,
  ].join('\n');
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

  it('converges with access: filtered reads, refused writes undone, access gained and lost', async () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    const seeds = Number(env?.SYNC_FUZZ_SEEDS ?? 25);
    let resets = 0;
    const first = Number(env?.SYNC_FUZZ_FIRST ?? 1);
    for (let seed = first; seed < first + seeds; seed++) {
      resets += (await fuzzWithAccess(seed, 400)).resets;
    }
    // C's refused edits really happened (and were undone).
    expect(resets).toBeGreaterThan(seeds);
  }, 120_000);
});
