/**
 * The client side of sync for a partial client (the web app): it opens only the docs it
 * shows. `open` resolves with a doc's merged state; after that the server sends the doc's
 * new updates. Local updates are pushed and kept until acknowledged, then forgotten.
 *
 * After a reconnect every open doc is opened again (its state, merged into what's here,
 * covers anything missed while away) and unacknowledged pushes are sent again.
 * Nothing is persisted: closing the tab while offline loses unsent edits (the app warns).
 */
import {
  CloseCode,
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type AccessScope,
  type PushItem,
} from './messages';
import type { ClientSocket, SocketHandlers, SyncStatus } from './client';

export interface PartialClientOptions {
  connect: (handlers: SocketHandlers) => ClientSocket;
  deviceId: string;
  /** Updates made elsewhere to an open doc (and states received again after a reconnect). */
  onUpdate: (docId: string, update: Uint8Array) => void;
  /**
   * The server refused local changes to an open doc (the user may not change it): here is
   * its copy to start over from. Without this, it's merged like any update.
   */
  onReset?: (docId: string, state: Uint8Array) => void;
  /** Open docs the user may no longer read. */
  onRevoked?: (docIds: string[]) => void;
  /** The user's scopes and roles (after connecting, and when they change). */
  onAccess?: (scopes: AccessScope[]) => void;
  /** The scope to place a doc in, if the server hasn't seen it. */
  scopeOf?: (docId: string) => string | null;
  backoff?: { minMs: number; maxMs: number };
  onError?: (error: unknown) => void;
  random?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface OpenDoc {
  refs: number;
  /** Waiting for the first state. */
  waiting: { resolve: (state: Uint8Array) => void; reject: (error: Error) => void }[];
  loaded: boolean;
}

/** `open` of a doc the user may not read. */
export class NoAccessError extends Error {
  constructor(readonly docId: string) {
    super(`No access to ${docId}`);
  }
}

export class PartialClient {
  private status: SyncStatus = { state: 'stopped' };
  private readonly listeners = new Set<(status: SyncStatus, pending: number) => void>();
  private running = false;
  private socket: ClientSocket | null = null;
  private generation = 0;
  private ready = false;
  private attempt = 0;
  private timer: unknown = null;
  private nextId = 1;
  private readonly docs = new Map<string, OpenDoc>();
  /** Pushed but not acknowledged, in order. */
  private readonly pending = new Map<number, PushItem>();
  /** Docs with a denied push: the next state for them replaces what's here. */
  private readonly resetting = new Set<string>();
  private readonly o: Required<
    Omit<PartialClientOptions, 'onError' | 'onReset' | 'onRevoked' | 'onAccess' | 'scopeOf'>
  > &
    PartialClientOptions;

  constructor(options: PartialClientOptions) {
    this.o = {
      backoff: { minMs: 500, maxMs: 30_000 },
      random: Math.random,
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...options,
    };
  }

  get state(): SyncStatus {
    return this.status;
  }

  /** Local updates the server hasn't stored yet. */
  get unsent(): number {
    return this.pending.size;
  }

