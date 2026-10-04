import { newId } from '@workspace/core';
import * as Y from 'yjs';
import { metaMap, readDatabase, rowsMap, schemaMap, viewsMap } from './doc';
import { relationIds } from './properties';
import { RowField } from './schema';

/**
 * Copy a database into an empty doc: properties, views (moved to `viewSet`) and rows
 * with fresh ids. Returns old row id -> new row id, for copying the rows' content.
 */
export function copyDatabase(
  from: Y.Doc,
  to: Y.Doc,
  options: { fromViewSet: string; toViewSet: string },
): Map<string, string> {
  const mapping = new Map<string, string>();
  const source = readDatabase(from);
  to.transact(() => {
    for (const [id, map] of schemaMap(from)) {
      schemaMap(to).set(id, cloneMap(map));
    }
    for (const [key, value] of metaMap(from)) metaMap(to).set(key, structuredClone(value));
    for (const view of source.views) {
      if (view.viewSet !== options.fromViewSet) continue;
      const id = newId();
      const copy = cloneMap(viewsMap(from).get(view.id)!);
      copy.set('id', id);
      copy.set('viewSet', options.toViewSet);
      viewsMap(to).set(id, copy);
    }
    for (const row of source.rows) {
      const id = newId();
      mapping.set(row.id, id);
      const copy = cloneMap(rowsMap(from).get(row.id)!);
      copy.set('id', id);
      rowsMap(to).set(id, copy);
    }
    remapRelations(to, options.fromViewSet, options.toViewSet, mapping);
  });
  return mapping;
}

/** Deep copy of a row/property/view map (nested Y.Text and Y.Map included). */
function cloneMap(map: Y.Map<unknown>): Y.Map<unknown> {
  const copy = new Y.Map<unknown>();
  for (const [key, value] of map) {
    if (value instanceof Y.Text) copy.set(key, value.clone());
    else if (value instanceof Y.Map) copy.set(key, value.clone());
    else copy.set(key, structuredClone(value));
  }
  return copy;
}

/**
 * Relations of a copied database: self-relations link the copied rows; relations to
 * other databases become one-way (the other side stays with the original).
 */
function remapRelations(
  doc: Y.Doc,
  fromId: string,
  toId: string,
  mapping: ReadonlyMap<string, string>,
): void {
  for (const map of schemaMap(doc).values()) {
    if (map.get('type') !== 'relation') continue;
    const id = map.get('id') as string;
    const config = (map.get('config') ?? {}) as Record<string, unknown>;
    if (config.databaseId !== fromId) {
      if (config.syncedPropertyId) map.set('config', { ...config, syncedPropertyId: null });
      continue;
    }
    map.set('config', { ...config, databaseId: toId });
    for (const row of rowsMap(doc).values()) {
      const values = row.get(RowField.values);
      if (!(values instanceof Y.Map) || !values.has(id)) continue;
      const old = values.get(id);
      const links = new Y.Map<number>();
      const stamps = (old instanceof Y.Map ? old.toJSON() : {}) as Record<string, number>;
      relationIds(old instanceof Y.Map ? old.toJSON() : old).forEach((linked, i) => {
        const to = mapping.get(linked);
        if (to) links.set(to, stamps[linked] ?? i);
      });
      values.set(id, links);
    }
  }
}
