import { newId } from '@workspace/core';
import * as Y from 'yjs';
import { metaMap, readDatabase, rowsMap, schemaMap, viewsMap } from './doc';
import { relationIds } from './properties';
import { RowField } from './schema';

export interface CopyDatabaseOptions {
  fromViewSet: string;
  toViewSet: string;
  /**
   * When several databases are copied together (a template): old -> new id of each
   * database and of their rows, so relations between them link the copies both ways.
   */
  databases?: ReadonlyMap<string, string>;
  rows?: ReadonlyMap<string, string>;
}

/**
 * Copy a database into an empty doc: properties, views (moved to `viewSet`) and rows
 * with fresh ids. Returns old row id -> new row id, for copying the rows' content.
 */
export function copyDatabase(
  from: Y.Doc,
  to: Y.Doc,
  options: CopyDatabaseOptions,
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
      const id = options.rows?.get(row.id) ?? newId();
      mapping.set(row.id, id);
      const copy = cloneMap(rowsMap(from).get(row.id)!);
      copy.set('id', id);
      rowsMap(to).set(id, copy);
    }
    // Templates (rows) chosen as defaults point at the copied templates.
    const template = source.meta.defaultTemplateId;
    if (template) metaMap(to).set('defaultTemplateId', mapping.get(template) ?? null);
    for (const view of viewsMap(to).values()) {
      const id = view.get('defaultTemplateId');
      if (typeof id === 'string') view.set('defaultTemplateId', mapping.get(id) ?? null);
    }
    const databases = new Map(options.databases);
    databases.set(options.fromViewSet, options.toViewSet);
    remapRelations(to, databases, new Map([...(options.rows ?? []), ...mapping]));
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
 * Relations of a copied database: relations to copied databases (itself, or others
 * copied with it) link the copied rows; relations to other databases become one-way
 * (the other side stays with the original).
 */
function remapRelations(
  doc: Y.Doc,
  databases: ReadonlyMap<string, string>,
  mapping: ReadonlyMap<string, string>,
): void {
  for (const map of schemaMap(doc).values()) {
    if (map.get('type') !== 'relation') continue;
    const id = map.get('id') as string;
    const config = (map.get('config') ?? {}) as Record<string, unknown>;
    const toId = databases.get(config.databaseId as string);
    if (!toId) {
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
