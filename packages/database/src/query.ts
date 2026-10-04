import { matchesFilter } from './filter';
import { groupRows, type GroupInfo } from './group';
import { cellText, cellValue, propertyKind } from './properties';
import type { DatabaseSnapshot, DisplayContext, Property, Row, Sort, View } from './schema';

export interface ViewGroup {
  info: GroupInfo;
  rows: Row[];
  /** Hidden from the view (listed under "Hidden groups"). */
  hidden: boolean;
  collapsed: boolean;
  subgroups: ViewGroup[] | null;
}

export interface ViewResult {
  /** Rows the view shows, in display order (filtered, searched, sorted). */
  rows: Row[];
  /** Groups when the view is grouped, else null. */
  groups: ViewGroup[] | null;
}

export interface RunViewOptions {
  /** Quick search inside the view (not saved): rows with any shown value containing it. */
  search?: string;
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
 * The rows a view shows: live rows that pass its filter (and the search), sorted by
 * its sorts or else in manual order, split into groups and sub-groups if it has them.
 */
export function runView(
  snapshot: DatabaseSnapshot,
  view: View,
  ctx: DisplayContext,
  options: RunViewOptions = {},
): ViewResult {
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  let rows = snapshot.rows.filter(
    (r) => r.trashedAt === null && matchesFilter(r, view.filter, byId, ctx),
  );

  const q = options.search?.trim().toLowerCase();
  if (q) {
    const shown = view.properties.filter((c) => c.visible).map((c) => byId.get(c.id));
    const searchable = [byId.get('title'), ...shown.filter((p) => p && p.type !== 'title')].filter(
      (p): p is Property => p !== undefined,
    );
    rows = rows.filter((r) =>
      searchable.some((p) => cellText(r, p, ctx).toLowerCase().includes(q)),
    );
  }

  const sorts = view.sorts.flatMap((s) => {
    const property = byId.get(s.propertyId);
    return property ? [{ property, direction: s.direction }] : [];
  });
  // Array.prototype.sort is stable, so ties keep the manual order.
  if (sorts.length > 0) rows.sort((a, b) => compareRows(a, b, sorts, ctx));

  const groupProperty = view.groupBy ? byId.get(view.groupBy.propertyId) : undefined;
  if (!view.groupBy || !groupProperty) return { rows, groups: null };
  const subProperty = view.subGroupBy ? byId.get(view.subGroupBy.propertyId) : undefined;

  const build = (
    list: readonly Row[],
    property: Property,
    groupBy: NonNullable<View['groupBy']>,
    sub: boolean,
  ): ViewGroup[] =>
    groupRows(list, property, groupBy, ctx).map((g) => ({
      info: g.info,
      rows: g.rows,
      hidden: groupBy.hidden?.includes(g.info.key) ?? false,
      collapsed: groupBy.collapsed?.includes(g.info.key) ?? false,
      subgroups:
        sub && view.subGroupBy && subProperty
          ? build(g.rows, subProperty, view.subGroupBy, false)
          : null,
    }));

  return { rows, groups: build(rows, groupProperty, view.groupBy, true) };
}
