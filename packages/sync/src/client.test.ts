import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SyncClient, type ClientSocket, type OutboxEntry, type SocketHandlers } from './client';
import {
  CloseCode,
  MAX_UPDATE_BYTES,
  decodeClient,
  encodeServer,
  type ClientMessage,
  type ServerMessage,
} from './messages';
import { until } from './test-net';

/** A client wired to a scripted server, with manual timers. */
function setup() {
  const sockets: { handlers: SocketHandlers; sent: ClientMessage[]; closed: boolean }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const state = {
    cursor: 0,
    outbox: [] as OutboxEntry[],
    applied: [] as { docIds: string[]; cursor: number }[],
    events: [] as string[],
    known: [] as string[],
  };
  const behind: number[][] = [];
  const oversized: number[] = [];
  const client = new SyncClient({
    deviceId: 'dev',
    store: {
      cursor: () => state.cursor,
      pending: (limit) => state.outbox.slice(0, limit),
      acknowledge: (ids) => {
        state.outbox = state.outbox.filter((e) => !ids.includes(e.localId));
      },
      applyRemote: (items, cursor) => {
        state.applied.push({ docIds: items.map((i) => i.docId), cursor });
        state.cursor = cursor;
      },
      denied: (items) => {
        state.events.push(`denied ${items.map((i) => `${i.localId}:${i.docId}`).join(',')}`);
      },
      reset: (docId) => {
        state.events.push(`reset ${docId}`);
      },
      applyBackfill: (items) => {
        state.events.push(`backfill ${items.map((i) => i.docId).join(',')}`);
      },
      revoke: (docIds, scopes) => {
        state.events.push(`revoke ${docIds.join(',')} [${scopes.join(',')}]`);
        state.known = state.known.filter((id) => !scopes.includes(id));
      },
      setAccess: (scopes) => {
        state.events.push(`access ${scopes.map((x) => x.id).join(',')}`);
        state.known = scopes.map((x) => x.id);
      },
      knownScopes: () => state.known,
      scopeOf: (docId) => (docId === 'p' ? 'scope-1' : null),
    },
    connect: (handlers): ClientSocket => {
      const socket = { handlers, sent: [] as ClientMessage[], closed: false };
      sockets.push(socket);
      return {
        send: (data) => socket.sent.push(decodeClient(data)),
        close: () => {
          socket.closed = true;
        },
      };
    },
    backoff: { minMs: 100, maxMs: 1000 },
    random: () => 1,
    now: () => 0,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => {},
    onServerBehind: (s, l) => behind.push([s, l]),
    onOversized: (e) => oversized.push(e.localId),
  });
  const last = () => sockets[sockets.length - 1]!;
  const reply = (message: ServerMessage) => last().handlers.onMessage(encodeServer(message));
  const entry = (localId: number, size = 3): OutboxEntry => ({
    localId,
    docId: 'p',
    update: new Uint8Array(size),
  });
  return { client, sockets, timers, state, last, reply, entry, behind, oversized };
}

