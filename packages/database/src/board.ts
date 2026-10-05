import { groupRows, type GroupInfo } from './group';
import type { ViewGroup, ViewResult } from './query';
import type { DatabaseSnapshot, DisplayContext, Row, View } from './schema';

export interface BoardColumn {
  info: GroupInfo;
  hidden: boolean;
  collapsed: boolean;
}

/** A swimlane (sub-group); boards without sub-groups have one lane with `info` null. */
export interface BoardLane {
  info: GroupInfo | null;
  hidden: boolean;
  collapsed: boolean;
  /** Rows by column key, in display order. */
  cells: Map<string, Row[]>;
  count: number;
}

export interface BoardLayout {
  columns: BoardColumn[];
  lanes: BoardLane[];
}

/**
 * Columns and swimlanes of a board from a grouped view result. Columns are the
 * view's groups; lanes are its sub-groups, in the sub-group property's order.
 */
export function boardLayout(
  result: ViewResult,
  snapshot: DatabaseSnapshot,
  view: View,
  ctx: DisplayContext,
): BoardLayout {
  const groups: ViewGroup[] = result.groups ?? [];
  const columns = groups.map(({ info, hidden, collapsed }) => ({ info, hidden, collapsed }));
  const subProperty = view.subGroupBy
    ? snapshot.properties.find((p) => p.id === view.subGroupBy!.propertyId)
    : undefined;
  if (!view.subGroupBy || !subProperty) {
    const cells = new Map(groups.map((g) => [g.info.key, g.rows]));
    return {
      columns,
      lanes: [{ info: null, hidden: false, collapsed: false, cells, count: result.rows.length }],
    };
  }
  const subGroupBy = view.subGroupBy;
  const lanes: BoardLane[] = groupRows(result.rows, subProperty, subGroupBy, ctx).map((g) => ({
    info: g.info,
    hidden: subGroupBy.hidden?.includes(g.info.key) ?? false,
    collapsed: subGroupBy.collapsed?.includes(g.info.key) ?? false,
    cells: new Map(),
    count: g.rows.length,
  }));
  const byKey = new Map(lanes.map((l) => [l.info!.key, l]));
  for (const group of groups) {
    for (const sub of group.subgroups ?? []) {
      byKey.get(sub.info.key)?.cells.set(group.info.key, sub.rows);
    }
  }
  return { columns, lanes };
}
