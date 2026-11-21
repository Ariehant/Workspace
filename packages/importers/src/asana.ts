import { addView } from '@workspace/database';
import { ImportBuilder } from './build';
import { dateMs, isoDay } from './dates';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import { CsvTable, commaList, extraColumns, linkParents } from './tracker';

/**
 * An Asana project's CSV export (the project's menu → Export/Print → CSV): a database shown
 * as a board grouped by section, and a table. Tasks are rows: section, assignee, start and
 * due dates, done, tags, and the notes in the page; sub-tasks link to their parent.
 * Custom fields come over as text.
 */

/** Is this CSV header Asana's? */
export function isAsanaCsv(header: readonly string[]): boolean {
  return header.includes('Task ID') && header.includes('Name') && header.includes('Section/Column');
}

const KNOWN = new Set([
  'Task ID',
  'Created At',
  'Completed At',
  'Last Modified',
  'Name',
  'Section/Column',
  'Assignee',
  'Assignee Email',
  'Start Date',
  'Due Date',
  'Tags',
  'Notes',
  'Projects',
  'Parent task',
  'Parent Task',
]);

export function importAsana(
  files: readonly { name: string; text: string }[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const tables = files.map((f) => ({ name: f.name, table: new CsvTable(f.text) }));
  const total = tables.reduce((n, t) => n + t.table.rows.length, 0);
  let done = 0;
  for (const { name, table } of tables) {
    const projects = table.distinct('Projects', commaList);
    const extra = extraColumns(table, KNOWN);
    const db = build.database(projects.length === 1 ? projects[0]! : name, [
      { name: 'Task', type: 'title' },
      {
        name: 'Section',
        type: 'select',
        options: table.distinct('Section/Column').map((n) => ({ name: n })),
      },
      { name: 'Assignee', type: 'text' },
      { name: 'Start', type: 'date' },
      { name: 'Due', type: 'date' },
      { name: 'Done', type: 'checkbox' },
      {
        name: 'Tags',
        type: 'multiSelect',
        options: table.distinct('Tags', commaList).map((n) => ({ name: n })),
      },
      ...extra.specs,
    ]);
    db.layout('board', 'Board', 'Section');
    addView(db.doc, { viewSet: db.id, name: 'All tasks', type: 'table' });

    const rowOf = new Map<string, string>();
    const parents = new Map<string, string>();
    for (const row of table.rows) {
      const get = (column: string) => table.get(row, column);
      const rowId = db.row({
        title: get('Name'),
        values: {
          Section: get('Section/Column'),
          Assignee: get('Assignee'),
          Start: isoDay(get('Start Date')),
          Due: isoDay(get('Due Date')),
          Done: get('Completed At') ? true : null,
          Tags: commaList(get('Tags')),
          ...extra.values(row),
        },
        at: dateMs(isoDay(get('Created At'))),
      });
      if (get('Task ID')) rowOf.set(get('Task ID'), rowId);
      const parent = get('Parent task') || get('Parent Task');
      if (parent) parents.set(rowId, parent);
      if (get('Notes')) build.content(rowId, [get('Notes')]);
      options.onProgress?.(++done, total);
    }
    // Asana names the parent task (its id in some exports).
    const byName = new Map(rowOf);
    for (const row of table.rows) {
      const id = rowOf.get(table.get(row, 'Task ID'));
      if (id && !byName.has(table.get(row, 'Name'))) byName.set(table.get(row, 'Name'), id);
    }
    const missing = linkParents(db, parents, byName);
    if (missing) {
      build.warn(
        `${missing} Asana sub-task${missing === 1 ? '’s parent was' : 's’ parents were'} not in the export`,
      );
    }
  }
  return build.done();
}
