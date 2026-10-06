/**
 * The client side of sync for a replica (a device holding the whole workspace), without
 * I/O: the host gives it a store (cursor, outbox, applying updates) and a way to open a
 * socket.
 *
 * connect → hello (cursor) → push the outbox → catch up → live. The outbox is only
 * trimmed when the server acknowledges an update (stored in Postgres): until then it is
 * sent again after every reconnect, which is harmless since Yjs updates are idempotent.
 */
import {
  CloseCode,
  MAX_PUSH_ITEMS,
  MAX_UPDATE_BYTES,
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type PushItem,
} from './messages';

export type OutboxEntry = PushItem;

export interface ClientStore {
  /** The newest seq of the server's log that this device has applied. */
  cursor(): number | Promise<number>;
  /** Unacknowledged local updates, oldest first (at most `limit`). */
  pending(limit: number): OutboxEntry[] | Promise<OutboxEntry[]>;
  /** The server stored these: drop them from the outbox. */
  acknowledge(localIds: number[]): void | Promise<void>;
  /**
   * Apply updates from the server, then store `cursor` (in one transaction if the host
   * can: a cursor saved without its updates would skip them forever).
   */
  applyRemote(items: { docId: string; update: Uint8Array }[], cursor: number): void | Promise<void>;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(code: number, reason: string): void;
}

export interface ClientSocket {
  send(data: Uint8Array): void;
  close(): void;
}

export type SyncStatus =
  | { state: 'stopped' }
  | { state: 'connecting' }
  | { state: 'catching-up' }
  | { state: 'live' }
  | { state: 'offline'; retryAt: number; reason: string }
  /** The session is gone or the workspace isn't ours: needs the user. No retries. */
  | { state: 'unauthorized'; reason: string }
  /** The server can't talk to this app (protocol version). No retries. */
  | { state: 'error'; reason: string };

export interface SyncClientOptions {
  store: ClientStore;
  connect: (handlers: SocketHandlers) => ClientSocket;
  deviceId: string;
  /** Reconnect delays: exponential from `minMs` up to `maxMs`, with jitter. */
  backoff?: { minMs: number; maxMs: number };
  /** Bytes per push message (several updates are packed into one). */
  pushBytes?: number;
  /** The server's log is behind this device's cursor: it lost data (restored backup). */
  onServerBehind?: (serverCursor: number, localCursor: number) => void;
  /** An update too large to ever push (stays in the outbox). */
  onOversized?: (entry: OutboxEntry) => void;
  onError?: (error: unknown) => void;
  random?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const OUTBOX_WINDOW = 1000;

export class SyncClient {
  private status: SyncStatus = { state: 'stopped' };
  private readonly listeners = new Set<(status: SyncStatus) => void>();
  private running = false;
  private socket: ClientSocket | null = null;
  /** Bumped per connection: events from an older socket don't change the state. */
  private generation = 0;
  /** Hello was sent on the current socket, so pushes may follow. */
  private ready = false;
  private attempt = 0;
  private timer: unknown = null;
  private helloCursor = 0;
  private readonly inflight = new Set<number>();
  private readonly oversized = new Set<number>();
  private sending = false;
  private sendAgain = false;
  /** Incoming messages, handled one at a time. */
  private queue: Promise<void> = Promise.resolve();
  private readonly o: Required<
    Omit<SyncClientOptions, 'onServerBehind' | 'onOversized' | 'onError'>
  > &
    SyncClientOptions;

