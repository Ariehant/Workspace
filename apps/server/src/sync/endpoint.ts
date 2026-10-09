/**
 * `GET /api/sync/<workspace id>` (WebSocket): the sync endpoint. Authentication happens on
 * the upgrade; the protocol itself lives in `@workspace/sync`.
 *
 * Refusals complete the upgrade and then close with an application code (4401 sign in
 * again, 4403 no access), since browsers can't see the HTTP status of a failed handshake.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { CloseCode, MAX_CLIENT_MESSAGE_BYTES, SyncHub, type SyncConnection } from '@workspace/sync';
import type { FastifyInstance } from 'fastify';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { SESSION_COOKIE, touch } from '../auth/context';
import { atLeast } from '../access/roles';
import type { AccessEvent, Roles } from '../access/service';
import type { ServerContext } from '../context';
import { pgLogStore } from './log-store';

export interface SyncOptions {
  /** Ping every socket this often; one that hasn't answered the last ping is dropped. */
  heartbeatMs?: number;
  /** Check this often that each socket's session and membership still hold. */
  recheckMs?: number;
  /** Compact the update logs this often (null: never). */
  compactEveryMs?: number | null;
  /** Docs with more stored updates than this get compacted. */
  compactThreshold?: number;
  /** Most sockets one user may have open. */
  maxSocketsPerUser?: number;
}

const PATH = /^\/api\/sync\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface Client {
  token: string;
  userId: string;
  workspaceId: string;
  connection: SyncConnection;
  alive: boolean;
  /** The roles its policy was made from (to see what a change adds or takes away). */
  roles: Roles;
}

