/**
 * The sync protocol's messages and their binary encoding (lib0 varints, like y-protocols).
 *
 * One WebSocket per workspace. A *replica* (the desktop) holds every doc and keeps a
 * cursor: the newest `seq` of the workspace's update log it has applied. A *partial*
 * client (the web app) opens only the docs it shows.
 *
 * client → server                         server → client
 *   hello {mode, cursor, device}            updates {cursor, items}   (catch-up and live)
 *   push {items: localId, doc, update}      caught-up {cursor}        (after the first catch-up)
 *   open {doc} / close {doc}  (partial)     ack {items: localId, seq} (stored: safe to forget)
 *                                           state {doc, update}       (reply to open)
 *                                           error {code, message}
 */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const PROTOCOL_VERSION = 1;

/** Largest message a client may send (the server's WebSocket limit). */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Largest single update a client may push. */
export const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
/** Most updates in one push. */
export const MAX_PUSH_ITEMS = 500;
/** Doc ids are short identifiers ("workspace", uuids). */
export const MAX_DOC_ID_LENGTH = 128;
const DEVICE_ID_LENGTH = 128;

export type SyncMode = 'replica' | 'partial';

export interface PushItem {
  /** The client's own id for the update (its outbox row), echoed in the ack. */
  localId: number;
  docId: string;
  update: Uint8Array;
}

export type ClientMessage =
  | { type: 'hello'; protocol: number; mode: SyncMode; cursor: number; deviceId: string }
  | { type: 'push'; items: PushItem[] }
  | { type: 'open'; docId: string }
  | { type: 'close'; docId: string };

export type ServerMessage =
  | { type: 'updates'; cursor: number; items: { docId: string; update: Uint8Array }[] }
  | { type: 'caught-up'; cursor: number }
  | { type: 'ack'; items: { localId: number; seq: number }[] }
  | { type: 'state'; docId: string; update: Uint8Array }
  | { type: 'error'; code: string; message: string };

/** WebSocket close codes the server uses (4000–4999 are free for applications). */
export const CloseCode = {
  /** No valid session: sign in again. */
  unauthenticated: 4401,
  /** Signed in, but not a member of the workspace. */
  forbidden: 4403,
  /** The client broke the protocol (bad message, too large, wrong version). */
  protocol: 4400,
  /** The client didn't read fast enough. */
  slow: 4408,
  /** The server is shutting down (or restarting). */
  goingAway: 1001,
} as const;

export class ProtocolError extends Error {}

const T = {
  hello: 1,
  push: 2,
  open: 3,
  close: 4,
  updates: 10,
  caughtUp: 11,
  ack: 12,
  state: 13,
  error: 14,
} as const;

// --- Encoding ----------------------------------------------------------------------------

export function encodeClient(message: ClientMessage): Uint8Array {
  const e = encoding.createEncoder();
  switch (message.type) {
    case 'hello':
      encoding.writeVarUint(e, T.hello);
      encoding.writeVarUint(e, message.protocol);
      encoding.writeVarUint(e, message.mode === 'replica' ? 0 : 1);
      encoding.writeVarUint(e, message.cursor);
      encoding.writeVarString(e, message.deviceId);
      break;
    case 'push':
      encoding.writeVarUint(e, T.push);
      encoding.writeVarUint(e, message.items.length);
      for (const item of message.items) {
        encoding.writeVarUint(e, item.localId);
        encoding.writeVarString(e, item.docId);
        encoding.writeVarUint8Array(e, item.update);
      }
      break;
    case 'open':
    case 'close':
      encoding.writeVarUint(e, message.type === 'open' ? T.open : T.close);
      encoding.writeVarString(e, message.docId);
      break;
  }
  return encoding.toUint8Array(e);
}

