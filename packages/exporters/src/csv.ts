import {
  cellText,
  isLiveRow,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type Row,
} from '@workspace/database';

/** A CSV field, quoted when it needs to be (RFC 4180). */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const csvLine = (fields: readonly string[]) => fields.map(csvField).join(',');

/** Properties exported as columns: all of them, title first (buttons have no value). */
export const exportedProperties = (snapshot: DatabaseSnapshot): Property[] =>
  snapshot.properties.filter((p) => p.type !== 'button');

/** The rows people see: not trashed, not templates; in the database's order. */
export const exportedRows = (snapshot: DatabaseSnapshot): Row[] => snapshot.rows.filter(isLiveRow);

/**
 * A database as CSV, like Notion's export: a header of property names, then one line per
 * row with each value as displayed. Starts with a byte order mark so spreadsheet apps
 * read it as UTF-8.
 */
export function databaseCsv(snapshot: DatabaseSnapshot, ctx: DisplayContext): string {
  const properties = exportedProperties(snapshot);
  const lines = [
    csvLine(properties.map((p) => p.name)),
    ...exportedRows(snapshot).map((row) => csvLine(properties.map((p) => cellText(row, p, ctx)))),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
