import type * as Y from 'yjs';
import { addProperty, addRow, addView, readDatabase, viewColumns, viewsOf } from './doc';
import { cellText } from './properties';
import { runView } from './query';
import { TITLE_PROPERTY_ID, type DisplayContext } from './schema';

/**
 * Give a view set (a linked database block) its first view if it has none: a table
 * like the database's own first view, keeping the source's views untouched.
 */
export function ensureViewSet(doc: Y.Doc, viewSet: string, sourceViewSet: string): string {
  const snapshot = readDatabase(doc);
  const existing = viewsOf(snapshot, viewSet);
  if (existing.length) return existing[0]!.id;
  const source = viewsOf(snapshot, sourceViewSet)[0];
  return addView(doc, {
    viewSet,
    name: source?.name ?? 'Table',
    type: source?.type ?? 'table',
    config: source
      ? {
          properties: structuredClone(source.properties),
          groupBy: source.groupBy,
          dateProperty: source.dateProperty,
          chart: structuredClone(source.chart),
        }
      : undefined,
  });
}

/**
 * Fill a new, empty database from a simple table's cells: the first column becomes
 * the title, the others text properties named by the header row (when it has one).
 */
export function fillFromTable(
  doc: Y.Doc,
  cells: string[][],
  options: { header: boolean; actor: string | null },
): void {
  const width = Math.max(1, ...cells.map((r) => r.length));
  const header = options.header ? (cells[0] ?? []) : [];
  const body = options.header ? cells.slice(1) : cells;
  doc.transact(() => {
    const snapshot = readDatabase(doc);
    // A new database starts with Tags; a converted table only has its own columns.
    for (const p of snapshot.properties) {
      if (p.id !== TITLE_PROPERTY_ID) doc.getMap<Y.Map<unknown>>('schema').delete(p.id);
    }
    const titleName = header[0]?.trim();
    if (titleName)
      doc.getMap<Y.Map<unknown>>('schema').get(TITLE_PROPERTY_ID)!.set('name', titleName);
    const ids: string[] = [];
    for (let c = 1; c < width; c++) {
      ids.push(addProperty(doc, { name: header[c]?.trim() || `Column ${c + 1}`, type: 'text' }));
    }
    for (const view of readDatabase(doc).views) {
      doc
        .getMap<Y.Map<unknown>>('views')
        .get(view.id)!
        .set(
          'properties',
          viewColumns(view, readDatabase(doc).properties).map((c) => ({ ...c, visible: true })),
        );
    }
    for (const row of body) {
      const values: Record<string, unknown> = {};
      ids.forEach((id, i) => {
        const text = row[i + 1]?.trim();
        if (text) values[id] = text;
      });
      addRow(doc, { actor: options.actor, title: row[0]?.trim() ?? '', values });
    }
  });
}

/** A database view as simple-table cells: a header row of property names, then rows. */
export function tableCells(doc: Y.Doc, viewId: string, ctx: DisplayContext): string[][] {
  const snapshot = readDatabase(doc);
  const view = snapshot.views.find((v) => v.id === viewId) ?? snapshot.views[0];
  if (!view) return [];
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  const columns = viewColumns(view, snapshot.properties)
    .filter((c) => c.visible)
    .map((c) => byId.get(c.id)!);
  const rows = runView(snapshot, view, ctx).rows;
  return [columns.map((p) => p.name), ...rows.map((r) => columns.map((p) => cellText(r, p, ctx)))];
}