  onStatus(listener: (status: SyncStatus, pending: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connectNow();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.generation++;
    socket?.close();
    this.setStatus({ state: 'stopped' });
  }

  retryNow(): void {
    if (!this.running || this.socket) return;
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
    this.connectNow();
  }

  /** A doc's state (once the server sends it); its later updates go to `onUpdate`. */
  open(docId: string): Promise<Uint8Array> {
    let doc = this.docs.get(docId);
    if (!doc) {
      doc = { refs: 0, waiting: [], loaded: false };
      this.docs.set(docId, doc);
      if (this.ready) this.send({ type: 'open', docId });
    }
    doc.refs++;
    const entry = doc;
    return new Promise((resolve, reject) => entry.waiting.push({ resolve, reject }));
  }

  close(docId: string): void {
    const doc = this.docs.get(docId);
    if (!doc) return;
    doc.refs--;
    if (doc.refs > 0) return;
    this.docs.delete(docId);
    if (this.ready) this.send({ type: 'close', docId });
  }

  /** A local update: sent now if connected, kept until the server acknowledges it. */
  push(docId: string, update: Uint8Array): void {
    const item: PushItem = {
      localId: this.nextId++,
      docId,
      update,
      scope: this.o.scopeOf?.(docId) ?? null,
    };
    this.pending.set(item.localId, item);
    if (this.ready) this.send({ type: 'push', items: [item] });
    this.notify();
  }

  private send(message: Parameters<typeof encodeClient>[0]) {
    this.socket?.send(encodeClient(message));
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    this.notify();
  }

  private notify() {
    for (const listener of this.listeners) listener(this.status, this.pending.size);
  }

  private connectNow() {
    const generation = ++this.generation;
    this.ready = false;
    this.setStatus({ state: 'connecting' });
    const current = () => generation === this.generation;
    this.socket = this.o.connect({
      onOpen: () => {
        if (!current() || !this.socket) return;
        this.send({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          mode: 'partial',
          cursor: 0,
          deviceId: this.o.deviceId,
          known: [],
        });
        this.ready = true;
        this.setStatus({ state: 'catching-up' });
        // Everything open is opened again; everything unacknowledged is sent again.
        for (const docId of this.docs.keys()) this.send({ type: 'open', docId });
        const items = [...this.pending.values()];
        for (let i = 0; i < items.length; i += 200) {
          this.send({ type: 'push', items: items.slice(i, i + 200) });
        }
      },
      onMessage: (data) => {
        try {
          this.handle(data, current());
        } catch (error) {
          this.o.onError?.(error);
          if (current()) this.socket?.close();
        }
      },
      onClose: (code, reason) => {
        if (current()) this.closed(code, reason);
      },
    });
  }

  private handle(data: Uint8Array, current: boolean) {
    const message = decodeServer(data);
    switch (message.type) {
      case 'state': {
        const doc = this.docs.get(message.docId);
        if (!doc) return;
        if (!doc.loaded) {
          doc.loaded = true;
          for (const w of doc.waiting.splice(0)) w.resolve(message.update);
        } else if (this.resetting.delete(message.docId) && this.o.onReset) {
          // After a denied push: the server's copy replaces ours.
          this.o.onReset(message.docId, message.update);
        } else {
          // Opened again after a reconnect: whatever we missed is in here.
          this.o.onUpdate(message.docId, message.update);
        }
        return;
      }
      case 'refused': {
        const doc = this.docs.get(message.docId);
        if (!doc) return;
        this.docs.delete(message.docId);
        for (const w of doc.waiting.splice(0)) w.reject(new NoAccessError(message.docId));
        return;
      }
      case 'revoke': {
        const lost = message.docIds.filter((id) => this.docs.has(id));
        for (const id of lost) {
          const doc = this.docs.get(id)!;
          this.docs.delete(id);
          for (const w of doc.waiting.splice(0)) w.reject(new NoAccessError(id));
        }
        // Unsent edits to them can't be stored any more.
        for (const [localId, item] of this.pending) {
          if (message.docIds.includes(item.docId)) this.pending.delete(localId);
        }
        if (lost.length > 0) this.o.onRevoked?.(lost);
        this.notify();
        return;
      }
      case 'access':
        this.o.onAccess?.(message.scopes);
        return;
      case 'backfill':
        // Replicas only.
        return;
      case 'updates':
        for (const item of message.items) {
          const doc = this.docs.get(item.docId);
          if (!doc) continue;
          if (doc.loaded) this.o.onUpdate(item.docId, item.update);
        }
        return;
      case 'ack':
        for (const item of message.items) {
          const pushed = this.pending.get(item.localId);
          if (item.denied && pushed) this.resetting.add(pushed.docId);
          this.pending.delete(item.localId);
        }
        this.notify();
        return;
      case 'caught-up':
        if (current) {
          this.attempt = 0;
          this.setStatus({ state: 'live' });
        }
        return;
      case 'error':
        this.o.onError?.(new Error(`${message.code}: ${message.message}`));
        return;
    }
  }

  private closed(code: number, reason: string) {
    this.socket = null;
    this.ready = false;
    if (!this.running) return;
    if (code === CloseCode.unauthenticated || code === CloseCode.forbidden) {
      this.running = false;
      this.setStatus({ state: 'unauthorized', reason: reason || 'Signed out' });
      return;
    }
    if (code === CloseCode.protocol && reason === 'Protocol version') {
      this.running = false;
      this.setStatus({ state: 'error', reason: 'The server was updated: reload the page.' });
      return;
    }
    const { minMs, maxMs } = this.o.backoff;
    const ceiling = Math.min(maxMs, minMs * 2 ** this.attempt++);
    const delay = Math.round(ceiling / 2 + (this.o.random() * ceiling) / 2);
    this.setStatus({
      state: 'offline',
      retryAt: this.o.now() + delay,
      reason: reason || `Connection closed (${code})`,
    });
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      if (this.running && !this.socket) this.connectNow();
    }, delay);
  }
}
