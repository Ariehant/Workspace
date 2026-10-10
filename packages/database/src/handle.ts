import * as Y from 'yjs';
import {
  metaMap,
  readMeta,
  readProperties,
  readRow,
  readViews,
  rowsMap,
  schemaMap,
  viewsMap,
} from './doc';
import { PageField } from '@workspace/core';
import type { DatabaseSnapshot, Row } from './schema';

const byKey = (a: Row, b: Row) =>
  a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1;

/**
 * A loaded database doc for the UI: an immutable snapshot that is rebuilt
 * incrementally (only changed rows are re-read, and rows are only re-sorted when the
 * order can have changed), change notifications and an undo stack.
 */
export class DatabaseHandle {
  readonly undo: Y.UndoManager;
  private readonly listeners = new Set<() => void>();
  private readonly rowCache = new Map<string, Row>();
  private ordered: Row[] = [];
  private orderDirty = true;
  private rowsDirty = true;
  private schemaDirty = true;
  private viewsDirty = true;
  private metaDirty = true;
  private current: DatabaseSnapshot | null = null;
  private version = 0;

  constructor(
    readonly id: string,
    readonly doc: Y.Doc,
  ) {
    const rows = rowsMap(doc);
    rows.observeDeep(this.onRows);
    schemaMap(doc).observeDeep(this.onSchema);
    viewsMap(doc).observeDeep(this.onViews);
    metaMap(doc).observe(this.onMeta);
    // Only local edits (origin null) are undoable, not other windows' updates.
    this.undo = new Y.UndoManager([rows, schemaMap(doc), viewsMap(doc), metaMap(doc)], {
      // Each edit (a cell, a paste, a new row) is its own undo step.
      captureTimeout: 0,
    });
  }

  private readonly onRows = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const rows = rowsMap(this.doc);
    for (const event of events) {
      if (event.target === rows) {
        for (const key of event.changes.keys.keys()) this.rowCache.delete(key);
        this.orderDirty = true;
      } else {
        // A change inside a row: path[0] is the row id.
        const rowId = event.path[0];
        if (typeof rowId === 'string') this.rowCache.delete(rowId);
        if (event.path.length === 1 && event.changes.keys.has(PageField.sortKey)) {
          this.orderDirty = true;
        }
      }
    }
    this.rowsDirty = true;
    this.changed();
  };

  // Schema, views and meta are re-read apart: a view change (a sort, a filter) keeps the
  // properties as they were, so values computed from them are kept too.
  private readonly onSchema = () => {
    this.schemaDirty = true;
    this.changed();
  };

  private readonly onViews = () => {
    this.viewsDirty = true;
    this.changed();
  };

  private readonly onMeta = () => {
    this.metaDirty = true;
    this.changed();
  };

  private changed(): void {
    this.current = null;
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Bumps on every change: a cheap memo key. */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): DatabaseSnapshot => {
    if (this.current) return this.current;
    let rows: Row[];
    if (this.rowsDirty || this.orderDirty) {
      const map = rowsMap(this.doc);
      if (this.orderDirty) {
        rows = [];
        for (const [id, rowMap] of map) {
          let row = this.rowCache.get(id);
          if (!row) {
            row = readRow(rowMap);
            this.rowCache.set(id, row);
          }
          rows.push(row);
        }
        rows.sort(byKey);
      } else {
        rows = this.ordered.map((old) => {
          let row = this.rowCache.get(old.id);
          if (!row) {
            row = readRow(map.get(old.id)!);
            this.rowCache.set(old.id, row);
          }
          return row;
        });
      }
      this.ordered = rows;
      this.rowsDirty = false;
      this.orderDirty = false;
    } else {
      rows = this.ordered;
    }
    const last = this.lastMeta;
    const meta = {
      properties: this.schemaDirty || !last ? readProperties(this.doc) : last.properties,
      views: this.viewsDirty || !last ? readViews(this.doc) : last.views,
      meta: this.metaDirty || !last ? readMeta(this.doc) : last.meta,
    };
    this.lastMeta = meta;
    this.schemaDirty = false;
    this.viewsDirty = false;
    this.metaDirty = false;
    this.current = { ...meta, rows };
    return this.current;
  };

  private lastMeta: Pick<DatabaseSnapshot, 'properties' | 'views' | 'meta'> | null = null;

  /** The row with this id, if the database has it. */
  row(id: string): Row | undefined {
    if (!rowsMap(this.doc).has(id)) return undefined;
    this.snapshot(); // fills the cache
    return this.rowCache.get(id);
  }

  destroy(): void {
    rowsMap(this.doc).unobserveDeep(this.onRows);
    schemaMap(this.doc).unobserveDeep(this.onMeta);
    viewsMap(this.doc).unobserveDeep(this.onMeta);
    metaMap(this.doc).unobserve(this.onMeta);
    this.undo.destroy();
    this.listeners.clear();
  }
}
