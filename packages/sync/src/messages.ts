/**
 * The sync protocol's messages and their binary encoding (lib0 varints, like y-protocols).
 *
 * One WebSocket per workspace. A *replica* (the desktop) holds every doc it may read and
 * keeps a cursor: the newest `seq` of the workspace's update log it has seen. A *partial*
 * client (the web app) opens only the docs it shows.
 *
 * client → server                              server → client
 *   hello {mode, cursor, device, known}          access {scopes}            (on connecting and on changes)
 *   push {items: localId, doc, update, scope}    updates {cursor, items}    (catch-up and live)
 *   open {doc} / close {doc}  (partial)          caught-up {cursor}         (after the first catch-up)
 *   watch {doc} / unwatch {doc}                  awareness {doc, update}    (presence: others on a doc)
 *   awareness {doc, update}                      notify {payload}           (a notification, as JSON)
 *                                                ack {items: localId, seq, denied}
 *                                                state {doc, update}        (reply to open; or the
 *                                                                            server's copy after a denial)
 *                                                refused {doc}              (open of a doc you can't read)
 *                                                backfill {items}           (docs you just gained)
 *                                                revoke {docs, scopes}      (docs you just lost)
 *                                                error {code, message}
 *
 * Version 2 (Phase 5) adds access: the server sends a connection only the docs it may
 * read, and stores pushes only to docs it may write. A push to a doc the server hasn't
 * seen names the scope to place it in.
 *
 * Version 3 adds presence: a client watches the docs it shows and sends y-protocols
 * awareness updates for them (cursors, who's here); the server stamps each state with the
 * signed-in account and relays it to the others watching the doc who may read it.
 *
 * Version 4 adds notifications: the server sends each of a user's connections the
 * notifications made for them (mentions, replies, reminders…) as they happen.
 */
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';

export const PROTOCOL_VERSION = 4;

/** Largest message a client may send (the server's WebSocket limit). */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Largest single update a client may push. */
export const MAX_UPDATE_BYTES = 8 * 1024 * 1024;
/** Most updates in one push. */
export const MAX_PUSH_ITEMS = 500;
/** Doc ids are short identifiers ("workspace", uuids). */
export const MAX_DOC_ID_LENGTH = 128;
const DEVICE_ID_LENGTH = 128;
/** Largest awareness update a client may send (a few cursors' worth of JSON). */
export const MAX_AWARENESS_BYTES = 64 * 1024;
/** Largest notification the server sends (JSON). */
export const MAX_NOTIFY_BYTES = 64 * 1024;

export type SyncMode = 'replica' | 'partial';

export interface PushItem {
  /** The client's own id for the update (its outbox row), echoed in the ack. */
  localId: number;
  docId: string;
  update: Uint8Array;
  /** Where to place a doc the server hasn't seen yet (a scope id); ignored otherwise. */
  scope?: string | null;
}

/** What a scope is and what this connection's user may do in it. */
export interface AccessScope {
  id: string;
  kind: 'teamspace' | 'private' | 'shared';
  name: string;
  /** The doc holding the scope's page tree. */
  treeDoc: string;
  /** The scope a shared page was split from ('' for none). */
  parent: string;
  role: ScopeRole;
}

export type ScopeRole = 'full' | 'edit' | 'comment' | 'view';
const ROLES: readonly ScopeRole[] = ['full', 'edit', 'comment', 'view'];
const KINDS: readonly AccessScope['kind'][] = ['teamspace', 'private', 'shared'];
/** Most scopes in an access message. */
export const MAX_SCOPES = 10_000;

export type ClientMessage =
  | {
      type: 'hello';
      protocol: number;
      mode: SyncMode;
      cursor: number;
      deviceId: string;
      /**
       * Scopes a replica holds the docs of (from its last `access`). The server compares
       * them with the user's access now: revoking what was lost and backfilling what was
       * gained while the device was away.
       */
      known: string[];
    }
  | { type: 'push'; items: PushItem[] }
  | { type: 'open'; docId: string }
  | { type: 'close'; docId: string }
  /** Presence: the client shows this doc (and wants others' awareness of it). */
  | { type: 'watch'; docId: string }
  | { type: 'unwatch'; docId: string }
  /** A y-protocols awareness update for a watched doc. */
  | { type: 'awareness'; docId: string; update: Uint8Array };