export function encodeServer(message: ServerMessage): Uint8Array {
  const e = encoding.createEncoder();
  switch (message.type) {
    case 'updates':
      encoding.writeVarUint(e, T.updates);
      encoding.writeVarUint(e, message.cursor);
      encoding.writeVarUint(e, message.items.length);
      for (const item of message.items) {
        encoding.writeVarString(e, item.docId);
        encoding.writeVarUint8Array(e, item.update);
      }
      break;
    case 'caught-up':
      encoding.writeVarUint(e, T.caughtUp);
      encoding.writeVarUint(e, message.cursor);
      break;
    case 'ack':
      encoding.writeVarUint(e, T.ack);
      encoding.writeVarUint(e, message.items.length);
      for (const item of message.items) {
        encoding.writeVarUint(e, item.localId);
        encoding.writeVarUint(e, item.seq);
      }
      break;
    case 'state':
      encoding.writeVarUint(e, T.state);
      encoding.writeVarString(e, message.docId);
      encoding.writeVarUint8Array(e, message.update);
      break;
    case 'error':
      encoding.writeVarUint(e, T.error);
      encoding.writeVarString(e, message.code);
      encoding.writeVarString(e, message.message);
      break;
  }
  return encoding.toUint8Array(e);
}

// --- Decoding (everything checked: the other side may be anyone) ---------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class Reader {
  private readonly d: decoding.Decoder;
  constructor(private readonly data: Uint8Array) {
    this.d = decoding.createDecoder(data);
  }
  uint(): number {
    try {
      return decoding.readVarUint(this.d);
    } catch {
      throw new ProtocolError('Truncated message');
    }
  }
  bytes(max: number): Uint8Array {
    const length = this.uint();
    if (length > max) throw new ProtocolError(`Field of ${length} bytes is too large`);
    if (this.d.pos + length > this.data.length) throw new ProtocolError('Truncated message');
    // A copy: the message buffer may be pooled, and must not stay alive with the update.
    const out = this.data.slice(this.d.pos, this.d.pos + length);
    this.d.pos += length;
    return out;
  }
  string(maxChars: number): string {
    const raw = this.bytes(maxChars * 4);
    let text: string;
    try {
      text = utf8.decode(raw);
    } catch {
      throw new ProtocolError('Invalid UTF-8');
    }
    if (text.length > maxChars) throw new ProtocolError('String too long');
    return text;
  }
  docId(): string {
    const id = this.string(MAX_DOC_ID_LENGTH);
    if (!id) throw new ProtocolError('Empty doc id');
    return id;
  }
  end() {
    if (this.d.pos !== this.data.length) throw new ProtocolError('Trailing bytes');
  }
}

export function decodeClient(data: Uint8Array): ClientMessage {
  const r = new Reader(data);
  let message: ClientMessage;
  switch (r.uint()) {
    case T.hello: {
      const protocol = r.uint();
      const mode = r.uint();
      if (mode > 1) throw new ProtocolError('Unknown mode');
      message = {
        type: 'hello',
        protocol,
        mode: mode === 0 ? 'replica' : 'partial',
        cursor: r.uint(),
        deviceId: r.string(DEVICE_ID_LENGTH),
      };
      break;
    }
    case T.push: {
      const count = r.uint();
      if (count === 0 || count > MAX_PUSH_ITEMS) throw new ProtocolError('Bad push size');
      const items: PushItem[] = [];
      for (let i = 0; i < count; i++) {
        items.push({ localId: r.uint(), docId: r.docId(), update: r.bytes(MAX_UPDATE_BYTES) });
      }
      message = { type: 'push', items };
      break;
    }
    case T.open:
      message = { type: 'open', docId: r.docId() };
      break;
    case T.close:
      message = { type: 'close', docId: r.docId() };
      break;
    default:
      throw new ProtocolError('Unknown message type');
  }
  r.end();
  return message;
}

export function decodeServer(data: Uint8Array): ServerMessage {
  const r = new Reader(data);
  let message: ServerMessage;
  switch (r.uint()) {
    case T.updates: {
      const cursor = r.uint();
      const count = r.uint();
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push({ docId: r.docId(), update: r.bytes(Number.MAX_SAFE_INTEGER) });
      }
      message = { type: 'updates', cursor, items };
      break;
    }
    case T.caughtUp:
      message = { type: 'caught-up', cursor: r.uint() };
      break;
    case T.ack: {
      const count = r.uint();
      const items = [];
      for (let i = 0; i < count; i++) items.push({ localId: r.uint(), seq: r.uint() });
      message = { type: 'ack', items };
      break;
    }
    case T.state:
      message = { type: 'state', docId: r.docId(), update: r.bytes(Number.MAX_SAFE_INTEGER) };
      break;
    case T.error:
      message = { type: 'error', code: r.string(64), message: r.string(1000) };
      break;
    default:
      throw new ProtocolError('Unknown message type');
  }
  r.end();
  return message;
}
