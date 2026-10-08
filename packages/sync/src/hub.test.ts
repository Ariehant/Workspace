import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SyncHub, type Access, type HubOptions, type Peer } from './hub';
import { MemoryLogStore } from './memory';
import {
  CloseCode,
  PROTOCOL_VERSION,
  decodeServer,
  encodeClient,
  type ClientMessage,
  type ServerMessage,
} from './messages';
import { sleep, until } from './test-net';
import { contentsOf } from './test-replica';

const WS = 'ws';

/** An update that appends `text` to a doc's text (from its own client). */
function edit(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function setup(options: HubOptions = {}) {
  const store = new MemoryLogStore();
  const hub = new SyncHub(store, options);
  const open = (access: Access = { canWrite: true }) => {
    const received: ServerMessage[] = [];
    const peer = {
      closed: null as null | { code: number; reason: string },
      buffered: 0,
      send: (data: Uint8Array) => received.push(decodeServer(data)),
      close(code: number, reason: string) {
        this.closed = { code, reason };
      },
    };
    const connection = hub.connect(
      WS,
      {
        ...peer,
        buffered: () => peer.buffered,
        close: peer.close.bind(peer),
        send: peer.send,
      } as Peer,
      access,
    );
    const send = (message: ClientMessage) => connection.receive(encodeClient(message));
    const hello = (cursor = 0, deviceId = 'dev', mode: 'replica' | 'partial' = 'replica') =>
      send({ type: 'hello', protocol: PROTOCOL_VERSION, mode, cursor, deviceId });
    return { received, peer, connection, send, hello };
  };
  return { store, hub, open };
}

const ofType = <T extends ServerMessage['type']>(list: ServerMessage[], type: T) =>
  list.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);