export type ServerMessage =
  | { type: 'updates'; cursor: number; items: { docId: string; update: Uint8Array }[] }
  | { type: 'caught-up'; cursor: number }
  /** `seq` is 0 for a denied item (not stored). */
  | { type: 'ack'; items: { localId: number; seq: number; denied: boolean }[] }
  | { type: 'state'; docId: string; update: Uint8Array }
  | { type: 'refused'; docId: string }
  | { type: 'access'; scopes: AccessScope[] }
  | { type: 'backfill'; items: { docId: string; update: Uint8Array }[] }
  /** `scopes`: whole scopes lost (the client stops claiming them right away). */
  | { type: 'revoke'; docIds: string[]; scopes: string[] }
  /** Others' presence on a watched doc (y-protocols awareness, `user` set by the server). */
  | { type: 'awareness'; docId: string; update: Uint8Array }
  /** A notification for the signed-in user (JSON; see `@workspace/core` notifications). */
  | { type: 'notify'; payload: string }
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
  refused: 15,
  access: 16,
  backfill: 17,
  revoke: 18,
  watch: 5,
  unwatch: 6,
  awarenessIn: 7,
  awarenessOut: 19,
  notify: 20,
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
      encoding.writeVarUint(e, message.known.length);
      for (const id of message.known) encoding.writeVarString(e, id);
      break;
    case 'push':
      encoding.writeVarUint(e, T.push);
      encoding.writeVarUint(e, message.items.length);
      for (const item of message.items) {
        encoding.writeVarUint(e, item.localId);
        encoding.writeVarString(e, item.docId);
        encoding.writeVarUint8Array(e, item.update);
        encoding.writeVarString(e, item.scope ?? '');
      }
      break;
    case 'open':
    case 'close':
      encoding.writeVarUint(e, message.type === 'open' ? T.open : T.close);
      encoding.writeVarString(e, message.docId);
      break;
    case 'watch':
    case 'unwatch':
      encoding.writeVarUint(e, message.type === 'watch' ? T.watch : T.unwatch);
      encoding.writeVarString(e, message.docId);
      break;
    case 'awareness':
      encoding.writeVarUint(e, T.awarenessIn);
      encoding.writeVarString(e, message.docId);
      encoding.writeVarUint8Array(e, message.update);
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
        encoding.writeVarUint(e, item.denied ? 1 : 0);
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
    case 'refused':
      encoding.writeVarUint(e, T.refused);
      encoding.writeVarString(e, message.docId);
      break;
    case 'access':
      encoding.writeVarUint(e, T.access);
      encoding.writeVarUint(e, message.scopes.length);
      for (const scope of message.scopes) {
        encoding.writeVarString(e, scope.id);
        encoding.writeVarUint(e, KINDS.indexOf(scope.kind));
        encoding.writeVarString(e, scope.name);
        encoding.writeVarString(e, scope.treeDoc);
        encoding.writeVarString(e, scope.parent);
        encoding.writeVarUint(e, ROLES.indexOf(scope.role));
      }
      break;
    case 'backfill':
      encoding.writeVarUint(e, T.backfill);
      encoding.writeVarUint(e, message.items.length);
      for (const item of message.items) {
        encoding.writeVarString(e, item.docId);
        encoding.writeVarUint8Array(e, item.update);
      }
      break;
    case 'revoke':
      encoding.writeVarUint(e, T.revoke);
      encoding.writeVarUint(e, message.docIds.length);
      for (const id of message.docIds) encoding.writeVarString(e, id);
      encoding.writeVarUint(e, message.scopes.length);
      for (const id of message.scopes) encoding.writeVarString(e, id);
      break;
    case 'awareness':
      encoding.writeVarUint(e, T.awarenessOut);
      encoding.writeVarString(e, message.docId);
      encoding.writeVarUint8Array(e, message.update);
      break;
    case 'notify':
      encoding.writeVarUint(e, T.notify);
      encoding.writeVarString(e, message.payload);
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
      const cursor = r.uint();
      const deviceId = r.string(DEVICE_ID_LENGTH);
      const count = r.uint();
      if (count > MAX_SCOPES) throw new ProtocolError('Too many scopes');
      const known: string[] = [];
      for (let i = 0; i < count; i++) known.push(r.string(MAX_DOC_ID_LENGTH));
      message = {
        type: 'hello',
        protocol,
        mode: mode === 0 ? 'replica' : 'partial',
        cursor,
        deviceId,
        known,
      };
      break;
    }
    case T.push: {
      const count = r.uint();
      if (count === 0 || count > MAX_PUSH_ITEMS) throw new ProtocolError('Bad push size');
      const items: PushItem[] = [];
      for (let i = 0; i < count; i++) {
        const localId = r.uint();
        const docId = r.docId();
        const update = r.bytes(MAX_UPDATE_BYTES);
        const scope = r.string(MAX_DOC_ID_LENGTH);
        items.push({ localId, docId, update, scope: scope || null });
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
    case T.watch:
      message = { type: 'watch', docId: r.docId() };
      break;
    case T.unwatch:
      message = { type: 'unwatch', docId: r.docId() };
      break;
    case T.awarenessIn:
      message = { type: 'awareness', docId: r.docId(), update: r.bytes(MAX_AWARENESS_BYTES) };
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
      for (let i = 0; i < count; i++) {
        items.push({ localId: r.uint(), seq: r.uint(), denied: r.uint() === 1 });
      }
      message = { type: 'ack', items };
      break;
    }
    case T.state:
      message = { type: 'state', docId: r.docId(), update: r.bytes(Number.MAX_SAFE_INTEGER) };
      break;
    case T.error:
      message = { type: 'error', code: r.string(64), message: r.string(1000) };
      break;
    case T.refused:
      message = { type: 'refused', docId: r.docId() };
      break;
    case T.access: {
      const count = r.uint();
      if (count > MAX_SCOPES) throw new ProtocolError('Too many scopes');
      const scopes: AccessScope[] = [];
      for (let i = 0; i < count; i++) {
        const id = r.string(MAX_DOC_ID_LENGTH);
        const kind = KINDS[r.uint()];
        const name = r.string(1000);
        const treeDoc = r.docId();
        const parent = r.string(MAX_DOC_ID_LENGTH);
        const role = ROLES[r.uint()];
        if (!kind || !role) throw new ProtocolError('Unknown scope kind or role');
        scopes.push({ id, kind, name, treeDoc, parent, role });
      }
      message = { type: 'access', scopes };
      break;
    }
    case T.backfill: {
      const count = r.uint();
      const items = [];
      for (let i = 0; i < count; i++) {
        items.push({ docId: r.docId(), update: r.bytes(Number.MAX_SAFE_INTEGER) });
      }
      message = { type: 'backfill', items };
      break;
    }
    case T.revoke: {
      const count = r.uint();
      const docIds = [];
      for (let i = 0; i < count; i++) docIds.push(r.docId());
      const scopeCount = r.uint();
      if (scopeCount > MAX_SCOPES) throw new ProtocolError('Too many scopes');
      const scopes = [];
      for (let i = 0; i < scopeCount; i++) scopes.push(r.string(MAX_DOC_ID_LENGTH));
      message = { type: 'revoke', docIds, scopes };
      break;
    }
    case T.awarenessOut:
      message = {
        type: 'awareness',
        docId: r.docId(),
        update: r.bytes(Number.MAX_SAFE_INTEGER),
      };
      break;
    case T.notify:
      message = { type: 'notify', payload: r.string(MAX_NOTIFY_BYTES) };
      break;
    default:
      throw new ProtocolError('Unknown message type');
  }
  r.end();
  return message;
}
