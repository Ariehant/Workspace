import { newId } from '@workspace/core';
import * as Y from 'yjs';
import { readDatabase, rowsMap, schemaMap, viewsMap } from './doc';

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
