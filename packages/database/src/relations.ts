import * as Y from 'yjs';
import {
  addProperty,
  deleteProperty,
  getRowMap,
  hasRow,
  readMeta,
  readProperties,
  setMeta,
  setPropertyConfig,
  touchRow,
} from './doc';
import { relationIds } from './properties';
import { RowField, type Property } from './schema';

/** Finds a loaded database doc by id (relations can span databases). */
export type DocResolver = (databaseId: string) => Y.Doc | undefined;

const propertyIn = (doc: Y.Doc, id: string): Property | undefined =>
  readProperties(doc).find((p) => p.id === id);

export interface CreateRelationOptions {
  /** The database the relation is added to. */
  databaseId: string;
  name: string;
  /** The database it links to (may be the same one). */
  targetId: string;
  /** Also show the relation on the other side, under this name. */
  twoWay?: { name: string } | null;
  limitOne?: boolean;
  afterId?: string;
}

/** Add a relation property (and its synced counterpart for two-way relations). */
export function createRelation(
  resolve: DocResolver,
  options: CreateRelationOptions,
): { propertyId: string; syncedPropertyId: string | null } {
  const doc = resolve(options.databaseId);
  if (!doc) throw new Error(`Database not loaded: ${options.databaseId}`);
  const target = options.twoWay ? resolve(options.targetId) : doc;
  if (!target) throw new Error(`Database not loaded: ${options.targetId}`);
  const propertyId = addProperty(doc, {
    name: options.name,
    type: 'relation',
    config: {
      databaseId: options.targetId,
      syncedPropertyId: null,
      limitOne: options.limitOne ?? false,
    },
    afterId: options.afterId,
  });
  if (!options.twoWay) return { propertyId, syncedPropertyId: null };
  const syncedPropertyId = addProperty(target, {
    name: options.twoWay.name,
    type: 'relation',
    config: { databaseId: options.databaseId, syncedPropertyId: propertyId, limitOne: false },
  });
  const property = propertyIn(doc, propertyId)!;
  setPropertyConfig(doc, propertyId, { ...property.config, syncedPropertyId });
  return { propertyId, syncedPropertyId };
}

/** Change a relation's settings: limit, or turn the other side on or off. */
export function updateRelation(
  resolve: DocResolver,
  databaseId: string,
  propertyId: string,
  changes: { limitOne?: boolean; twoWay?: { name: string } | null },
): void {
  const doc = resolve(databaseId);
  const property = doc && propertyIn(doc, propertyId);
  if (!doc || !property || property.type !== 'relation') return;
  const targetId = property.config.databaseId ?? '';
  if (changes.limitOne !== undefined) {
    setPropertyConfig(doc, propertyId, {
      ...propertyIn(doc, propertyId)!.config,
      limitOne: changes.limitOne,
    });
  }
  if (changes.twoWay === undefined) return;
  const synced = property.config.syncedPropertyId;
  const target = resolve(targetId);
  if (changes.twoWay === null && synced) {
    // Keep the other side as a one-way relation.
    const other = target && propertyIn(target, synced);
    if (target && other)
      setPropertyConfig(target, synced, { ...other.config, syncedPropertyId: null });
    setPropertyConfig(doc, propertyId, {
      ...propertyIn(doc, propertyId)!.config,
      syncedPropertyId: null,
    });
  } else if (changes.twoWay && !synced && target) {
    const syncedPropertyId = addProperty(target, {
      name: changes.twoWay.name,
      type: 'relation',
      config: { databaseId, syncedPropertyId: propertyId, limitOne: false },
    });
    setPropertyConfig(doc, propertyId, {
      ...propertyIn(doc, propertyId)!.config,
      syncedPropertyId,
    });
    // Link existing values back.
    for (const [rowId, rowMap] of rowsWith(doc, propertyId)) {
      for (const id of relationIds(rowMap)) addLink(target, id, syncedPropertyId, rowId);
    }
  }
}

function* rowsWith(doc: Y.Doc, propertyId: string): Generator<[string, unknown]> {
  for (const [rowId, row] of doc.getMap<Y.Map<unknown>>('rows')) {
    const values = row.get(RowField.values);
    if (values instanceof Y.Map && values.has(propertyId)) {
      const v = values.get(propertyId);
      yield [rowId, v instanceof Y.Map ? v.toJSON() : v];
    }
  }
}

/** Read a row's linked ids for a relation. */
export function readRelation(doc: Y.Doc, rowId: string, propertyId: string): string[] {
  if (!hasRow(doc, rowId)) return [];
  const values = getRowMap(doc, rowId).get(RowField.values);
  if (!(values instanceof Y.Map)) return [];
  const v = values.get(propertyId);
  return relationIds(v instanceof Y.Map ? v.toJSON() : v);
}

let clock = 0;
/** Increasing "time added" stamps, so links keep the order they were made in. */
const stamp = () => {
  clock = Math.max(clock + 1, Date.now());
  return clock;
};

/** Make a row's links exactly `ids` (as a set CRDT: concurrent adds both survive). */
function writeIds(doc: Y.Doc, rowId: string, propertyId: string, ids: string[]): void {
  if (!hasRow(doc, rowId)) return;
  const row = getRowMap(doc, rowId);
  let values = row.get(RowField.values);
  if (!(values instanceof Y.Map)) {
    values = new Y.Map<unknown>();
    row.set(RowField.values, values);
  }
  const map = values as Y.Map<unknown>;
  let links = map.get(propertyId);
  if (!(links instanceof Y.Map)) {
    const previous = relationIds(links);
    links = new Y.Map<number>();
    map.set(propertyId, links);
    previous.forEach((id) => (links as Y.Map<number>).set(id, stamp()));
  }
  const set = links as Y.Map<number>;
  for (const id of [...set.keys()]) if (!ids.includes(id)) set.delete(id);
  for (const id of ids) if (!set.has(id)) set.set(id, stamp());
  if (ids.length === 0) map.delete(propertyId);
}