describe('SyncClient', () => {
  it('says hello with its cursor, pushes the outbox, catches up, goes live', async () => {
    const t = setup();
    t.state.cursor = 7;
    t.state.outbox = [t.entry(1), t.entry(2)];
    const states: string[] = [];
    t.client.onStatus((s) => states.push(s.state));
    t.client.start();
    t.last().handlers.onOpen();
    await until(() => t.last().sent.length === 2);
    expect(t.last().sent[0]).toEqual({
      type: 'hello',
      protocol: 2,
      mode: 'replica',
      cursor: 7,
      deviceId: 'dev',
      known: [],
    });
    expect(t.last().sent[1]).toMatchObject({
      type: 'push',
      items: [{ localId: 1 }, { localId: 2 }],
    });

    t.reply({
      type: 'updates',
      cursor: 9,
      items: [{ docId: 'a', update: Y.encodeStateAsUpdate(new Y.Doc()) }],
    });
    t.reply({ type: 'caught-up', cursor: 9 });
    await t.client.idle();
    expect(t.state.applied).toEqual([{ docIds: ['a'], cursor: 9 }]);
    expect(states).toEqual(['connecting', 'catching-up', 'live']);

    // Only an ack trims the outbox; new entries are sent once the window is clear.
    t.state.outbox.push(t.entry(3));
    t.client.flush();
    await until(() => t.last().sent.length === 3);
    expect(t.last().sent[2]).toMatchObject({ type: 'push', items: [{ localId: 3 }] });
    t.reply({
      type: 'ack',
      items: [
        { localId: 1, seq: 10, denied: false },
        { localId: 2, seq: 11, denied: false },
      ],
    });
    await t.client.idle();
    expect(t.state.outbox.map((e) => e.localId)).toEqual([3]);
  });

  it('sends scope hints and known scopes, and hands access changes to the store', async () => {
    const t = setup();
    t.state.known = ['s1', 'gone'];
    t.state.outbox = [t.entry(1), { localId: 2, docId: 'q', update: new Uint8Array(2) }];
    t.client.start();
    t.last().handlers.onOpen();
    await until(() => t.last().sent.length === 2);
    expect(t.last().sent[0]).toMatchObject({ type: 'hello', known: ['s1', 'gone'] });
    expect(t.last().sent[1]).toMatchObject({
      type: 'push',
      items: [
        { localId: 1, docId: 'p', scope: 'scope-1' },
        { localId: 2, docId: 'q', scope: null },
      ],
    });
    const scope = {
      kind: 'teamspace' as const,
      name: '',
      treeDoc: 'x',
      parent: '',
      role: 'view' as const,
    };
    t.reply({ type: 'revoke', docIds: ['old'], scopes: ['gone'] });
    t.reply({ type: 'backfill', items: [{ docId: 'new', update: new Uint8Array(1) }] });
    t.reply({
      type: 'access',
      scopes: [
        { ...scope, id: 's1' },
        { ...scope, id: 's2' },
      ],
    });
    t.reply({
      type: 'ack',
      items: [
        { localId: 1, seq: 0, denied: true },
        { localId: 2, seq: 9, denied: false },
      ],
    });
    t.reply({ type: 'state', docId: 'p', update: new Uint8Array(1) });
    await t.client.idle();
    expect(t.state.events).toEqual([
      'revoke old [gone]',
      'backfill new',
      'access s1,s2',
      'denied 1:p',
      'reset p',
    ]);
    // Denied items are acknowledged too: the outbox moves on.
    expect(t.state.outbox).toEqual([]);
    expect(t.state.known).toEqual(['s1', 's2']);
  });

  it('resends unacknowledged updates after reconnecting, with backoff', async () => {
    const t = setup();
    t.state.outbox = [t.entry(1)];
    t.client.start();
    t.last().handlers.onOpen();
    await until(() => t.last().sent.length === 2);
    t.last().handlers.onClose(1006, '');
    expect(t.client.state).toMatchObject({ state: 'offline', reason: 'Connection closed (1006)' });
    // Backoff doubles up to the maximum (random() = 1: the full ceiling).
    expect(t.timers.map((x) => x.ms)).toEqual([100]);
    t.timers.shift()!.fn();
    t.last().handlers.onClose(1006, '');
    t.timers.shift()!.fn();
    t.last().handlers.onClose(1006, '');
    expect(t.timers.map((x) => x.ms)).toEqual([400]);
    t.timers.shift()!.fn();
    t.last().handlers.onOpen();
    await until(() => t.last().sent.length === 2);
    expect(t.last().sent[1]).toMatchObject({ type: 'push', items: [{ localId: 1 }] });
    // Going live resets the backoff.
    t.reply({ type: 'caught-up', cursor: 0 });
    await t.client.idle();
    t.last().handlers.onClose(1006, '');
    expect(t.timers.map((x) => x.ms)).toEqual([100]);
  });

  it('stops retrying when signed out or refused', async () => {
    for (const code of [CloseCode.unauthenticated, CloseCode.forbidden]) {
      const t = setup();
      t.client.start();
      t.last().handlers.onOpen();
      t.last().handlers.onClose(code, 'Session expired');
      expect(t.client.state).toEqual({ state: 'unauthorized', reason: 'Session expired' });
      expect(t.timers).toHaveLength(0);
    }
    const t = setup();
    t.client.start();
    t.last().handlers.onClose(CloseCode.protocol, 'Protocol version');
    expect(t.client.state.state).toBe('error');
  });

  it('ignores events from an old socket and stops cleanly', async () => {
    const t = setup();
    t.client.start();
    const first = t.last();
    t.client.stop();
    expect(first.closed).toBe(true);
    first.handlers.onClose(1000, '');
    expect(t.client.state).toEqual({ state: 'stopped' });
    expect(t.timers).toHaveLength(0);
  });

  it('reports a server that is behind, and updates too large to push', async () => {
    const t = setup();
    t.state.cursor = 50;
    t.state.outbox = [t.entry(1, MAX_UPDATE_BYTES + 1), t.entry(2)];
    t.client.start();
    t.last().handlers.onOpen();
    await until(() => t.last().sent.length === 2);
    expect(t.last().sent[1]).toMatchObject({ type: 'push', items: [{ localId: 2 }] });
    expect(t.oversized).toEqual([1]);
    t.reply({ type: 'caught-up', cursor: 10 });
    await t.client.idle();
    expect(t.behind).toEqual([[10, 50]]);
  });

  it('drops the connection when a message cannot be handled', async () => {
    const t = setup();
    t.client.start();
    t.last().handlers.onOpen();
    t.last().handlers.onMessage(new Uint8Array([250]));
    await t.client.idle();
    expect(t.last().closed).toBe(true);
  });

  it('pushes on a new connection even if an older pass was still reading the outbox', async () => {
    const sockets: { handlers: SocketHandlers; sent: ClientMessage[] }[] = [];
    const reads: ((entries: OutboxEntry[]) => void)[] = [];
    const client = new SyncClient({
      deviceId: 'dev',
      store: {
        cursor: () => 0,
        // Slow storage: each read waits until the test answers it.
        pending: () => new Promise((resolve) => reads.push(resolve)),
        acknowledge: () => {},
        applyRemote: () => {},
      },
      connect: (handlers) => {
        const socket = { handlers, sent: [] as ClientMessage[] };
        sockets.push(socket);
        return { send: (d) => socket.sent.push(decodeClient(d)), close: () => {} };
      },
      setTimer: (fn) => fn(),
      clearTimer: () => {},
    });
    const entry = { localId: 1, docId: 'p', update: new Uint8Array(1) };
    client.start();
    sockets[0]!.handlers.onOpen();
    await until(() => reads.length === 1);
    // The connection drops while the first read is pending; the client reconnects.
    sockets[0]!.handlers.onClose(1006, '');
    sockets[1]!.handlers.onOpen();
    await until(() => sockets[1]!.sent.length === 1);
    reads.shift()!([entry]);
    await until(() => reads.length === 1);
    reads.shift()!([entry]);
    await until(() => sockets[1]!.sent.length === 2);
    expect(sockets[1]!.sent[1]).toMatchObject({ type: 'push', items: [{ localId: 1 }] });
    expect(sockets[0]!.sent.filter((m) => m.type === 'push')).toHaveLength(0);
    client.stop();
  });
});
