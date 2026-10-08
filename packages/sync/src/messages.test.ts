import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import {
  MAX_PUSH_ITEMS,
  MAX_UPDATE_BYTES,
  ProtocolError,
  decodeClient,
  decodeServer,
  encodeClient,
  encodeServer,
  type ClientMessage,
  type ServerMessage,
} from './messages';

const bytes = (...values: number[]) => new Uint8Array(values);

describe('messages', () => {
  it('round-trips every message', () => {
    const client: ClientMessage[] = [
      {
        type: 'hello',
        protocol: 2,
        mode: 'replica',
        cursor: 2 ** 40,
        deviceId: 'dev-é',
        known: ['s1', 's2'],
      },
      { type: 'hello', protocol: 2, mode: 'partial', cursor: 0, deviceId: '', known: [] },
      {
        type: 'push',
        items: [
          { localId: 1, docId: 'workspace', update: bytes(1, 2, 3), scope: null },
          { localId: 99, docId: 'b2f6…', update: bytes(), scope: 'scope-1' },
        ],
      },
      { type: 'open', docId: 'page' },
      { type: 'close', docId: 'page' },
      { type: 'watch', docId: 'page' },
      { type: 'unwatch', docId: 'page' },
      { type: 'awareness', docId: 'page', update: bytes(1, 5, 7) },
    ];
    for (const m of client) expect(decodeClient(encodeClient(m))).toEqual(m);

    const server: ServerMessage[] = [
      { type: 'updates', cursor: 7, items: [{ docId: 'a', update: bytes(9) }] },
      { type: 'updates', cursor: 8, items: [] },
      { type: 'caught-up', cursor: 12 },
      {
        type: 'ack',
        items: [
          { localId: 3, seq: 40, denied: false },
          { localId: 4, seq: 0, denied: true },
        ],
      },
      { type: 'state', docId: 'a', update: bytes(0, 0) },
      { type: 'error', code: 'protocol', message: 'Bad' },
      { type: 'refused', docId: 'secret' },
      {
        type: 'access',
        scopes: [
          {
            id: 's1',
            kind: 'teamspace',
            name: 'Lab',
            treeDoc: 'workspace',
            parent: '',
            role: 'full',
          },
          { id: 's2', kind: 'shared', name: '', treeDoc: 'tree:s2', parent: 's1', role: 'view' },
          {
            id: 's3',
            kind: 'private',
            name: 'Private',
            treeDoc: 'tree:s3',
            parent: '',
            role: 'comment',
          },
        ],
      },
      { type: 'access', scopes: [] },
      { type: 'backfill', items: [{ docId: 'p', update: bytes(4, 2) }] },
      { type: 'revoke', docIds: ['p', 'q'], scopes: ['s9'] },
      { type: 'revoke', docIds: [], scopes: [] },
      { type: 'awareness', docId: 'page', update: bytes(1, 2) },
      { type: 'notify', payload: '{"kind":"mention","text":"Ada → ✓"}' },
    ];
    for (const m of server) expect(decodeServer(encodeServer(m))).toEqual(m);
  });

  it('copies updates out of the message buffer', () => {
    const data = encodeClient({
      type: 'push',
      items: [{ localId: 1, docId: 'a', update: bytes(5, 6) }],
    });
    const message = decodeClient(data);
    data.fill(0);
    expect(message.type === 'push' && [...message.items[0]!.update]).toEqual([5, 6]);
  });

  it('rejects anything malformed', () => {
    const bad = (build: (e: encoding.Encoder) => void) => {
      const e = encoding.createEncoder();
      build(e);
      return encoding.toUint8Array(e);
    };
    const cases: Uint8Array[] = [
      bytes(),
      bytes(99),
      // Truncated hello.
      bytes(1, 1),
      // Trailing bytes.
      new Uint8Array([...encodeClient({ type: 'open', docId: 'a' }), 0]),
      // Empty doc id.
      encodeClient({ type: 'open', docId: '' }),
      // Doc id too long.
      encodeClient({ type: 'open', docId: 'x'.repeat(200) }),
      // Unknown mode.
      bad((e) => {
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 5);
      }),
      // An empty push, and one with too many items.
      bad((e) => {
        encoding.writeVarUint(e, 2);
        encoding.writeVarUint(e, 0);
      }),
      bad((e) => {
        encoding.writeVarUint(e, 2);
        encoding.writeVarUint(e, MAX_PUSH_ITEMS + 1);
      }),
      // An update claiming more bytes than the message has, or than the limit.
      bad((e) => {
        encoding.writeVarUint(e, 2);
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, 'a');
        encoding.writeVarUint(e, 1000);
      }),
      bad((e) => {
        encoding.writeVarUint(e, 2);
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, 'a');
        encoding.writeVarUint(e, MAX_UPDATE_BYTES + 1);
      }),
      // Invalid UTF-8 in a doc id.
      bad((e) => {
        encoding.writeVarUint(e, 3);
        encoding.writeVarUint8Array(e, bytes(0xff, 0xfe));
      }),
      // A server message sent by a client.
      encodeServer({ type: 'caught-up', cursor: 1 }),
    ];
    for (const data of cases) expect(() => decodeClient(data)).toThrow(ProtocolError);
    expect(() => decodeServer(bytes(10, 1))).toThrow(ProtocolError);
  });

  it('does not read past the view into a pooled buffer', () => {
    // A message that claims a 3-byte update but only has 1, sitting in a bigger buffer.
    const pool = new Uint8Array(64).fill(7);
    const message = bad3();
    pool.set(message, 0);
    const view = pool.subarray(0, message.length);
    expect(() => decodeClient(view)).toThrow(ProtocolError);

    function bad3() {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint(e, 1);
      encoding.writeVarUint(e, 1);
      encoding.writeVarString(e, 'a');
      encoding.writeVarUint(e, 3);
      encoding.writeUint8(e, 1);
      return encoding.toUint8Array(e);
    }
  });
});
