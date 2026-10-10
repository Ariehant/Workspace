import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

/**
 * Updates too large to push in one piece (`MAX_UPDATE_BYTES`), as several smaller ones.
 *
 * Each part holds a run of one client's structs, in clock order, and the last part holds
 * the deletions; applied in order (or in any order: Yjs waits for what a part builds on),
 * the parts make the same doc as the whole. The server takes them as ordinary pushes, so
 * the protocol doesn't change.
 */

/** The size parts aim for: half the limit, so one struct can't take a part over it. */
const partBytes = (maxBytes: number) => Math.max(1, Math.floor(maxBytes / 2));

/**
 * `update` in parts of at most about `maxBytes` (a part holding one huge struct can be
 * larger). Null when the update builds on structs it doesn't hold, so it can't be read on
 * its own: split the doc's whole state instead (`splitDocState`).
 */
export function splitUpdate(update: Uint8Array, maxBytes: number): Uint8Array[] | null {
  if (update.byteLength <= maxBytes) return [update];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
    if (doc.store.pendingStructs || doc.store.pendingDs) return null;
    return splitDocState(doc, maxBytes);
  } finally {
    doc.destroy();
  }
}

/** A doc's whole state, in parts of at most about `maxBytes`. */
export function splitDocState(doc: Y.Doc, maxBytes: number): Uint8Array[] {
  const target = partBytes(maxBytes);
  const parts: Uint8Array[] = [];
  for (const [client, structs] of doc.store.clients) {
    let body = new Y.UpdateEncoderV1();
    let count = 0;
    let firstClock = 0;
    const flush = () => {
      if (count === 0) return;
      // One client's run: its struct count, client id and first clock, then the structs,
      // then an empty delete set.
      const part = new Y.UpdateEncoderV1();
      encoding.writeVarUint(part.restEncoder, 1);
      encoding.writeVarUint(part.restEncoder, count);
      part.writeClient(client);
      encoding.writeVarUint(part.restEncoder, firstClock);
      encoding.writeUint8Array(part.restEncoder, body.toUint8Array());
      encoding.writeVarUint(part.restEncoder, 0);
      parts.push(part.toUint8Array());
      body = new Y.UpdateEncoderV1();
      count = 0;
    };
    for (const struct of structs) {
      if (count > 0 && encoding.length(body.restEncoder) >= target) flush();
      if (count === 0) firstClock = struct.id.clock;
      struct.write(body, 0);
      count++;
    }
    flush();
  }
  // The deletions: an update with no structs and the doc's whole delete set.
  parts.push(Y.encodeStateAsUpdate(doc, Y.encodeStateVector(doc)));
  return parts;
}
