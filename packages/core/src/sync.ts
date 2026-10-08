import * as Y from 'yjs';
import type { PresenceChannel, PresenceHandlers, PresenceTransport } from './presence';

/**
 * Moves Yjs updates between a UI process and wherever documents are stored:
 * the Electron main process today, the sync server for the web app later.
 */
export interface DocTransport {
  /** Load a document and return its full state as a single update. */
  open(docId: string): Promise<Uint8Array>;
  /** Send a local update. */
  push(docId: string, update: Uint8Array): void;
  /** Receive updates made elsewhere (other windows, other devices). */
  subscribe(listener: (docId: string, update: Uint8Array) => void): () => void;
  /** The UI no longer needs this document. */
  close(docId: string): void;
  /** Who else is on a doc (hosts that have others to show). */
  presence?: PresenceTransport;
}

export interface DocHandle {
  doc: Y.Doc;
  /** Resolves once the stored state has been applied. */
  ready: Promise<void>;
  release(): void;
}

interface Entry {
  doc: Y.Doc;
  ready: Promise<void>;
  refs: number;
}

/**
 * Keeps one live Y.Doc per document id and wires it to a transport. Handles are
 * reference counted so several views of the same page share one doc.
 *
 * Ordering does not matter: Yjs updates are commutative, so edits made before the
 * stored state arrives, or remote updates that race the initial load, all converge.
 */
export class DocClient {
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribe: () => void;
  /** Origin tag for updates that came from the transport, so they are not echoed back. */
  private readonly remote = Symbol('remote');

  constructor(private readonly transport: DocTransport) {
    this.unsubscribe = transport.subscribe((docId, update) => {
      const entry = this.entries.get(docId);
      if (entry) Y.applyUpdate(entry.doc, update, this.remote);
    });
  }

  /** Join a doc's presence (null if the host has none). */
  joinPresence(docId: string, handlers: PresenceHandlers): PresenceChannel | null {
    return this.transport.presence?.join(docId, handlers) ?? null;
  }

  acquire(docId: string): DocHandle {
    let entry = this.entries.get(docId);
    if (!entry) {
      const doc = new Y.Doc({ guid: docId });
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== this.remote) this.transport.push(docId, update);
      });
      const ready = this.transport.open(docId).then((state) => {
        Y.applyUpdate(doc, state, this.remote);
      });
      entry = { doc, ready, refs: 0 };
      this.entries.set(docId, entry);
    }
    entry.refs++;

    let released = false;
    const current = entry;
    return {
      doc: current.doc,
      ready: current.ready,
      release: () => {
        if (released) return;
        released = true;
        current.refs--;
        if (current.refs === 0 && this.entries.get(docId) === current) {
          this.entries.delete(docId);
          current.doc.destroy();
          this.transport.close(docId);
        }
      },
    };
  }

  destroy(): void {
    this.unsubscribe();
    for (const [docId, entry] of this.entries) {
      entry.doc.destroy();
      this.transport.close(docId);
    }
    this.entries.clear();
  }
}
