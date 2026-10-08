/**
 * Presence on the server: who is on which doc, as y-protocols awareness states.
 *
 * An awareness update is a list of entries `{clientID, clock, state}` (the state is JSON,
 * or `null` for "gone"). The hub keeps the latest entry of every client watching a doc,
 * so someone who starts watching sees everyone at once, and it stamps each state's `user`
 * with the account of the connection that sent it: nobody can appear as someone else, or
 * move or remove another connection's cursor.
 */
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { ProtocolError } from './messages';

export interface AwarenessEntry {
  clientID: number;
  clock: number;
  /** JSON, or 'null' when the client left. */
  state: string;
}

/** Most entries in one update (one per window showing the doc, normally one). */
const MAX_ENTRIES = 64;
/** Largest single state (a user, a cursor, a little more). */
const MAX_STATE_CHARS = 8 * 1024;

export function decodeAwareness(update: Uint8Array): AwarenessEntry[] {
  try {
    const d = decoding.createDecoder(update);
    const count = decoding.readVarUint(d);
    if (count > MAX_ENTRIES) throw new ProtocolError('Too many awareness entries');
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientID = decoding.readVarUint(d);
      const clock = decoding.readVarUint(d);
      const state = decoding.readVarString(d);
      if (state.length > MAX_STATE_CHARS) throw new ProtocolError('Awareness state too large');
      entries.push({ clientID, clock, state });
    }
    if (d.pos !== update.length) throw new ProtocolError('Trailing bytes');
    return entries;
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('Malformed awareness update');
  }
}

export function encodeAwareness(entries: readonly AwarenessEntry[]): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(e, entry.clientID);
    encoding.writeVarUint(e, entry.clock);
    encoding.writeVarString(e, entry.state);
  }
  return encoding.toUint8Array(e);
}

/** Who a presence state is: the signed-in account, as the server says. */
export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

/** Cursor colors (readable on light and dark backgrounds); the same as `@workspace/core`'s. */
const COLORS = [
  '#e03e3e',
  '#d9730d',
  '#c29b00',
  '#0f7b6c',
  '#0b6e99',
  '#6940a5',
  '#ad1a72',
  '#2e7d32',
  '#1565c0',
  '#8e5a2b',
];

/** A person's cursor color: the same everywhere, from their id. */
export function presenceColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

/** A state with its `user` replaced (`null` stays `null`; junk becomes `null`). */
export function stampUser(state: string, user: PresenceUser): string {
  if (state === 'null') return state;
  let parsed: unknown;
  try {
    parsed = JSON.parse(state);
  } catch {
    return 'null';
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'null';
  return JSON.stringify({ ...(parsed as Record<string, unknown>), user });
}

interface Held<C> {
  clock: number;
  state: string;
  owner: C;
}

/**
 * The presence of one doc: the latest state of each client, and who's watching. `C` is
 * a connection (anything comparable by identity).
 */
export class PresenceRoom<C> {
  readonly watchers = new Set<C>();
  private readonly states = new Map<number, Held<C>>();

  get empty(): boolean {
    return this.watchers.size === 0;
  }

  /** Everyone's current state, for someone starting to watch (null if nobody's here). */
  snapshot(exclude?: C): Uint8Array | null {
    const entries: AwarenessEntry[] = [];
    for (const [clientID, held] of this.states) {
      if (held.owner !== exclude && held.state !== 'null') {
        entries.push({ clientID, clock: held.clock, state: held.state });
      }
    }
    return entries.length > 0 ? encodeAwareness(entries) : null;
  }

  /**
   * An update from `owner`: entries for clients another connection has are dropped,
   * the rest stamped with `user`. Returns the update to relay (null if nothing's left).
   */
  receive(owner: C, entries: AwarenessEntry[], user: PresenceUser): Uint8Array | null {
    const kept: AwarenessEntry[] = [];
    for (const entry of entries) {
      const held = this.states.get(entry.clientID);
      if (held && held.owner !== owner) continue;
      const state = stampUser(entry.state, user);
      if (state === 'null') this.states.delete(entry.clientID);
      else this.states.set(entry.clientID, { clock: entry.clock, state, owner });
      kept.push({ ...entry, state });
    }
    return kept.length > 0 ? encodeAwareness(kept) : null;
  }

  /**
   * `owner` stopped watching (or went away): its clients are removed. The removal keeps
   * each client's clock (with a null state), so when it comes back, its next state (a
   * newer clock) is taken. Returns the update to relay (null if it had none).
   */
  leave(owner: C): Uint8Array | null {
    this.watchers.delete(owner);
    const gone: AwarenessEntry[] = [];
    for (const [clientID, held] of this.states) {
      if (held.owner !== owner) continue;
      this.states.delete(clientID);
      gone.push({ clientID, clock: held.clock, state: 'null' });
    }
    return gone.length > 0 ? encodeAwareness(gone) : null;
  }
}

// --- Client side ---------------------------------------------------------------------------

export interface PresenceHooks {
  /** Others' presence on a watched doc (a y-protocols awareness update). */
  onAwareness?(docId: string, update: Uint8Array): void;
  /**
   * The connection is (re)established and the watches sent again: announce your own
   * state again (the server dropped it when the last connection went).
   */
  onPresenceRejoin?(): void;
}

type PresenceMessage =
  | { type: 'watch'; docId: string }
  | { type: 'unwatch'; docId: string }
  | { type: 'awareness'; docId: string; update: Uint8Array };

/** A client's watched docs, kept across reconnects. */
export class ClientPresence {
  private readonly watched = new Set<string>();

  constructor(
    /** Send if connected (else drop: presence isn't queued). */
    private readonly send: (message: PresenceMessage) => void,
    private readonly hooks: PresenceHooks,
  ) {}

  watch(docId: string): void {
    if (this.watched.has(docId)) return;
    this.watched.add(docId);
    this.send({ type: 'watch', docId });
  }

  unwatch(docId: string): void {
    if (!this.watched.delete(docId)) return;
    this.send({ type: 'unwatch', docId });
  }

  awareness(docId: string, update: Uint8Array): void {
    if (this.watched.has(docId)) this.send({ type: 'awareness', docId, update });
  }

  /** @internal Right after hello on a new connection. */
  connected(): void {
    for (const docId of this.watched) this.send({ type: 'watch', docId });
    if (this.watched.size > 0) this.hooks.onPresenceRejoin?.();
  }

  /** @internal An awareness message arrived. */
  receive(docId: string, update: Uint8Array): void {
    if (this.watched.has(docId)) this.hooks.onAwareness?.(docId, update);
  }
}
