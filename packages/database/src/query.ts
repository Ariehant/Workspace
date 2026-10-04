import { cellValue, propertyKind } from './properties';
import type { DatabaseSnapshot, DisplayContext, Property, Row, Sort, View } from './schema';

export interface ViewResult {
  /** Rows the view shows, in display order. */
  rows: Row[];
}

/** Compare two rows by a list of sorts. Empty values always go last, as in Notion. */
export function compareRows(
  a: Row,
  b: Row,
  sorts: readonly { property: Property; direction: Sort['direction'] }[],
  ctx: DisplayContext,
): number {
  for (const { property, direction } of sorts) {
    const kind = propertyKind(property.type);
    const x = cellValue(a, property);
    const y = cellValue(b, property);
    const xEmpty = kind.isEmpty(x) && property.type !== 'checkbox';
    const yEmpty = kind.isEmpty(y) && property.type !== 'checkbox';
    if (xEmpty || yEmpty) {
      if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
      continue;
    }
    const order = kind.compare(x, y, property, ctx);
    if (order !== 0) return direction === 'asc' ? order : -order;
  }
  return 0;
}

/**
 * The rows a view shows: live (not trashed) rows, sorted by the view's sorts, else
 * in manual order. (Filters and grouping arrive in M2.)
 */
export function runView(snapshot: DatabaseSnapshot, view: View, ctx: DisplayContext): ViewResult {
  const rows = snapshot.rows.filter((r) => r.trashedAt === null);
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  const sorts = view.sorts.flatMap((s) => {
    const property = byId.get(s.propertyId);
    return property ? [{ property, direction: s.direction }] : [];
  });
  if (sorts.length > 0) {
    // Array.prototype.sort is stable, so ties keep the manual order.
    rows.sort((a, b) => compareRows(a, b, sorts, ctx));
  }
  return { rows };
}
