/**
 * Offline storage for the web app: the docs opened here, the edits the server hasn't
 * acknowledged yet, and what's needed to start (who's signed in, the workspace, its scopes
 * and settings), in this browser's IndexedDB. The app then reopens without the server,
 * shows what was last seen, keeps edits, and sends them when it's back.
 *
 * Signing out deletes it all.
 */
import type { PushItem } from '@workspace/sync';
import { NoAccessError, type PartialClient } from '@workspace/sync';
import * as Y from 'yjs';

const DB = 'workspace-offline';
const DOCS = 'docs';
const KEPT = 'kept';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB failed'));
  });
}

/** One workspace's offline copy (null where IndexedDB isn't there, e.g. private windows). */
export class OfflineStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly workspaceId: string,
  ) {}

  static async open(workspaceId: string): Promise<OfflineStore | null> {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(DOCS);
        req.result.createObjectStore(KEPT);
      };
      return new OfflineStore(await request(req), workspaceId);
    } catch {
      return null;
    }
  }

  /** Delete everything kept here (signing out). */
  static async clear(): Promise<void> {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }

  private key = (id: string) => `${this.workspaceId}/${id}`;

  private store(name: string, mode: IDBTransactionMode) {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async getDoc(docId: string): Promise<Uint8Array | null> {
    const value = (await request(this.store(DOCS, 'readonly').get(this.key(docId)))) as
      Uint8Array | undefined;
    return value ?? null;
  }

  putDoc(docId: string, state: Uint8Array): Promise<unknown> {
    return request(this.store(DOCS, 'readwrite').put(state, this.key(docId)));
  }

  deleteDoc(docId: string): Promise<unknown> {
    return request(this.store(DOCS, 'readwrite').delete(this.key(docId)));
  }

  async get<T>(name: string): Promise<T | null> {
    return ((await request(this.store(KEPT, 'readonly').get(this.key(name)))) as T) ?? null;
  }

  put(name: string, value: unknown): Promise<unknown> {
    return request(this.store(KEPT, 'readwrite').put(value, this.key(name)));
  }
}

const SAVE_MS = 400;

/**
 * The app's docs through the sync client, kept offline: a doc opens from its copy here when
 * there is one (the server's state merges in when it comes), and every change (here or from
 * the server) is saved. Unacknowledged pushes are saved too, and sent again on the next start.
 * A doc never opened here still waits for the server (an empty stand-in could clash with the
 * server's copy when they merge, e.g. a database's schema made twice).
 */
export class OfflineDocs {
  /** Saved state and the changes since, per doc this tab has open (and how many times). */
  private readonly states = new Map<
    string,
    { saved: Uint8Array | null; since: Uint8Array[]; refs: number }
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: PushItem[] = [];

  constructor(
    private readonly store: OfflineStore | null,
    private readonly client: () => PartialClient,
    /** A change to show (the server's, or a merged state). */
    private readonly emit: (docId: string, update: Uint8Array) => void,
  ) {
    // Saved before the tab goes away, as far as the browser allows.
    globalThis.addEventListener?.('pagehide', () => {
      void this.save();
      void this.saveOutbox();
    });
  }

  /** Pushes kept from before (a reload or crash while offline): sent again. */
  async restore(): Promise<void> {
    const kept = (await this.store?.get<PushItem[]>('outbox').catch(() => null)) ?? [];
    for (const item of kept) this.client().push(item.docId, item.update, item.scope);
  }

  async open(docId: string): Promise<Uint8Array> {
    const open = this.states.get(docId);
    if (open) {
      // Open already (another view of it): what's kept here, with the changes since.
      open.refs++;
      const remote = this.client().open(docId);
      const parts = [open.saved, ...open.since].filter((p): p is Uint8Array => !!p);
      if (parts.length) {
        remote.catch(() => {});
        return parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
      }
      return remote;
    }
    const entry = { saved: null as Uint8Array | null, since: [] as Uint8Array[], refs: 1 };
    this.states.set(docId, entry);
    const cached = (await this.store?.getDoc(docId).catch(() => null)) ?? null;
    entry.saved = cached;
    const remote = this.client().open(docId);
    if (!cached) {
      const state = await remote;
      this.record(docId, state);
      return state;
    }
    // Shown from here at once; the server's state (or a refusal) follows.
    remote.then(
      (state) => {
        this.record(docId, state);
        this.emit(docId, state);
      },
      (error: unknown) => {
        if (error instanceof NoAccessError) void this.store?.deleteDoc(docId);
      },
    );
    return cached;
  }

  /** A change from the server (or kept here): saved, then shown. */
  received(docId: string, update: Uint8Array): void {
    this.record(docId, update);
    this.emit(docId, update);
  }

  push(docId: string, update: Uint8Array): void {
    this.record(docId, update);
    this.client().push(docId, update);
  }

  close(docId: string): void {
    this.client().close(docId);
    const entry = this.states.get(docId);
    if (!entry || --entry.refs > 0) return;
    void this.save(docId).then(() => {
      if (entry.refs <= 0 && this.states.get(docId) === entry) this.states.delete(docId);
    });
  }

  /** The client's unacknowledged pushes changed. */
  pending(items: PushItem[]): void {
    this.outbox = items;
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = setTimeout(() => void this.saveOutbox(), 100);
  }

  private async saveOutbox(): Promise<void> {
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    this.outboxTimer = null;
    await this.store?.put('outbox', this.outbox).catch(() => {});
  }

  private record(docId: string, update: Uint8Array): void {
    const entry = this.states.get(docId);
    if (!entry || !this.store) return;
    entry.since.push(update);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.save();
    }, SAVE_MS);
  }

  /** Write the changed docs (or one), each merged into a single state. */
  private async save(only?: string): Promise<void> {
    if (!this.store) return;
    for (const [docId, entry] of this.states) {
      if ((only && docId !== only) || entry.since.length === 0) continue;
      const parts = entry.saved ? [entry.saved, ...entry.since] : entry.since;
      entry.since = [];
      entry.saved = parts.length === 1 ? parts[0]! : Y.mergeUpdates(parts);
      await this.store.putDoc(docId, entry.saved).catch(() => {});
    }
  }
}
