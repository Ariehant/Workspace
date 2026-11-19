/**
 * What the task-tracker importers (Asana, Jira, monday) share: their export as a table read by column
 * name, the columns nobody mapped (kept as text), and parent tasks as a relation.
 */
import { enableSubItems, readDatabase, setRelation, type DocResolver } from '@workspace/database';
import type { ColumnSpec, DatabaseBuilder } from './build';
import { parseCsv } from './csv';

/** A CSV export, by column name. A name may repeat (Jira's Labels, Comment…). */
export class CsvTable {
  readonly header: string[];
  readonly rows: string[][];

  /** CSV text, or rows already read (a spreadsheet's), the first being the header. */
  constructor(source: string | readonly (readonly string[])[]) {
    const [header = [], ...rows] = typeof source === 'string' ? parseCsv(source) : source;
    this.header = header.map((h) => h.trim());
    this.rows = rows.filter((r) => r.some((c) => c.trim())).map((r) => [...r]);
  }

  has(name: string): boolean {
    return this.header.includes(name);
  }

  /** Every non-empty value in the row's columns of this name. */
  all(row: readonly string[], name: string): string[] {
    return this.header.flatMap((h, i) => {
      const v = h === name ? row[i]?.trim() : '';
      return v ? [v] : [];
    });
  }

  /** The row's (first) value in this column, or ''. */
  get(row: readonly string[], name: string): string {
    return this.all(row, name)[0] ?? '';
  }

  /** The distinct values of a column, in the order they first appear. */
  distinct(name: string, split?: (value: string) => string[]): string[] {
    const seen = new Set<string>();
    for (const row of this.rows) {
      for (const v of this.all(row, name)) for (const x of split ? split(v) : [v]) seen.add(x);
    }
    return [...seen];
  }
}

/** The CSV's header, to tell which app made it. */
export function csvHeader(text: string): string[] {
  const line = text.split(/\r?\n/, 1)[0] ?? '';
  return parseCsv(line)[0]?.map((h) => h.trim()) ?? [];
}

/**
 * The columns not mapped to anything (custom fields, mostly), as text, when they hold
 * anything. Repeated ones are joined.
 */
export function extraColumns(
  table: CsvTable,
  known: ReadonlySet<string>,
): { specs: ColumnSpec[]; values(row: readonly string[]): Record<string, string> } {
  const names = [...new Set(table.header)].filter(
    (h) => h && !known.has(h) && table.rows.some((r) => table.get(r, h)),
  );
  return {
    specs: names.map((name) => ({ name, type: 'text' as const })),
    values: (row) => Object.fromEntries(names.map((n) => [n, table.all(row, n).join(', ')])),
  };
}

/**
 * Parent tasks, as sub-items (the database's Parent item ↔ Sub-items pair), linking each
 * row to the row whose export id (or key) it names. Returns how many parents weren't in
 * the export.
 */
export function linkParents(
  db: DatabaseBuilder,
  parents: ReadonlyMap<string, string>,
  rowOf: ReadonlyMap<string, string>,
): number {
  const links = [...parents].flatMap(([rowId, ref]) => {
    const parent = rowOf.get(ref);
    return parent && parent !== rowId ? [[rowId, parent] as const] : [];
  });
  if (!links.length) return parents.size;
  enableSubItems(db.doc, db.id);
  const propertyId = readDatabase(db.doc).meta.subItems!.parentId;
  const resolve: DocResolver = (id) => (id === db.id ? db.doc : undefined);
  for (const [rowId, parent] of links) {
    setRelation(resolve, db.id, rowId, propertyId, [parent], null);
  }
  return parents.size - links.length;
}

/** "a, b, c" → its items. */
export const commaList = (text: string) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