export function syncEndpoint(app: FastifyInstance, ctx: ServerContext, options: SyncOptions = {}) {
  const {
    heartbeatMs = 30_000,
    recheckMs = 60_000,
    compactEveryMs = null,
    compactThreshold = 500,
    maxSocketsPerUser = 50,
  } = options;
  const { store } = ctx;
  const publicOrigin = new URL(ctx.config.publicUrl).origin;
  const hub = new SyncHub(pgLogStore(store), {
    onError: (error) => app.log.error({ err: error }, 'sync failed'),
    onAppend: (workspaceId) => {
      ctx.indexer.schedule(workspaceId);
      ctx.notifier.schedule(workspaceId);
      ctx.automations.schedule(workspaceId);
      void ctx.history.follow(workspaceId);
    },
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const clients = new Map<WebSocket, Client>();

  /** The session token of an upgrade request; cookies only from our own origin. */
  function tokenOf(request: IncomingMessage): string | null {
    const header = request.headers.authorization;
    const bearer = header ? /^Bearer\s+(\S+)$/i.exec(header)?.[1] : undefined;
    if (bearer) return bearer;
    // A cookie is sent by the browser whatever page opened the socket: only trust it
    // when the page is ours (cross-site WebSocket hijacking).
    if (request.headers.origin !== publicOrigin) return null;
    const cookies = app.parseCookie(request.headers.cookie ?? '');
    return cookies[SESSION_COOKIE] ?? null;
  }

  async function accept(ws: WebSocket, request: IncomingMessage, workspaceId: string) {
    // Messages that arrive while the session is being checked wait their turn.
    const early: { data: RawData; binary: boolean }[] = [];
    const hold = (data: RawData, binary: boolean) => early.push({ data, binary });
    ws.on('message', hold);
    ws.on('error', (error) => app.log.debug({ err: error }, 'sync socket error'));

    const token = tokenOf(request);
    const found = token ? await store.accounts.sessionByToken(token) : null;
    if (!found || !token) {
      ws.close(CloseCode.unauthenticated, 'Sign in again');
      return;
    }
    await touch(ctx, found.session);
    const role = await store.roleOf(workspaceId, found.user.id);
    if (!role) {
      ws.close(CloseCode.forbidden, 'No access to this workspace');
      return;
    }
    let open = 0;
    for (const c of clients.values()) if (c.userId === found.user.id) open++;
    if (open >= maxSocketsPerUser) {
      ws.close(1013, 'Too many connections');
      return;
    }
    // Workspaces from before the members doc, or a missed refresh: catch it up first.
    await ctx.members.refresh(workspaceId).catch((error: unknown) => {
      app.log.warn({ err: error, workspaceId }, 'members doc refresh failed');
    });
    if (ws.readyState !== ws.OPEN) return;

    // What this person may read and write, doc by doc (see access/service.ts).
    const access = await ctx.access.workspace(workspaceId);
    const roles = access.roles(found.user.id);
    if (ws.readyState !== ws.OPEN) return;
    const connection = hub.connect(
      workspaceId,
      {
        send: (data) => ws.send(data, { binary: true }),
        buffered: () => ws.bufferedAmount,
        close: (code, reason) => ws.close(code, reason),
      },
      {
        userId: found.user.id,
        userName: found.user.name,
        policy: access.policy(roles, found.user.id),
        scopes: access.accessScopes(roles, found.user.id),
        reconcile: (known, cursor) => access.reconcile(roles, known, cursor),
      },
    );
    const client: Client = {
      token,
      userId: found.user.id,
      workspaceId,
      connection,
      alive: true,
      roles,
    };
    clients.set(ws, client);
    const receive = (data: RawData, binary: boolean) => {
      if (!binary) connection.close(CloseCode.protocol, 'Binary messages only');
      else connection.receive(data as Buffer);
    };
    ws.off('message', hold);
    ws.on('message', receive);
    ws.on('pong', () => (client.alive = true));
    ws.on('close', () => {
      clients.delete(ws);
      connection.onSocketClosed();
    });
    for (const m of early) receive(m.data, m.binary);
    app.log.debug({ userId: found.user.id, workspaceId }, 'sync connected');
  }

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname;
    const match = PATH.exec(path);
    socket.on('error', () => {});
    if (!match) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      accept(ws, request, match[1]!.toLowerCase()).catch((error: unknown) => {
        app.log.error({ err: error }, 'sync upgrade failed');
        ws.close(1011, 'Server error');
      });
    });
  };
  app.server.on('upgrade', onUpgrade);

  // Drop sockets that stopped answering (a laptop that went to sleep, a dead NAT entry).
  const heartbeat = setInterval(() => {
    for (const [ws, client] of clients) {
      if (!client.alive) {
        ws.terminate();
        continue;
      }
      client.alive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  // Signed out elsewhere, disabled, or removed from the workspace: close the socket.
  let rechecking = false;
  const recheck = setInterval(() => {
    if (rechecking) return;
    rechecking = true;
    void (async () => {
      for (const [ws, client] of [...clients]) {
        const found = await store.accounts.sessionByToken(client.token);
        if (!found) {
          ws.close(CloseCode.unauthenticated, 'Signed out');
        } else if (!(await store.roleOf(client.workspaceId, client.userId))) {
          ws.close(CloseCode.forbidden, 'No access to this workspace');
        } else {
          // A device that only syncs is still using its session: keep it from expiring.
          await touch(ctx, found.session);
        }
      }
    })()
      .catch((error: unknown) => app.log.warn({ err: error }, 'sync session check failed'))
      .finally(() => (rechecking = false));
  }, recheckMs);
  recheck.unref();

  // Merge long update logs into one row per doc, then tell the sockets.
  let compacting = false;
  const compaction =
    compactEveryMs === null
      ? null
      : setInterval(() => {
          if (compacting) return;
          compacting = true;
          void compactAll()
            .catch((error: unknown) => app.log.warn({ err: error }, 'compaction failed'))
            .finally(() => (compacting = false));
        }, compactEveryMs);
  compaction?.unref();
  async function compactAll() {
    const { rows } = await store.pool.query<{ id: string }>('SELECT id FROM workspaces');
    for (const { id } of rows) {
      let changed = 0;
      for (const doc of await store.docsToCompact(id, compactThreshold)) {
        if ((await store.compactDoc(id, doc)) !== null) changed++;
      }
      if (changed > 0) {
        hub.notify(id);
        ctx.indexer.schedule(id);
        ctx.notifier.schedule(id);
        ctx.automations.schedule(id);
        app.log.info({ workspaceId: id, docs: changed }, 'compacted');
      }
    }
  }

  app.addHook('preClose', async () => {
    stopAccess();
    clearInterval(heartbeat);
    clearInterval(recheck);
    if (compaction) clearInterval(compaction);
    app.server.off('upgrade', onUpgrade);
    hub.closeAll(CloseCode.goingAway, 'Server restarting');
    // Give clients a moment to finish the close handshake, then cut the rest.
    const deadline = Date.now() + 2000;
    while (clients.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const ws of clients.keys()) ws.terminate();
    wss.close();
  });

  // Access changed: each connection of the workspace gets its new policy and scopes, the
  // docs it gained (whole) and the ones it lost.
  const stopAccess = ctx.access.onChange((event) => {
    for (const client of clients.values()) {
      if (client.workspaceId !== event.workspaceId) continue;
      void reauthorize(client, event).catch((error: unknown) =>
        app.log.error({ err: error }, 'reauthorize failed'),
      );
    }
  });
  async function reauthorize(client: Client, event: AccessEvent) {
    const access = await ctx.access.workspace(client.workspaceId);
    const roles = access.roles(client.userId);
    const old = client.roles;
    client.roles = roles;
    const readable = (r: Roles, scopeId: string) => atLeast(r.get(scopeId), 'view');
    const gainedScopes = [...roles.keys()].filter(
      (id) => readable(roles, id) && !readable(old, id),
    );
    const lostScopes = [...old.keys()].filter((id) => readable(old, id) && !readable(roles, id));
    const gained = new Set(gainedScopes.flatMap((id) => access.docsIn(id)));
    const lost = new Set(lostScopes.flatMap((id) => access.docsIn(id)));
    if (event.kind === 'moved') {
      for (const docId of event.docIds) {
        const before = readable(old, event.from);
        const after = readable(roles, event.to);
        if (after && !before) gained.add(docId);
        if (before && !after) lost.add(docId);
      }
    }
    for (const docId of gained) lost.delete(docId);
    client.connection.reauthorize({
      policy: access.policy(roles, client.userId),
      scopes: access.accessScopes(roles, client.userId),
      gained: [...gained],
      lost: [...lost],
      lostScopes,
      reconcile: (known, cursor) => access.reconcile(roles, known, cursor),
    });
  }

  /** Close a user's sockets on a workspace (see `Realtime.disconnect`). */
  function disconnect(workspaceId: string, userId: string, removed: boolean) {
    for (const [ws, client] of clients) {
      if (client.workspaceId !== workspaceId || client.userId !== userId) continue;
      if (removed) ws.close(CloseCode.forbidden, 'No access to this workspace');
      else ws.close(CloseCode.goingAway, 'Your access changed');
    }
  }

  return { hub, compactAll, clients, disconnect };
}
