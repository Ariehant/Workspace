/**
 * The server side of sync, without I/O: the host (the server) gives it a log store and
 * one `Peer` per WebSocket, and feeds it the bytes each socket receives.
 *
 * Each connection has a `sent` cursor: every update of the workspace's log up to it has
 * been sent (or skipped as the connection's own). A single "pump" per connection moves
 * that cursor forward in seq order, from a small in-memory ring of recent appends when it
 * can and from the store otherwise, waiting while the socket's buffer is full. Appends
 * only "poke" the pumps, so a slow socket never holds up the others, and every socket
 * always receives the log in order, without gaps.
 */
import * as Y from 'yjs';
import {
  CloseCode,
  PROTOCOL_VERSION,
  ProtocolError,
  decodeClient,
  encodeServer,
  type ClientMessage,
  type ServerMessage,
  type SyncMode,
} from './messages';

export interface LoggedRow {
  seq: number;
  docId: string;
  data: Uint8Array;
  deviceId: string | null;
}

/** The workspace update logs (Postgres on the server, memory in tests). */
export interface LogStore {
  append(
    workspaceId: string,
    updates: { docId: string; data: Uint8Array; deviceId: string | null }[],
  ): Promise<number[]>;
  /** Rows after `cursor`, oldest first, at most `limit`. */
  since(workspaceId: string, cursor: number, limit: number): Promise<LoggedRow[]>;
  latest(workspaceId: string): Promise<number>;
  docState(workspaceId: string, docId: string): Promise<Uint8Array | null>;
}

/** One client socket, as the hub sees it. */
export interface Peer {
  send(data: Uint8Array): void;
  /** Bytes queued on the socket but not yet sent. */
  buffered(): number;
  close(code: number, reason: string): void;
}

export interface HubOptions {
  /** Log rows read per step of a catch-up. */
  batchRows?: number;
  /** An `updates` message is sent once it holds about this many bytes. */
  batchBytes?: number;
  /** Stop sending to a socket while this much is queued on it... */
  maxBuffered?: number;
  /** ...and close it if it stays that full for this long. */
  slowTimeoutMs?: number;
  /** Recent appends kept in memory per workspace, so live updates skip the database. */
  ringSize?: number;
  /** Most docs a partial client may have open. */
  maxOpenDocs?: number;
  /** Called after updates were appended to a workspace's log (e.g. to update a search index). */
  onAppend?: (workspaceId: string) => void;
  /** Errors that aren't the client's fault (the store failing), for logging. */
  onError?: (error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface Access {
  /** Members can push; guests (Phase 5) only read. */
  canWrite: boolean;
}

interface WorkspaceState {
  id: string;
  connections: Set<SyncConnection>;
  /** Recent appends in seq order (possibly with gaps, if another process appended). */
  recent: LoggedRow[];
  /** Appends from this process, one at a time, so `recent` stays in seq order. */
  appending: Promise<unknown>;
}

const EMPTY_DOC_UPDATE = Y.encodeStateAsUpdate(new Y.Doc());

export class SyncHub {
  private readonly workspaces = new Map<string, WorkspaceState>();
  readonly options: Required<Omit<HubOptions, 'onAppend'>> & Pick<HubOptions, 'onAppend'>;

  constructor(
    readonly store: LogStore,
    options: HubOptions = {},
  ) {
    this.options = {
      batchRows: 500,
      batchBytes: 4 * 1024 * 1024,
      maxBuffered: 8 * 1024 * 1024,
      slowTimeoutMs: 60_000,
      ringSize: 2000,
      maxOpenDocs: 2000,
      onError: () => {},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      ...options,
    };
  }

  /** Attach a socket that was allowed into `workspaceId`. Feed it with `receive`. */
  connect(workspaceId: string, peer: Peer, access: Access): SyncConnection {
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      workspace = {
        id: workspaceId,
        connections: new Set(),
        recent: [],
        appending: Promise.resolve(),
      };
      this.workspaces.set(workspaceId, workspace);
    }
    const connection = new SyncConnection(this, workspace, peer, access);
    workspace.connections.add(connection);
    return connection;
  }

  /** Connections open now (all workspaces). */
  get connectionCount(): number {
    let n = 0;
    for (const w of this.workspaces.values()) n += w.connections.size;
    return n;
  }

  /**
   * The log changed outside this hub (a compaction, another server process): send the
   * new rows to the workspace's connections.
   */
  notify(workspaceId: string): void {
    for (const c of this.workspaces.get(workspaceId)?.connections ?? []) c.poke();
  }

  /** Close every socket (shutdown). */
  closeAll(code: number = CloseCode.goingAway, reason = 'Server shutting down'): void {
    for (const w of this.workspaces.values()) {
      for (const c of [...w.connections]) c.close(code, reason);
    }
  }

  /** @internal */
  detach(connection: SyncConnection, workspace: WorkspaceState): void {
    workspace.connections.delete(connection);
    if (workspace.connections.size === 0 && this.workspaces.get(workspace.id) === workspace) {
      this.workspaces.delete(workspace.id);
    }
  }

  /** @internal Append in order and wake every connection of the workspace. */
  append(
    workspace: WorkspaceState,
    updates: { docId: string; data: Uint8Array; deviceId: string | null }[],
  ): Promise<number[]> {
    const result = workspace.appending.then(async () => {
      const seqs = await this.store.append(workspace.id, updates);
      seqs.forEach((seq, i) => workspace.recent.push({ seq, ...updates[i]! }));
      const extra = workspace.recent.length - this.options.ringSize;
      if (extra > 0) workspace.recent.splice(0, extra);
      return seqs;
    });
    workspace.appending = result.catch(() => {});
    void result.then(
      () => {
        for (const c of workspace.connections) c.poke();
        this.options.onAppend?.(workspace.id);
      },
      () => {},
    );
    return result;
  }
}

/**
 * Rows right after `cursor` from the ring, or null if the ring doesn't have the next one.
 * `atEnd` says the run reached the newest row this process knows of (rather than a gap).
 */
function fromRing(
  recent: LoggedRow[],
  cursor: number,
  limit: number,
): { rows: LoggedRow[]; atEnd: boolean } | null {
  if (recent.length === 0) return null;
  const last = recent[recent.length - 1]!;
  if (cursor >= last.seq) return null;
  // Binary search for cursor + 1.
  let lo = 0;
  let hi = recent.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (recent[mid]!.seq < cursor + 1) lo = mid + 1;
    else hi = mid;
  }
  if (recent[lo]!.seq !== cursor + 1) return null;
  const rows = [recent[lo]!];
  let i = lo + 1;
  for (; i < recent.length && rows.length < limit; i++) {
    if (recent[i]!.seq !== rows[rows.length - 1]!.seq + 1) break;
    rows.push(recent[i]!);
  }
  return { rows, atEnd: i === recent.length };
}

