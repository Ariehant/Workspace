import { addView, type OptionColor } from '@workspace/database';
import { ImportBuilder } from './build';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import { CsvTable, extraColumns, linkParents } from './tracker';
import type { Sheet } from './xlsx';

/**
 * A monday.com board exported to Excel (the board's menu → Export board to Excel): a database
 * shown as a board grouped by status, and a table. Items are rows with their group, status,
 * priority, people, dates (a timeline as a date range) and other columns as text; subitems
 * become sub-items of their item.
 *
 * The sheet holds the board's name on the first row, then each group: its title on a row of
 * its own, a header row starting with "Name", the items, and a blank row. An item's subitems
 * may follow it under their own header, one column in (written to the export's documented
 * layout, without a real export to check against).
 */

/** Columns that tell a header row is monday's (with "Name" first). */
const MONDAY_COLUMNS = [
  'Status',
  'Person',
  'People',
  'Owner',
  'Date',
  'Timeline',
  'Priority',
  'Subitems',
  'Item ID',
];

const isHeader = (row: readonly string[]) =>
  row[0]?.trim() === 'Name' && row.slice(1).some((c) => MONDAY_COLUMNS.includes(c.trim()));

/** Is this sheet a monday.com board export? */
export function isMondaySheet(sheet: Sheet): boolean {
  return sheet.rows.slice(0, 20).some(isHeader);
}

const filled = (row: readonly string[]) => row.some((c) => c.trim());
const DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/;

/** A timeline cell, "2026-11-02 - 2026-11-20", as a date range. */
function timeline(text: string): { start: string; end: string | null } | null {
  const [start, end] = text.split(/\s+[-–]\s+/).map((s) => s.trim());
  if (!start || !DATE.test(start)) return null;
  return { start, end: end && DATE.test(end) ? end : null };
}

const STATUS_COLORS: Record<string, OptionColor> = {
  done: 'green',
  'working on it': 'orange',
  stuck: 'red',
  'not started': 'gray',
};
const PRIORITY_COLORS: Record<string, OptionColor> = {
  critical: 'red',
  'critical ⚠️': 'red',
  high: 'orange',
  medium: 'yellow',
  low: 'blue',
};

const KNOWN = new Set(['Name', 'Group', 'Status', 'Priority', 'Subitems', 'Item ID', 'Timeline']);
const DATE_COLUMNS = ['Date', 'Due date', 'Due Date'];

interface Item {
  group: string;
  values: Map<string, string>;
  /** The item a subitem belongs to (its index). */
  parent: number | null;
}

/** The sheet's items and subitems, with their group. */
function readBoard(rows: readonly (readonly string[])[]): { items: Item[]; columns: string[] } {
  const items: Item[] = [];
  const columns: string[] = [];
  const seen = (name: string) => {
    if (name && !columns.includes(name)) columns.push(name);
  };
  let group = '';
  let header: string[] | null = null;
  let sub: { header: string[]; from: number } | null = null;
  let lastItem: number | null = null;
  rows.forEach((row, i) => {
    if (!filled(row)) {
      header = null;
      sub = null;
      return;
    }
    if (isHeader(row)) {
      header = row.map((c) => c.trim());
      header.forEach(seen);
      sub = null;
      return;
    }
    if (!header) {
      // A group's title (the first row is the board's name).
      if (i > 0 && row.filter((c) => c.trim()).length === 1)
        group = row.find((c) => c.trim())!.trim();
      return;
    }
    const first = row[0]?.trim() ?? '';
    // A subitems header: one column in, "Subitems" or "Name" first.
    if (!first && ['Subitems', 'Name'].includes(row[1]?.trim() ?? '')) {
      const cells = row.slice(1).map((c) => c.trim());
      // "Subitems, Name, …" (names under Name) or "Subitems, …" / "Name, …" (names first).
      sub =
        cells[0] === 'Subitems' && cells[1] === 'Name'
          ? { header: cells.slice(1), from: 2 }
          : { header: ['Name', ...cells.slice(1)], from: 1 };
      sub.header.forEach(seen);
      return;
    }
    if (!first && sub && lastItem !== null) {
      const { header: h, from } = sub;
      const values = new Map(h.map((name, j) => [name, row[from + j]?.trim() ?? '']));
      if (values.get('Name')) items.push({ group, values, parent: lastItem });
      return;
    }
    sub = null;
    const values = new Map(header.map((name, j) => [name, row[j]?.trim() ?? '']));
    if (!values.get('Name')) return;
    lastItem = items.length;
    items.push({ group, values, parent: null });
  });
  return { items, columns };
}

export function importMonday(
  sheets: readonly { name: string; sheet: Sheet }[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const boards = sheets.map(({ name, sheet }) => ({ name, sheet, ...readBoard(sheet.rows) }));
  const total = boards.reduce((n, b) => n + b.items.length, 0);
  let done = 0;
  for (const { name, sheet, items, columns } of boards) {
    // One table of every item, by column name, for the shared helpers.
    const header = ['Group', ...columns];
    const table = new CsvTable([
      header,
      ...items.map((item) =>
        header.map((h) => (h === 'Group' ? item.group : (item.values.get(h) ?? ''))),
      ),
    ]);
    const has = (column: string) => table.rows.some((r) => table.get(r, column));
    const dateColumns = DATE_COLUMNS.filter(has);
    const extra = extraColumns(table, new Set([...KNOWN, ...dateColumns]));
    const options_ = (column: string, colors: Record<string, OptionColor>) =>
      table.distinct(column).map((n) => ({ name: n, color: colors[n.toLowerCase()] }));
    const title = sheet.rows[0]?.find((c) => c.trim())?.trim() || name;
    const db = build.database(title, [
      { name: 'Name', type: 'title' },
      { name: 'Group', type: 'select', options: table.distinct('Group').map((n) => ({ name: n })) },
      ...(has('Status')
        ? [{ name: 'Status', type: 'select' as const, options: options_('Status', STATUS_COLORS) }]
        : []),
      ...(has('Priority')
        ? [
            {
              name: 'Priority',
              type: 'select' as const,
              options: options_('Priority', PRIORITY_COLORS),
            },
          ]
        : []),
      ...(has('Timeline') ? [{ name: 'Timeline', type: 'date' as const }] : []),
      ...dateColumns.map((n) => ({ name: n, type: 'date' as const })),
      ...extra.specs,
    ]);
    db.layout('board', 'Board', has('Status') ? 'Status' : 'Group');
    addView(db.doc, { viewSet: db.id, name: 'All items', type: 'table' });

    const rowIds: string[] = [];
    const parents = new Map<string, string>();
    table.rows.forEach((row, i) => {
      const get = (column: string) => table.get(row, column);
      const values: Record<string, unknown> = {
        Group: get('Group'),
        Status: get('Status'),
        Priority: get('Priority'),
        Timeline: timeline(get('Timeline')),
        ...extra.values(row),
      };
      for (const column of dateColumns)
        values[column] = DATE.test(get(column)) ? get(column) : null;
      const rowId = db.row({ title: get('Name'), values });
      rowIds.push(rowId);
      const parent = items[i]!.parent;
      if (parent !== null) parents.set(rowId, String(parent));
      options.onProgress?.(++done, total);
    });
    linkParents(db, parents, new Map(rowIds.map((id, i) => [String(i), id])));
  }
  return build.done();
}
