/** A device for tests: Yjs docs in memory, an outbox and a cursor, driven by a SyncClient. */
import * as Y from 'yjs';
import { SyncClient, type ClientStore, type OutboxEntry } from './client';
import type { Access } from './hub';
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
  /** Scopes this device holds (from the server's last `access`). */
  known: string[] = [];
  resets = 0;
  /** What happened here, for debugging a failed run. */
  readonly trace: string[] = [];
  readonly client: SyncClient;

  constructor(
    readonly id: string,
    net: TestNet,
    workspaceId: string,
    rng: Rng,
    access?: () => Access,
  ) {
    const store: ClientStore = {
      cursor: () => this.cursor,
      pending: (limit) => this.outbox.slice(0, limit),
      denied: (items) => {
        this.trace.push(`denied ${items.map((i) => i.docId).join(',')}`);
      },
      acknowledge: (ids) => {
        const done = new Set(ids);
        this.outbox = this.outbox.filter((e) => !done.has(e.localId));
      },
      applyRemote: (items, cursor) => {
        for (const item of items) {
          this.trace.push(
            `updates ${item.docId} ${JSON.stringify(contentsOf(item.update).t)} @${cursor}`,
          );
          Y.applyUpdate(this.doc(item.docId), item.update, REMOTE);
        }
        if (cursor < this.cursor) this.cursorRegressions++;
        this.cursor = cursor;
      },
      // The server refused an edit: start that doc over from its copy.
      reset: (docId, state) => {
        this.trace.push(`reset ${docId}`);
        this.resets++;
        this.docs.get(docId)?.destroy();
        this.docs.delete(docId);
        Y.applyUpdate(this.doc(docId), state, REMOTE);
      },
      applyBackfill: (items) => {
        for (const item of items) {
          this.trace.push(`backfill ${item.docId} ${JSON.stringify(contentsOf(item.update).t)}`);
          Y.applyUpdate(this.doc(item.docId), item.update, REMOTE);
        }
      },
      revoke: (docIds, scopes) => {
        this.trace.push(`revoke ${docIds.join(',')} [${scopes.join(',')}]`);
        this.known = this.known.filter((id) => !scopes.includes(id));
        for (const id of docIds) {
          this.docs.get(id)?.destroy();
          this.docs.delete(id);
        }
        this.outbox = this.outbox.filter((e) => !docIds.includes(e.docId));
      },
      setAccess: (scopes) => {
        this.trace.push(`access ${scopes.map((s) => s.id).join(',')}`);
        this.known = scopes.map((s) => s.id);
      },
      knownScopes: () => this.known,
    };
    this.client = new SyncClient({
      store,
      deviceId: id,
      connect: net.connector(id, workspaceId, access ?? {}),
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
    const docId = DOC_IDS[Math.floor(rng() * DOC_IDS.length)]!;
    const doc = this.doc(docId);
    const text = doc.getText('t');
    const map = doc.getMap('m');
    const r = rng();
    if (r < 0.5 || text.length === 0) {
      const at = Math.floor(rng() * (text.length + 1));
      const word = `${this.id}${Math.floor(rng() * 100)} `;
      text.insert(at, word);
      this.trace.push(`edit ${docId} +${JSON.stringify(word)}`);
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