export class SyncConnection {
  private queue: Promise<void> = Promise.resolve();
  private mode: SyncMode | null = null;
  private deviceId: string | null = null;
  private sent = 0;
  private caughtUp = false;
  private readonly openDocs = new Set<string>();
  private pumping = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly hub: SyncHub,
    private readonly workspace: WorkspaceState,
    private readonly peer: Peer,
    private readonly access: Access,
  ) {}

  /** A message arrived from the client. Messages are handled one at a time, in order. */
  receive(data: Uint8Array): void {
    this.queue = this.queue.then(() => this.handle(data)).catch((error) => this.fail(error));
  }

  /** The socket closed (from either side): forget the connection. */
  onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.hub.detach(this, this.workspace);
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.onSocketClosed();
    this.peer.close(code, reason);
  }

  /** New rows were appended: send them (if not already sending). */
  poke(): void {
    if (this.mode) void this.pump();
  }

  private send(message: ServerMessage) {
    if (!this.closed) this.peer.send(encodeServer(message));
  }

  private fail(error: unknown) {
    if (this.closed) return;
    if (error instanceof ProtocolError) {
      this.send({ type: 'error', code: 'protocol', message: error.message });
      this.close(CloseCode.protocol, error.message.slice(0, 100));
    } else {
      this.hub.options.onError(error);
      this.send({ type: 'error', code: 'server', message: 'Server error' });
      this.close(1011, 'Server error');
    }
  }

  private async handle(data: Uint8Array): Promise<void> {
    if (this.closed) return;
    const message: ClientMessage = decodeClient(data);
    if (!this.mode && message.type !== 'hello') throw new ProtocolError('Expected hello');
    switch (message.type) {
      case 'hello': {
        if (this.mode) throw new ProtocolError('Hello twice');
        if (message.protocol !== PROTOCOL_VERSION) {
          this.send({
            type: 'error',
            code: 'version',
            message: `This server speaks sync protocol ${PROTOCOL_VERSION}; update the app.`,
          });
          this.close(CloseCode.protocol, 'Protocol version');
          return;
        }
        const latest = await this.hub.store.latest(this.workspace.id);
        this.deviceId = message.deviceId || null;
        // A replica catches up from its cursor. If the cursor is ahead of the log, the
        // server lost data (restored from an old backup): start over from 0, and the
        // client sees `caught-up` with a cursor lower than its own.
        this.sent =
          message.mode === 'partial' ? latest : message.cursor > latest ? 0 : message.cursor;
        this.mode = message.mode;
        void this.pump();
        return;
      }
      case 'push': {
        if (!this.access.canWrite) {
          this.send({
            type: 'error',
            code: 'read_only',
            message: 'You can only read this workspace.',
          });
          this.close(CloseCode.forbidden, 'Read only');
          return;
        }
        for (const item of message.items) {
          try {
            Y.decodeUpdate(item.update);
          } catch {
            throw new ProtocolError(`Malformed update for ${item.docId}`);
          }
        }
        const seqs = await this.hub.append(
          this.workspace,
          message.items.map((i) => ({ docId: i.docId, data: i.update, deviceId: this.deviceId })),
        );
        this.send({
          type: 'ack',
          items: message.items.map((item, i) => ({ localId: item.localId, seq: seqs[i]! })),
        });
        return;
      }
      case 'open': {
        if (this.mode !== 'partial') throw new ProtocolError('Only partial clients open docs');
        if (this.openDocs.size >= this.hub.options.maxOpenDocs) {
          throw new ProtocolError('Too many open docs');
        }
        // Opened first, then read: anything appended in between is sent again by the
        // pump, which is harmless (Yjs ignores what it already has).
        this.openDocs.add(message.docId);
        const state = await this.hub.store.docState(this.workspace.id, message.docId);
        this.send({ type: 'state', docId: message.docId, update: state ?? EMPTY_DOC_UPDATE });
        return;
      }
      case 'close':
        this.openDocs.delete(message.docId);
        return;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.again = true;
      return;
    }
    this.pumping = true;
    try {
      const { batchRows } = this.hub.options;
      do {
        this.again = false;
        for (;;) {
          if (!(await this.waitForRoom())) return;
          const recent = fromRing(this.workspace.recent, this.sent, batchRows);
          if (recent) {
            this.sendRows(recent.rows);
            if (recent.atEnd) break;
            continue;
          }
          const rows = await this.hub.store.since(this.workspace.id, this.sent, batchRows);
          if (this.closed) return;
          if (rows.length === 0) break;
          this.sendRows(rows);
          // A short read means we're at the end of the log (as of that read); later
          // appends poke again.
          if (rows.length < batchRows) break;
        }
        if (!this.caughtUp) {
          this.caughtUp = true;
          this.send({ type: 'caught-up', cursor: this.sent });
        }
      } while (this.again);
    } catch (error) {
      this.fail(error);
    } finally {
      this.pumping = false;
    }
  }

  /** Wait while the socket's buffer is full; false if the connection closed meanwhile. */
  private async waitForRoom(): Promise<boolean> {
    const { maxBuffered, slowTimeoutMs, sleep, now } = this.hub.options;
    const start = now();
    while (!this.closed && this.peer.buffered() > maxBuffered) {
      if (now() - start > slowTimeoutMs) {
        this.close(CloseCode.slow, 'Too slow');
        return false;
      }
      await sleep(25);
    }
    return !this.closed;
  }

  /**
   * Send rows (in seq order) as `updates` messages of about `batchBytes`, each doc's
   * rows merged into one update. Rows this device pushed itself are skipped (it has
   * them), and for partial clients so are docs it hasn't opened; the cursor still moves.
   */
  private sendRows(rows: LoggedRow[]) {
    const { batchBytes } = this.hub.options;
    let chunk = new Map<string, Uint8Array[]>();
    let bytes = 0;
    const flush = (cursor: number) => {
      const items = [...chunk].map(([docId, list]) => ({
        docId,
        update: list.length === 1 ? list[0]! : Y.mergeUpdates(list),
      }));
      if (items.length > 0 || this.mode === 'replica') {
        this.send({ type: 'updates', cursor, items });
      }
      this.sent = cursor;
      chunk = new Map();
      bytes = 0;
    };
    for (const row of rows) {
      const own = this.deviceId !== null && row.deviceId === this.deviceId;
      const wanted = this.mode === 'replica' || this.openDocs.has(row.docId);
      if (!own && wanted) {
        let list = chunk.get(row.docId);
        if (!list) chunk.set(row.docId, (list = []));
        list.push(row.data);
        bytes += row.data.byteLength;
      }
      if (bytes >= batchBytes) flush(row.seq);
    }
    const last = rows[rows.length - 1]!.seq;
    if (last > this.sent) flush(last);
  }
}
