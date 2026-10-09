/**
 * Checking an update to a database doc (the server, for the "can edit content" role):
 * someone with that role adds, edits, reorders and trashes rows, but doesn't change the
 * database itself (its properties, views or settings).
 */
import * as Y from 'yjs';
import { ROWS_MAP } from './schema';

/** The name of the top-level type an item is in (`rows`, `schema`, ...). */
function rootOf(doc: Y.Doc, item: Y.Item): string | null {
  let type = item.parent as Y.AbstractType<unknown> | null;
  while (type?._item) type = type._item.parent as Y.AbstractType<unknown> | null;
  if (!type) return null;
  for (const [name, root] of doc.share) if (root === type) return name;
  return null;
}

/**
 * Does this update change only rows? Returns a reason when it changes anything else
 * (properties, views, settings, or a part this code doesn't know).
 */
export function checkRowsOnlyChange(before: Y.Doc, update: Uint8Array): string | null {
  const after = new Y.Doc({ gc: false });
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  try {
    Y.applyUpdate(after, update);
    // Changes that wait for others this doc doesn't have can't be checked (and would
    // land unchecked later): refused.
    if (after.store.pendingStructs || after.store.pendingDs) return 'depends on unknown changes';
    const touched = new Set<string>();
    const { structs, ds } = Y.decodeUpdate(update);
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      const item = Y.getItem(after.store, struct.id);
      if (!(item instanceof Y.Item)) continue;
      touched.add(rootOf(after, item) ?? '?');
    }
    for (const [client, deletes] of ds.clients) {
      const all = after.store.clients.get(client);
      if (!all) continue;
      for (const { clock, len } of deletes) {
        for (let i = Y.findIndexSS(all, clock); i < all.length; i++) {
          const struct = all[i]!;
          if (struct.id.clock >= clock + len) break;
          if (struct instanceof Y.Item) touched.add(rootOf(after, struct) ?? '?');
        }
      }
    }
    for (const name of touched) {
      if (name !== ROWS_MAP) return name === '?' ? 'unknown part' : `changed "${name}"`;
    }
    return null;
  } catch {
    return 'malformed update';
  } finally {
    after.destroy();
  }
}
