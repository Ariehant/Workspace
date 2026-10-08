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
  type AccessScope,
  type ClientMessage,
  type ServerMessage,
  type SyncMode,
} from './messages';
import { PresenceRoom, decodeAwareness, presenceColor, type PresenceUser } from './presence';

export interface LoggedRow {
  seq: number;
  docId: string;
  data: Uint8Array;
  deviceId: string | null;
}

/** The workspace update logs (Postgres on the server, memory in tests). */
export interface NewRow {
  docId: string;
  data: Uint8Array;
  deviceId: string | null;
  /** Who made it (null: the server itself). */
  userId?: string | null;
}

export interface LogStore {
  append(workspaceId: string, updates: NewRow[]): Promise<number[]>;
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

/**
 * What one connection may read and write, decided by the host (the server knows each
 * doc's scope and the user's role in it). Without a policy, everything is allowed.
 */
export interface DocPolicy {
  /** May the connection receive this doc's updates? Called for every row: keep it fast. */
  canRead(docId: string): boolean;
  /**
   * May it store an update to this doc? `scope` is where the client asks to place a doc
   * the server hasn't seen (hosts place new docs as they allow them).
   */
  canWrite(docId: string, scope: string | null): boolean | Promise<boolean>;
  /**
   * Is this update's content allowed (e.g. comments: authored by the sender)? `earlier`:
   * updates to the same doc accepted earlier in the same push (not stored yet).
   */
  checkUpdate?(
    docId: string,
    update: Uint8Array,
    earlier: Uint8Array[],
  ): boolean | Promise<boolean>;
}

export interface Access {
  /** Who is connected (stored with their updates). */
  userId?: string | null;
  /** Their name, stamped on their presence (cursors, avatars). */
  userName?: string;
  policy?: DocPolicy;
  /** Their scopes and roles, sent after hello. */
  scopes?: AccessScope[];
  /**
   * For a replica connecting: the docs to take away and to send whole, given the scopes
   * it says it holds and its cursor (what changed while it was away).
   */
  reconcile?(
    known: string[],
    cursor: number,
  ): Promise<{ gained: string[]; lost: string[]; lostScopes: string[] }>;
}

/** A change of a connection's access (see `SyncConnection.reauthorize`). */
export interface AccessChange {
  policy: DocPolicy;
  scopes: AccessScope[];
  /** Docs it can now read and couldn't before (sent to replicas as `backfill`). */
  gained: string[];
  /** Docs it could read and can't any more (sent as `revoke`). */
  lost: string[];
  /** Whole scopes it lost (the client stops claiming them as it deletes their docs). */
  lostScopes?: string[];
  /** Replaces `Access.reconcile` (if the client hasn't said hello yet, it still will). */
  reconcile?: Access['reconcile'];
}

interface WorkspaceState {
  id: string;
  connections: Set<SyncConnection>;
  /** Recent appends in seq order (possibly with gaps, if another process appended). */
  recent: LoggedRow[];
  /** Appends from this process, one at a time, so `recent` stays in seq order. */
  appending: Promise<unknown>;
  /** Presence per doc (only docs someone watches). */
  rooms: Map<string, PresenceRoom<SyncConnection>>;
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
        rooms: new Map(),
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

