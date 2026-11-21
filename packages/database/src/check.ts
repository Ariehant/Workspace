/**
 * Checking an update to a database doc (the server, for the "can edit content" and "can
 * create pages" roles): someone with either adds, edits, reorders and trashes rows, but
 * doesn't change the database itself (its properties, views or settings); with "can create
 * pages", only rows they made.
 */
import * as Y from 'yjs';
import { ROWS_MAP, RowField } from './schema';

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

/** The row an item of the rows map belongs to (its key there), or null. */
function rowOf(rows: Y.Map<unknown>, item: Y.Item): string | null {
  let current: Y.Item | null = item;
  while (current) {
    if (current.parent === rows) return current.parentSub;
    current = (current.parent as Y.AbstractType<unknown> | null)?._item ?? null;
  }
  return null;
}

const creatorOf = (doc: Y.Doc, rowId: string): unknown => {
  const row = doc.getMap<unknown>(ROWS_MAP).get(rowId);
  return row instanceof Y.Map ? row.get(RowField.createdBy) : undefined;
};

/**
 * For "can create pages": does this update change only rows `userId` made? A new row must
 * say they made it; a row that was there must have been theirs already (and stay so).
 * Returns a reason when it doesn't.
 */
export function checkOwnRowsChange(
  before: Y.Doc,
  update: Uint8Array,
  userId: string,
): string | null {
  const rowsOnly = checkRowsOnlyChange(before, update);
  if (rowsOnly) return rowsOnly;
  const after = new Y.Doc({ gc: false });
  Y.applyUpdate(after, Y.encodeStateAsUpdate(before));
  try {
    Y.applyUpdate(after, update);
    const rows = after.getMap<unknown>(ROWS_MAP);
    const touched = new Set<string | null>();
    const { structs, ds } = Y.decodeUpdate(update);
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      const item = Y.getItem(after.store, struct.id);
      if (item instanceof Y.Item) touched.add(rowOf(rows, item));
    }
    for (const [client, deletes] of ds.clients) {
      const all = after.store.clients.get(client);
      if (!all) continue;
      for (const { clock, len } of deletes) {
        for (let i = Y.findIndexSS(all, clock); i < all.length; i++) {
          const struct = all[i]!;
          if (struct.id.clock >= clock + len) break;
          if (struct instanceof Y.Item) touched.add(rowOf(rows, struct));
        }
      }
    }
    for (const rowId of touched) {
      if (rowId === null) return 'changed the rows map itself';
      const was = creatorOf(before, rowId);
      const now = creatorOf(after, rowId);
      if (was === undefined) {
        if (now !== userId) return `a new row not made by them (${rowId})`;
      } else {
        if (was !== userId) return `changed someone else's row (${rowId})`;
        if (now !== undefined && now !== userId) return `changed who made a row (${rowId})`;
      }
    }
    return null;
  } catch {
    return 'malformed update';
  } finally {
    after.destroy();
  }
}