function addLink(
  doc: Y.Doc,
  rowId: string,
  propertyId: string,
  id: string,
  limitOne = false,
): string[] {
  const current = readRelation(doc, rowId, propertyId);
  if (current.includes(id) && !(limitOne && current.length > 1)) return [];
  doc.transact(() => writeIds(doc, rowId, propertyId, limitOne ? [id] : [...current, id]));
  return limitOne ? current.filter((c) => c !== id) : [];
}

function removeLink(doc: Y.Doc, rowId: string, propertyId: string, id: string): void {
  const current = readRelation(doc, rowId, propertyId);
  if (!current.includes(id)) return;
  doc.transact(() =>
    writeIds(
      doc,
      rowId,
      propertyId,
      current.filter((c) => c !== id),
    ),
  );
}

/**
 * Set the pages a row links to. For two-way relations the other side is updated
 * too (and a one-page limit on either side is respected).
 */
export function setRelation(
  resolve: DocResolver,
  databaseId: string,
  rowId: string,
  propertyId: string,
  ids: readonly string[],
  actor: string | null,
): void {
  const doc = resolve(databaseId);
  const property = doc && propertyIn(doc, propertyId);
  if (!doc || !property || property.type !== 'relation') return;
  const unique = [...new Set(ids)];
  const desired = property.config.limitOne ? unique.slice(-1) : unique;
  const previous = readRelation(doc, rowId, propertyId);
  doc.transact(() => {
    writeIds(doc, rowId, propertyId, desired);
    touchRow(doc, rowId, actor);
  });

  const syncedId = property.config.syncedPropertyId;
  const target = syncedId ? resolve(property.config.databaseId ?? '') : undefined;
  if (!syncedId || !target) return;
  const synced = propertyIn(target, syncedId);
  if (!synced) return;
  for (const id of desired.filter((d) => !previous.includes(d))) {
    // A one-page limit on the other side moves that page away from its old link.
    const displaced = addLink(target, id, syncedId, rowId, synced.config.limitOne);
    for (const old of displaced) removeLink(doc, old, propertyId, id);
  }
  for (const id of previous.filter((p) => !desired.includes(p)))
    removeLink(target, id, syncedId, rowId);
}

/** After copying a row, link the copy from the other side of its two-way relations. */
export function syncTwoWayLinks(resolve: DocResolver, databaseId: string, rowId: string): void {
  const doc = resolve(databaseId);
  if (!doc) return;
  for (const property of readProperties(doc)) {
    const syncedId = property.type === 'relation' ? property.config.syncedPropertyId : null;
    const target = syncedId ? resolve(property.config.databaseId ?? '') : undefined;
    if (!syncedId || !target) continue;
    for (const id of readRelation(doc, rowId, property.id)) addLink(target, id, syncedId, rowId);
  }
}

/** Delete a relation property; its counterpart (if any) becomes one-way. */
export function deleteRelation(resolve: DocResolver, databaseId: string, propertyId: string): void {
  updateRelation(resolve, databaseId, propertyId, { twoWay: null });
  const doc = resolve(databaseId);
  if (!doc) return;
  doc.transact(() => {
    // Sub-items and dependencies need both of their properties.
    const meta = readMeta(doc);
    if (meta.subItems && Object.values(meta.subItems).includes(propertyId)) {
      setMeta(doc, { subItems: null });
    }
    if (meta.dependencies && Object.values(meta.dependencies).includes(propertyId)) {
      setMeta(doc, { dependencies: null });
    }
    deleteProperty(doc, propertyId);
  });
}

/** Turn on sub-items: a "Parent item" / "Sub-items" pair of self-relations. */
export function enableSubItems(doc: Y.Doc, databaseId: string): void {
  if (readMeta(doc).subItems) return;
  doc.transact(() => {
    const { propertyId, syncedPropertyId } = createRelation(() => doc, {
      databaseId,
      targetId: databaseId,
      name: 'Parent item',
      limitOne: true,
      twoWay: { name: 'Sub-items' },
    });
    setMeta(doc, { subItems: { parentId: propertyId, childrenId: syncedPropertyId! } });
  });
}

/** Turn off sub-items; the two properties stay as ordinary relations unless deleted. */
export function disableSubItems(doc: Y.Doc, options: { deleteProperties?: boolean } = {}): void {
  const pair = readMeta(doc).subItems;
  doc.transact(() => {
    setMeta(doc, { subItems: null });
    if (pair && options.deleteProperties) {
      deleteProperty(doc, pair.parentId);
      deleteProperty(doc, pair.childrenId);
    }
  });
}

/** Turn on dependencies: a "Blocked by" / "Blocking" pair of self-relations. */
export function enableDependencies(doc: Y.Doc, databaseId: string): void {
  if (readMeta(doc).dependencies) return;
  doc.transact(() => {
    const { propertyId, syncedPropertyId } = createRelation(() => doc, {
      databaseId,
      targetId: databaseId,
      name: 'Blocked by',
      twoWay: { name: 'Blocking' },
    });
    setMeta(doc, { dependencies: { blockedById: propertyId, blockingId: syncedPropertyId! } });
  });
}

/** Turn off dependencies; the two properties stay unless deleted. */
export function disableDependencies(
  doc: Y.Doc,
  options: { deleteProperties?: boolean } = {},
): void {
  const pair = readMeta(doc).dependencies;
  doc.transact(() => {
    setMeta(doc, { dependencies: null });
    if (pair && options.deleteProperties) {
      deleteProperty(doc, pair.blockedById);
      deleteProperty(doc, pair.blockingId);
    }
  });
}