  /**
   * Append updates the server made itself (e.g. to the members doc) and send them to the
   * workspace's connections, in order with everything else.
   */
  async appendFromServer(
    workspaceId: string,
    updates: { docId: string; data: Uint8Array }[],
  ): Promise<number[]> {
    const rows = updates.map((u) => ({ ...u, deviceId: null, userId: null }));
    const workspace = this.workspaces.get(workspaceId);
    if (workspace) return this.append(workspace, rows);
    // Nobody is connected: store them; whoever connects next catches up from the log.
    const seqs = await this.store.append(workspaceId, rows);
    this.options.onAppend?.(workspaceId);
    return seqs;
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

  /** @internal Send presence to a doc's watchers who may read it (not `except`). */
  relay(
    workspace: WorkspaceState,
    docId: string,
    update: Uint8Array | null,
    except: SyncConnection,
  ): void {
    if (!update) return;
    for (const watcher of workspace.rooms.get(docId)?.watchers ?? []) {
      if (watcher !== except) watcher.sendPresence(docId, update);
    }
  }

  /** @internal Append in order and wake every connection of the workspace. */
  append(workspace: WorkspaceState, updates: NewRow[]): Promise<number[]> {
    const result = workspace.appending.then(async () => {
      const seqs = await this.store.append(workspace.id, updates);
      seqs.forEach((seq, i) => {
        const { docId, data, deviceId } = updates[i]!;
        workspace.recent.push({ seq, docId, data, deviceId });
      });
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
  /** Docs this connection watches (presence). */
  private readonly watching = new Set<string>();
  /**
   * Rows this connection appended and hasn't passed yet: the client has them, so they
   * aren't sent back. (Not "rows from this device": an older connection's push can land
   * after a revoke or reset wiped the device's copy, and then it must come back.)
   */
  private readonly mine = new Set<number>();
  /**
   * Docs this connection revoked or reset: the client threw its copy away, possibly with
   * edits still in flight that the server may store later. Its rows for these docs are
   * always sent back.
   */
  private readonly wiped = new Set<string>();
  private pumping = false;
  private again = false;
  private closed = false;

  constructor(
    private readonly hub: SyncHub,
    private readonly workspace: WorkspaceState,
    private readonly peer: Peer,
    private access: Access,
  ) {}

  private canRead(docId: string): boolean {
    return this.access.policy?.canRead(docId) ?? true;
  }

  /**
   * The user's access changed: from now on use `change.policy`, and tell the client
   * (its scopes, the docs it lost, and for a replica the docs it gained, whose updates
   * are below its cursor). Handled in order with the client's messages.
   */
  reauthorize(change: AccessChange): void {
    this.queue = this.queue.then(() => this.applyAccess(change)).catch((error) => this.fail(error));
  }

  private async applyAccess({
    policy,
    scopes,
    gained,
    lost,
    lostScopes = [],
    reconcile,
  }: AccessChange) {
    if (this.closed) return;
    // The new policy first: rows appended from here on are filtered by it, and the
    // states read below include everything appended before.
    this.access = { ...this.access, policy, scopes, reconcile: reconcile ?? this.access.reconcile };
    if (!this.mode) return; // hello will send the scopes
    if (!(await this.sendChanges(gained, lost, lostScopes))) return;
    this.send({ type: 'access', scopes });
  }

  /**
   * Revoke `lost`, then (replicas) backfill `gained`. The `access` message goes after
   * these, so a client that records its scopes from it never claims a scope whose docs it
   * didn't get. False if the connection closed meanwhile.
   */
  private async sendChanges(
    gained: string[],
    lost: string[],
    lostScopes: string[],
  ): Promise<boolean> {
    // The scopes go with the last part, once all their docs are named.
    for (let i = 0; i < lost.length || (i === 0 && lostScopes.length > 0); i += 1000) {
      const docIds = lost.slice(i, i + 1000);
      for (const id of docIds) {
        this.openDocs.delete(id);
        this.wiped.add(id);
        this.unwatch(id);
      }
      const last = i + 1000 >= lost.length;
      this.send({ type: 'revoke', docIds, scopes: last ? lostScopes : [] });
    }
    if (this.mode !== 'replica') return !this.closed;
    let items: { docId: string; update: Uint8Array }[] = [];
    let bytes = 0;
    const flush = async () => {
      if (items.length === 0) return true;
      if (!(await this.waitForRoom())) return false;
      this.send({ type: 'backfill', items });
      items = [];
      bytes = 0;
      return true;
    };
    for (const docId of gained) {
      if (!this.canRead(docId)) continue;
      const state = await this.hub.store.docState(this.workspace.id, docId);
      if (this.closed) return false;
      if (!state) continue;
      items.push({ docId, update: state });
      bytes += state.byteLength;
      if (bytes >= this.hub.options.batchBytes && !(await flush())) return false;
    }
    return (await flush()) && !this.closed;
  }

  /** A message arrived from the client. Messages are handled one at a time, in order. */
  receive(data: Uint8Array): void {
    this.queue = this.queue.then(() => this.handle(data)).catch((error) => this.fail(error));
  }

  /** The socket closed (from either side): forget the connection. */
  onSocketClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const docId of [...this.watching]) this.unwatch(docId);
    this.hub.detach(this, this.workspace);
  }

  /** @internal Another connection's presence on a doc this one watches. */
  sendPresence(docId: string, update: Uint8Array): void {
    if (this.watching.has(docId) && this.canRead(docId)) {
      this.send({ type: 'awareness', docId, update });
    }
  }

  private get presenceUser(): PresenceUser {
    const id = this.access.userId ?? this.deviceId ?? 'anonymous';
    return { id, name: this.access.userName ?? 'Someone', color: presenceColor(id) };
  }

  private unwatch(docId: string): void {
    if (!this.watching.delete(docId)) return;
    const room = this.workspace.rooms.get(docId);
    if (!room) return;
    const gone = room.leave(this);
    if (room.empty) this.workspace.rooms.delete(docId);
    this.hub.relay(this.workspace, docId, gone, this);
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
        if (this.mode === 'replica' && this.access.reconcile) {
          const { gained, lost, lostScopes } = await this.access.reconcile(
            message.known,
            this.sent,
          );
          if (!(await this.sendChanges(gained, lost, lostScopes))) return;
        }
        if (this.access.scopes) this.send({ type: 'access', scopes: this.access.scopes });
        void this.pump();
        return;
      }
      case 'push': {
        for (const item of message.items) {
          try {
            Y.decodeUpdate(item.update);
          } catch {
            throw new ProtocolError(`Malformed update for ${item.docId}`);
          }
        }
        // One at a time: allowing an item can place a new doc, which the next item (of
        // the same doc) relies on.
        const allowed: boolean[] = [];
        const acceptedByDoc = new Map<string, Uint8Array[]>();
        for (const item of message.items) {
          const policy = this.access.policy;
          let ok = policy ? await policy.canWrite(item.docId, item.scope ?? null) : true;
          if (ok && policy?.checkUpdate) {
            const earlier = acceptedByDoc.get(item.docId) ?? [];
            ok = await policy.checkUpdate(item.docId, item.update, earlier);
          }
          if (ok)
            acceptedByDoc.set(item.docId, [...(acceptedByDoc.get(item.docId) ?? []), item.update]);
          allowed.push(ok);
        }
        if (this.closed) return;
        const accepted = message.items.filter((_, i) => allowed[i]);
        const seqs =
          accepted.length > 0
            ? await this.hub.append(
                this.workspace,
                accepted.map((i) => ({
                  docId: i.docId,
                  data: i.update,
                  deviceId: this.deviceId,
                  userId: this.access.userId ?? null,
                })),
              )
            : [];
        accepted.forEach((item, i) => {
          if (!this.wiped.has(item.docId)) this.mine.add(seqs[i]!);
        });
        const seqOf = new Map(accepted.map((item, i) => [item, seqs[i]!]));
        this.send({
          type: 'ack',
          items: message.items.map((item) => ({
            localId: item.localId,
            seq: seqOf.get(item) ?? 0,
            denied: !seqOf.has(item),
          })),
        });
        // What the client has of a denied doc isn't the server's: send the server's copy
        // to start again from, or take the doc away if it can't even read it.
        const denied = [
          ...new Set(message.items.filter((_, i) => !allowed[i]).map((i) => i.docId)),
        ];
        const unreadable: string[] = [];
        for (const docId of denied) {
          if (!this.canRead(docId)) {
            unreadable.push(docId);
            continue;
          }
          const state = await this.hub.store.docState(this.workspace.id, docId);
          this.wiped.add(docId);
          this.send({ type: 'state', docId, update: state ?? EMPTY_DOC_UPDATE });
        }
        for (const docId of unreadable) this.wiped.add(docId);
        if (unreadable.length > 0) this.send({ type: 'revoke', docIds: unreadable, scopes: [] });
        return;
      }
      case 'open': {
        if (this.mode !== 'partial') throw new ProtocolError('Only partial clients open docs');
        if (this.openDocs.size >= this.hub.options.maxOpenDocs) {
          throw new ProtocolError('Too many open docs');
        }
        if (!this.canRead(message.docId)) {
          this.send({ type: 'refused', docId: message.docId });
          return;
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
      case 'watch': {
        if (this.watching.has(message.docId) || !this.canRead(message.docId)) return;
        if (this.watching.size >= this.hub.options.maxOpenDocs) {
          throw new ProtocolError('Too many watched docs');
        }
        this.watching.add(message.docId);
        let room = this.workspace.rooms.get(message.docId);
        if (!room) this.workspace.rooms.set(message.docId, (room = new PresenceRoom()));
        room.watchers.add(this);
        const present = room.snapshot(this);
        if (present) this.send({ type: 'awareness', docId: message.docId, update: present });
        return;
      }
      case 'unwatch':
        this.unwatch(message.docId);
        return;
      case 'awareness': {
        const entries = decodeAwareness(message.update);
        // Presence for a doc it doesn't watch (or may no longer read) goes nowhere.
        const room = this.workspace.rooms.get(message.docId);
        if (!room || !this.watching.has(message.docId) || !this.canRead(message.docId)) return;
        const relayed = room.receive(this, entries, this.presenceUser);
        this.hub.relay(this.workspace, message.docId, relayed, this);
        return;
      }
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
   * rows merged into one update. Rows this connection pushed itself are skipped (the
   * client has them), so are docs it may not read, and for partial clients docs it hasn't opened;
   * the cursor still moves.
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
      const own = this.mine.delete(row.seq);
      const wanted =
        (this.mode === 'replica' || this.openDocs.has(row.docId)) && this.canRead(row.docId);
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
