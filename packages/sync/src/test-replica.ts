/** A device for tests: Yjs docs in memory, an outbox and a cursor, driven by a SyncClient. */
import * as Y from 'yjs';
import { SyncClient, type ClientStore, type OutboxEntry } from './client';
import type { Rng, TestNet } from './test-net';

const REMOTE = Symbol('remote');
export const DOC_IDS = ['workspace', 'page-a', 'page-b', 'page-c', 'db-1'];

export class Replica {
  readonly docs = new Map<string, Y.Doc>();
  outbox: OutboxEntry[] = [];
  cursor = 0;
  private nextId = 1;
  /** Times the server moved this device's cursor backwards (must stay 0). */
  cursorRegressions = 0;
  readonly client: SyncClient;

  constructor(
    readonly id: string,
    net: TestNet,
    workspaceId: string,
    rng: Rng,
  ) {
    const store: ClientStore = {
      cursor: () => this.cursor,
      pending: (limit) => this.outbox.slice(0, limit),
      acknowledge: (ids) => {
        const done = new Set(ids);
        this.outbox = this.outbox.filter((e) => !done.has(e.localId));
      },
      applyRemote: (items, cursor) => {
        for (const item of items) Y.applyUpdate(this.doc(item.docId), item.update, REMOTE);
        if (cursor < this.cursor) this.cursorRegressions++;
        this.cursor = cursor;
      },
    };
    this.client = new SyncClient({
      store,
      deviceId: id,
      connect: net.connector(id, workspaceId),
      backoff: { minMs: 1, maxMs: 15 },
      random: rng,
    });
  }

  doc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) {
      doc = new Y.Doc();
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === REMOTE) return;
        this.outbox.push({ localId: this.nextId++, docId: id, update });
        this.client.flush();
      });
      this.docs.set(id, doc);
    }
    return doc;
  }

  /** A random edit: insert or delete text, or set or delete a map key. */
  edit(rng: Rng) {
    const doc = this.doc(DOC_IDS[Math.floor(rng() * DOC_IDS.length)]!);
    const text = doc.getText('t');
    const map = doc.getMap('m');
    const r = rng();
    if (r < 0.5 || text.length === 0) {
      const at = Math.floor(rng() * (text.length + 1));
      text.insert(at, `${this.id}${Math.floor(rng() * 100)} `);
    } else if (r < 0.7) {
      const at = Math.floor(rng() * text.length);
      text.delete(at, Math.min(text.length - at, 1 + Math.floor(rng() * 5)));
    } else if (r < 0.9) {
      map.set(`k${Math.floor(rng() * 8)}`, `${this.id}:${Math.floor(rng() * 1000)}`);
    } else {
      map.delete(`k${Math.floor(rng() * 8)}`);
    }
  }
}

/** What a doc holds, comparably. */
export const contents = (doc: Y.Doc) => ({
  t: doc.getText('t').toString(),
  m: doc.getMap('m').toJSON(),
});

export function contentsOf(update: Uint8Array | null) {
  const doc = new Y.Doc();
  if (update) Y.applyUpdate(doc, update);
  return contents(doc);
}
