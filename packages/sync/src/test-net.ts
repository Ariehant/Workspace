/**
 * An in-memory network between `SyncClient`s and a `SyncHub`, for tests: messages are
 * delivered asynchronously and in order per direction, links can be cut (dropping what's
 * in flight), clients can be kept offline, adjacent messages can be duplicated, and the
 * hub can be swapped (a server restart).
 */
import type { ClientSocket, SocketHandlers } from './client';
import type { Access, SyncConnection, SyncHub } from './hub';

export type Rng = () => number;

/** Deterministic random numbers (mulberry32). */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const later = (fn: () => void) => setTimeout(fn, 0);

export class Link {
  private toServer: Uint8Array[] = [];
  private toClient: Uint8Array[] = [];
  private flushingServer = false;
  private flushingClient = false;
  dead = false;
  connection: SyncConnection | null = null;
  /** Stop delivering to the client (a stalled reader). */
  paused = false;

  constructor(
    private readonly net: TestNet,
    private readonly handlers: SocketHandlers,
  ) {}

  attach(hub: SyncHub, workspaceId: string, access: Access) {
    this.connection = hub.connect(
      workspaceId,
      {
        send: (data) => {
          if (this.dead) return;
          this.toClient.push(data);
          if (this.net.rng() < this.net.duplicate) this.toClient.push(data);
          this.pumpClient();
        },
        buffered: () => this.toClient.reduce((n, d) => n + d.byteLength, 0),
        close: (code, reason) => this.end(code, reason, true),
      },
      access,
    );
    later(() => !this.dead && this.handlers.onOpen());
  }

  socket(): ClientSocket {
    return {
      send: (data) => {
        if (this.dead) return;
        this.toServer.push(data);
        if (this.net.rng() < this.net.duplicate) this.toServer.push(data);
        this.pumpServer();
      },
      close: () => this.end(1000, 'Client closed', false),
    };
  }

  /** The connection drops: whatever is in flight is lost. */
  cut() {
    this.toServer = [];
    this.toClient = [];
    this.end(1006, 'Connection lost', false);
  }

  resume() {
    this.paused = false;
    this.pumpClient();
  }

  private end(code: number, reason: string, deliverFirst: boolean) {
    if (this.dead) return;
    if (!deliverFirst) this.toClient = [];
    this.dead = true;
    this.connection?.onSocketClosed();
    this.net.links.delete(this);
    const finish = () => {
      if (this.toClient.length > 0 && !this.paused) return later(finish);
      this.handlers.onClose(code, reason);
    };
    later(finish);
  }

  private pumpServer() {
    if (this.flushingServer) return;
    this.flushingServer = true;
    later(() => {
      this.flushingServer = false;
      const batch = this.toServer;
      this.toServer = [];
      if (this.dead) return;
      for (const data of batch) this.connection!.receive(data);
    });
  }

  private pumpClient() {
    if (this.flushingClient || this.paused) return;
    this.flushingClient = true;
    later(() => {
      this.flushingClient = false;
      if (this.paused) return;
      const batch = this.toClient;
      this.toClient = [];
      for (const data of batch) this.handlers.onMessage(data);
      // `end` may be waiting for the queue to drain.
    });
  }
}

export class TestNet {
  readonly links = new Set<Link>();
  /** Probability that a message is delivered twice (adjacent, so order is kept). */
  duplicate = 0;
  /** Client ids that can't connect right now. */
  readonly offline = new Set<string>();

  constructor(
    public hub: SyncHub,
    readonly rng: Rng = Math.random,
  ) {}

  /** A `connect` for `SyncClient`, as client `clientId`. */
  connector(clientId: string, workspaceId: string, access: Access = { canWrite: true }) {
    return (handlers: SocketHandlers): ClientSocket => {
      const link = new Link(this, handlers);
      (link as Link & { clientId: string }).clientId = clientId;
      if (this.offline.has(clientId)) {
        link.dead = true;
        later(() => handlers.onClose(1006, 'Unreachable'));
        return link.socket();
      }
      this.links.add(link);
      link.attach(this.hub, workspaceId, access);
      return link.socket();
    };
  }

  linksOf(clientId: string): Link[] {
    return [...this.links].filter((l) => (l as Link & { clientId?: string }).clientId === clientId);
  }

  /** Swap in a new hub; the old one closes every socket. */
  restart(hub: SyncHub) {
    const old = this.hub;
    this.hub = hub;
    old.closeAll();
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `done()` holds, or fail after `timeoutMs`. */
export async function until(done: () => boolean, timeoutMs = 10_000, what = 'condition') {
  const start = Date.now();
  while (!done()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await sleep(2);
  }
}