  constructor(options: SyncClientOptions) {
    this.o = {
      backoff: { minMs: 500, maxMs: 30_000 },
      pushBytes: 2 * 1024 * 1024,
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

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.open();
  }

  stop(): void {
    this.running = false;
    this.cancelTimer();
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    this.generation++;
    socket?.close();
    this.setStatus({ state: 'stopped' });
  }

  /** Reconnect now (e.g. the network came back) instead of waiting for the backoff. */
  retryNow(): void {
    if (!this.running || this.socket) return;
    this.cancelTimer();
    this.open();
  }

  /** The outbox has new entries: send them if connected. */
  flush(): void {
    void this.sendOutbox();
  }

  /** Wait until every message received so far has been handled (for tests and shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private setStatus(status: SyncStatus) {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  private cancelTimer() {
    if (this.timer !== null) this.o.clearTimer(this.timer);
    this.timer = null;
  }

  private open() {
    const generation = ++this.generation;
    this.ready = false;
    this.setStatus({ state: 'connecting' });
    const current = () => generation === this.generation;
    this.socket = this.o.connect({
      onOpen: () => {
        if (current()) void this.opened(generation);
      },
      onMessage: (data) => {
        this.queue = this.queue
          .then(() => this.handle(data, generation))
          .catch((error) => {
            this.o.onError?.(error);
            // Couldn't decode or apply: drop the connection and start over from the cursor.
            if (current()) this.socket?.close();
          });
      },
      onClose: (code, reason) => {
        if (current()) this.closed(code, reason);
      },
    });
  }

  private async opened(generation: number) {
    try {
      const cursor = await this.o.store.cursor();
      if (generation !== this.generation || !this.socket) return;
      this.helloCursor = cursor;
      this.socket.send(
        encodeClient({
          type: 'hello',
          protocol: PROTOCOL_VERSION,
          mode: 'replica',
          cursor,
          deviceId: this.o.deviceId,
        }),
      );
      this.ready = true;
      this.inflight.clear();
      this.setStatus({ state: 'catching-up' });
      await this.sendOutbox();
    } catch (error) {
      this.o.onError?.(error);
      if (generation === this.generation) this.socket?.close();
    }
  }

  private closed(code: number, reason: string) {
    this.socket = null;
    this.ready = false;
    if (!this.running) return;
    if (code === CloseCode.unauthenticated || code === CloseCode.forbidden) {
      this.running = false;
      this.setStatus({
        state: 'unauthorized',
        reason: reason || (code === CloseCode.forbidden ? 'No access' : 'Signed out'),
      });
      return;
    }
    if (code === CloseCode.protocol && reason === 'Protocol version') {
      this.running = false;
      this.setStatus({ state: 'error', reason: 'The server needs a newer version of the app.' });
      return;
    }
    const { minMs, maxMs } = this.o.backoff;
    const ceiling = Math.min(maxMs, minMs * 2 ** this.attempt++);
    // "Equal jitter": between half and all of the ceiling, so clients spread out.
    const delay = Math.round(ceiling / 2 + (this.o.random() * ceiling) / 2);
    this.setStatus({
      state: 'offline',
      retryAt: this.o.now() + delay,
      reason: reason || `Connection closed (${code})`,
    });
    this.timer = this.o.setTimer(() => {
      this.timer = null;
      if (this.running && !this.socket) this.open();
    }, delay);
  }

  private async handle(data: Uint8Array, generation: number) {
    const message = decodeServer(data);
    switch (message.type) {
      case 'updates':
        await this.o.store.applyRemote(message.items, message.cursor);
        return;
      case 'caught-up':
        if (message.cursor < this.helloCursor) {
          this.o.onServerBehind?.(message.cursor, this.helloCursor);
        }
        if (generation === this.generation && this.socket) {
          this.attempt = 0;
          this.setStatus({ state: 'live' });
        }
        return;
      case 'ack': {
        const ids = message.items.map((i) => i.localId);
        await this.o.store.acknowledge(ids);
        for (const id of ids) this.inflight.delete(id);
        if (this.inflight.size === 0) await this.sendOutbox();
        return;
      }
      case 'error':
        this.o.onError?.(new Error(`${message.code}: ${message.message}`));
        return;
      case 'state':
        return;
    }
  }

  private async sendOutbox(): Promise<void> {
    if (!this.ready) return;
    if (this.sending) {
      this.sendAgain = true;
      return;
    }
    this.sending = true;
    try {
      do {
        this.sendAgain = false;
        const generation = this.generation;
        const entries = await this.o.store.pending(OUTBOX_WINDOW);
        if (generation !== this.generation || !this.ready || !this.socket) return;
        let batch: OutboxEntry[] = [];
        let bytes = 0;
        const send = () => {
          if (batch.length === 0) return;
          for (const e of batch) this.inflight.add(e.localId);
          this.socket!.send(encodeClient({ type: 'push', items: batch }));
          batch = [];
          bytes = 0;
        };
        for (const entry of entries) {
          if (this.inflight.has(entry.localId) || this.oversized.has(entry.localId)) continue;
          if (entry.update.byteLength > MAX_UPDATE_BYTES) {
            this.oversized.add(entry.localId);
            this.o.onOversized?.(entry);
            continue;
          }
          if (
            batch.length >= MAX_PUSH_ITEMS ||
            (batch.length > 0 && bytes + entry.update.byteLength > this.o.pushBytes)
          ) {
            send();
          }
          batch.push(entry);
          bytes += entry.update.byteLength;
        }
        send();
      } while (this.sendAgain);
    } finally {
      this.sending = false;
      // A flush (or a new connection) arrived while an older pass was bailing out.
      if (this.sendAgain) void this.sendOutbox();
    }
  }
}