describe('SyncHub', () => {
  it('needs a hello first, and the same protocol version', async () => {
    const { open } = setup();
    const a = open();
    a.send({ type: 'open', docId: 'x' });
    await until(() => a.peer.closed !== null);
    expect(a.peer.closed!.code).toBe(CloseCode.protocol);
    expect(a.received[0]).toMatchObject({ type: 'error', code: 'protocol' });

    const b = open();
    b.send({ type: 'hello', protocol: 99, mode: 'replica', cursor: 0, deviceId: 'd' });
    await until(() => b.peer.closed !== null);
    expect(b.peer.closed).toEqual({ code: CloseCode.protocol, reason: 'Protocol version' });

    const c = open();
    c.connection.receive(new Uint8Array([200, 1]));
    await until(() => c.peer.closed !== null);
    expect(c.peer.closed!.code).toBe(CloseCode.protocol);
  });

  it('catches up in batches, merged per doc, and acknowledges pushes', async () => {
    const { store, open } = setup({ batchRows: 4, batchBytes: 10_000 });
    for (let i = 0; i < 10; i++) {
      await store.append(WS, [
        { docId: i % 2 ? 'odd' : 'even', data: edit(`${i}`), deviceId: 'x' },
      ]);
    }
    const a = open();
    a.hello(3);
    await until(() => ofType(a.received, 'caught-up').length === 1);
    const updates = ofType(a.received, 'updates');
    expect(updates.map((u) => u.cursor)).toEqual([7, 10]);
    // Rows 4–7 hold two docs: one merged update each.
    expect(updates[0]!.items.map((i) => i.docId).sort()).toEqual(['even', 'odd']);
    expect(ofType(a.received, 'caught-up')[0]!.cursor).toBe(10);

    a.send({ type: 'push', items: [{ localId: 5, docId: 'even', update: edit('new') }] });
    await until(() => ofType(a.received, 'ack').length === 1);
    expect(ofType(a.received, 'ack')[0]!.items).toEqual([{ localId: 5, seq: 11 }]);
    // Its own update isn't sent back, but the cursor still moves past it.
    await until(() => ofType(a.received, 'updates').length === 3);
    expect(ofType(a.received, 'updates')[2]).toEqual({ type: 'updates', cursor: 11, items: [] });
  });

  it('splits large catch-ups by size', async () => {
    const { store, open } = setup({ batchRows: 100, batchBytes: 50 });
    const big = edit('x'.repeat(40));
    for (let i = 0; i < 6; i++)
      await store.append(WS, [{ docId: `d${i}`, data: big, deviceId: null }]);
    const a = open();
    a.hello(0);
    await until(() => ofType(a.received, 'caught-up').length === 1);
    expect(ofType(a.received, 'updates').map((u) => u.cursor)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('broadcasts pushes to the other connections, live', async () => {
    const appended: string[] = [];
    const { open } = setup({ onAppend: (ws) => appended.push(ws) });
    const a = open();
    const b = open();
    a.hello(0, 'A');
    b.hello(0, 'B');
    await until(() => ofType(b.received, 'caught-up').length === 1);
    a.send({ type: 'push', items: [{ localId: 1, docId: 'p', update: edit('hi') }] });
    await until(() => ofType(b.received, 'updates').length === 1);
    const [update] = ofType(b.received, 'updates');
    expect(update!.cursor).toBe(1);
    expect(contentsOf(update!.items[0]!.update).t).toBe('hi');
    expect(appended).toEqual([WS]);
  });

  it('sends updates appended by another process after a gap', async () => {
    const { store, hub, open } = setup({ batchRows: 50 });
    const a = open();
    const b = open();
    a.hello(0, 'A');
    b.hello(0, 'B');
    await until(() => ofType(b.received, 'caught-up').length === 1);
    a.send({ type: 'push', items: [{ localId: 1, docId: 'p', update: edit('1') }] });
    await until(() => ofType(b.received, 'updates').length === 1);
    // Someone else appends seq 2 directly; then A pushes seq 3 through the hub. B must
    // get 2 as well, not jump from 1 to 3.
    await store.append(WS, [{ docId: 'q', data: edit('2'), deviceId: 'other' }]);
    a.send({ type: 'push', items: [{ localId: 2, docId: 'p', update: edit('3') }] });
    await until(() => ofType(b.received, 'updates').at(-1)?.cursor === 3);
    const docs = ofType(b.received, 'updates').flatMap((u) => u.items.map((i) => i.docId));
    expect(docs.sort()).toEqual(['p', 'p', 'q']);

    // And notify() sends what another process appended, without waiting for a push.
    await store.append(WS, [{ docId: 'q', data: edit('4'), deviceId: 'other' }]);
    hub.notify(WS);
    await until(() => ofType(b.received, 'updates').at(-1)?.cursor === 4);

    // A new connection catches up across the gap in the in-memory ring (1, 3).
    const c = open();
    c.hello(0, 'C');
    await until(() => ofType(c.received, 'caught-up').length === 1);
    expect(ofType(c.received, 'caught-up')[0]!.cursor).toBe(4);
  });

  it('opens docs for partial clients', async () => {
    const { store, open } = setup();
    await store.append(WS, [{ docId: 'p', data: edit('old'), deviceId: null }]);
    const web = open();
    const desk = open();
    web.hello(0, 'web', 'partial');
    desk.hello(0, 'desk');
    // A partial client doesn't catch up.
    await until(() => ofType(web.received, 'caught-up').length === 1);
    expect(ofType(web.received, 'caught-up')[0]!.cursor).toBe(1);
    expect(ofType(web.received, 'updates')).toEqual([]);

    web.send({ type: 'open', docId: 'p' });
    await until(() => ofType(web.received, 'state').length === 1);
    expect(contentsOf(ofType(web.received, 'state')[0]!.update).t).toBe('old');
    web.send({ type: 'open', docId: 'empty' });
    await until(() => ofType(web.received, 'state').length === 2);
    expect(contentsOf(ofType(web.received, 'state')[1]!.update).t).toBe('');

    // Only open docs' updates reach it.
    await until(() => ofType(desk.received, 'caught-up').length === 1);
    desk.send({
      type: 'push',
      items: [
        { localId: 1, docId: 'p', update: edit('new') },
        { localId: 2, docId: 'other', update: edit('x') },
      ],
    });
    await until(() => ofType(web.received, 'updates').length === 1);
    expect(ofType(web.received, 'updates')[0]!.items.map((i) => i.docId)).toEqual(['p']);

    web.send({ type: 'close', docId: 'p' });
    desk.send({ type: 'push', items: [{ localId: 3, docId: 'p', update: edit('more') }] });
    await until(() => ofType(desk.received, 'ack').length === 2);
    await sleep(10);
    expect(ofType(web.received, 'updates')).toHaveLength(1);

    // Replicas can't open docs.
    desk.send({ type: 'open', docId: 'p' });
    await until(() => desk.peer.closed !== null);
    expect(desk.peer.closed!.code).toBe(CloseCode.protocol);
  });

  it('refuses pushes from readers and malformed updates', async () => {
    const { store, open } = setup();
    const guest = open({ canWrite: false });
    guest.hello(0);
    guest.send({ type: 'push', items: [{ localId: 1, docId: 'p', update: edit('x') }] });
    await until(() => guest.peer.closed !== null);
    expect(guest.peer.closed!.code).toBe(CloseCode.forbidden);

    const a = open();
    a.hello(0);
    a.send({
      type: 'push',
      items: [{ localId: 1, docId: 'p', update: new Uint8Array([9, 9, 9]) }],
    });
    await until(() => a.peer.closed !== null);
    expect(a.peer.closed!.code).toBe(CloseCode.protocol);
    expect(await store.latest(WS)).toBe(0);
  });

  it('acknowledges but drops pushes to docs the connection may not write', async () => {
    const { store, open } = setup();
    const a = open({ canWrite: true, canWriteDoc: (docId) => docId !== 'members' });
    const b = open();
    a.hello(0, 'A');
    b.hello(0, 'B');
    a.send({
      type: 'push',
      items: [
        { localId: 1, docId: 'members', update: edit('me, admin') },
        { localId: 2, docId: 'p', update: edit('fine') },
      ],
    });
    await until(() => ofType(a.received, 'ack').length > 0);
    expect(ofType(a.received, 'ack')[0]!.items).toEqual([
      { localId: 1, seq: 0 },
      { localId: 2, seq: 1 },
    ]);
    expect(ofType(a.received, 'error')).toEqual([
      { type: 'error', code: 'denied', message: "You can't change members." },
    ]);
    expect(a.peer.closed).toBeNull();
    expect((await store.since(WS, 0, 10)).map((r) => r.docId)).toEqual(['p']);
    await until(() => ofType(b.received, 'updates').some((m) => m.items.length > 0));
    expect(ofType(b.received, 'updates').flatMap((m) => m.items.map((i) => i.docId))).toEqual([
      'p',
    ]);
  });

  it('appends the server’s own updates in order, with or without connections', async () => {
    const { store, hub, open } = setup();
    expect(await hub.appendFromServer(WS, [{ docId: 'members', data: edit('one') }])).toEqual([1]);
    const a = open();
    a.hello(0);
    await until(() => ofType(a.received, 'caught-up').length > 0);
    expect(await hub.appendFromServer(WS, [{ docId: 'members', data: edit('two') }])).toEqual([2]);
    await until(() => ofType(a.received, 'updates').flatMap((m) => m.items).length >= 2);
    expect((await store.since(WS, 0, 10)).map((r) => [r.seq, r.deviceId])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it('starts over when the client is ahead of the log (restored server)', async () => {
    const { store, open } = setup();
    await store.append(WS, [{ docId: 'p', data: edit('x'), deviceId: null }]);
    const a = open();
    a.hello(50);
    await until(() => ofType(a.received, 'caught-up').length === 1);
    expect(ofType(a.received, 'updates')[0]!.cursor).toBe(1);
    expect(ofType(a.received, 'caught-up')[0]!.cursor).toBe(1);
  });

  it('waits for slow sockets, and closes them if they stay stuck', async () => {
    let now = 0;
    const { store, open } = setup({
      batchRows: 1,
      maxBuffered: 100,
      slowTimeoutMs: 1000,
      now: () => now,
      sleep: async () => {
        now += 100;
        await sleep(0);
      },
    });
    for (let i = 0; i < 3; i++)
      await store.append(WS, [{ docId: 'p', data: edit(`${i}`), deviceId: null }]);
    const a = open();
    a.peer.buffered = 500;
    a.hello(0);
    await sleep(5);
    expect(ofType(a.received, 'updates')).toHaveLength(0);
    // The buffer drains: sending resumes.
    a.peer.buffered = 0;
    await until(() => ofType(a.received, 'caught-up').length === 1);

    const b = open();
    b.peer.buffered = 500;
    b.hello(0);
    await until(() => b.peer.closed !== null);
    expect(b.peer.closed).toEqual({ code: CloseCode.slow, reason: 'Too slow' });
  });

  it('closes everything on shutdown and forgets closed connections', async () => {
    const { hub, open } = setup();
    const a = open();
    open();
    expect(hub.connectionCount).toBe(2);
    a.connection.onSocketClosed();
    expect(hub.connectionCount).toBe(1);
    hub.closeAll();
    expect(hub.connectionCount).toBe(0);
  });
});
