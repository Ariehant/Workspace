import { addView, type OptionColor } from '@workspace/database';
import type { JSONContent } from '@workspace/editor';
import { ImportBuilder } from './build';
import { dateMs, jiraDate } from './dates';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import { CsvTable, extraColumns, linkParents } from './tracker';

/**
 * Jira issues exported as CSV (Filters → Export → CSV): a database shown as a board
 * grouped by status, and a table. Issues are rows: key, type, status, priority, assignee,
 * reporter, due date and labels; the description and comments in the page; sub-tasks link
 * to their parent. Other fields come over as text.
 */

/** Is this CSV header Jira's? */
export function isJiraCsv(header: readonly string[]): boolean {
  return (
    header.includes('Summary') && (header.includes('Issue key') || header.includes('Issue id'))
  );
}

/** Columns mapped below, or not worth a property (ids, project details, timestamps). */
const KNOWN = new Set([
  'Summary',
  'Issue key',
  'Issue id',
  'Issue Type',
  'Status',
  'Priority',
  'Assignee',
  'Reporter',
  'Creator',
  'Created',
  'Updated',
  'Last Viewed',
  'Resolved',
  'Due date',
  'Labels',
  'Description',
  'Comment',
  'Parent',
  'Parent id',
  'Parent key',
  'Parent summary',
  'Sub-tasks',
  'Project key',
  'Project name',
  'Project type',
  'Project lead',
  'Project lead id',
  'Project description',
  'Project url',
  'Status Category',
  'Status Category Changed',
  'Watchers',
  'Watchers Id',
  'Assignee Id',
  'Reporter Id',
  'Creator Id',
]);

const PRIORITY_COLORS: Record<string, OptionColor> = {
  highest: 'red',
  blocker: 'red',
  critical: 'red',
  high: 'orange',
  major: 'orange',
  medium: 'yellow',
  low: 'blue',
  minor: 'blue',
  lowest: 'gray',
  trivial: 'gray',
};

/** Jira's comment cells: `19/Nov/26 3:04 PM;<account id>;the text`. */
function comment(cell: string): { date: string | null; text: string } {
  const m = /^([^;]+);([^;]*);([\s\S]*)$/.exec(cell);
  const date = m ? jiraDate(m[1]!) : null;
  return date ? { date, text: m![3]!.trim() } : { date: null, text: cell };
}

export function importJira(
  files: readonly { name: string; text: string }[],
  target: ImportTarget,
  options: ImportOptions,
): ImportReport {
  const build = new ImportBuilder(target, options);
  const tables = files.map((f) => ({ name: f.name, table: new CsvTable(f.text) }));
  const total = tables.reduce((n, t) => n + t.table.rows.length, 0);
  let done = 0;
  for (const { name, table } of tables) {
    const projects = table.distinct('Project name');
    const extra = extraColumns(table, KNOWN);
    const options_ = (column: string) => table.distinct(column).map((n) => ({ name: n }));
    const db = build.database(projects.length === 1 ? projects[0]! : name, [
      { name: 'Summary', type: 'title' },
      { name: 'Key', type: 'text' },
      { name: 'Type', type: 'select', options: options_('Issue Type') },
      { name: 'Status', type: 'select', options: options_('Status') },
      {
        name: 'Priority',
        type: 'select',
        options: table.distinct('Priority').map((n) => ({
          name: n,
          color: PRIORITY_COLORS[n.toLowerCase()] ?? 'gray',
        })),
      },
      { name: 'Assignee', type: 'text' },
      { name: 'Reporter', type: 'text' },
      { name: 'Due', type: 'date' },
      { name: 'Labels', type: 'multiSelect', options: options_('Labels') },
      ...extra.specs,
    ]);
    db.layout('board', 'Board', 'Status');
    addView(db.doc, { viewSet: db.id, name: 'All issues', type: 'table' });

    const rowOf = new Map<string, string>();
    const parents = new Map<string, string>();
    for (const row of table.rows) {
      const get = (column: string) => table.get(row, column);
      const rowId = db.row({
        title: get('Summary'),
        values: {
          Key: get('Issue key'),
          Type: get('Issue Type'),
          Status: get('Status'),
          Priority: get('Priority'),
          Assignee: get('Assignee'),
          Reporter: get('Reporter'),
          Due: jiraDate(get('Due date')),
          Labels: table.all(row, 'Labels'),
          ...extra.values(row),
        },
        at: dateMs(jiraDate(get('Created'))),
      });
      for (const id of [get('Issue id'), get('Issue key')]) if (id) rowOf.set(id, rowId);
      const parent = get('Parent') || get('Parent id') || get('Parent key');
      if (parent) parents.set(rowId, parent);

      const content: (JSONContent | string)[] = [];
      if (get('Description')) content.push(get('Description'));
      const comments = table.all(row, 'Comment').map(comment);
      if (comments.length) {
        content.push({
          type: 'heading',
          attrs: { level: 3 },
          content: [{ type: 'text', text: 'Comments' }],
        });
        for (const c of comments) {
          content.push({
            type: 'paragraph',
            content: [
              ...(c.date
                ? [
                    {
                      type: 'text',
                      text: `${c.date.replace('T', ' ')}: `,
                      marks: [{ type: 'bold' }],
                    },
                  ]
                : []),
              ...(c.text ? [{ type: 'text', text: c.text }] : []),
            ],
          });
        }
      }
      build.content(rowId, content);
      options.onProgress?.(++done, total);
    }
    const missing = linkParents(db, parents, rowOf);
    if (missing) {
      build.warn(
        `${missing} Jira sub-task${missing === 1 ? '’s parent was' : 's’ parents were'} not in the export`,
      );
    }
  }
  if (
    tables.some(({ table }) =>
      table.rows.some((r) => /\{code|h[1-6]\.\s|\[~/.test(table.get(r, 'Description'))),
    )
  ) {
    build.warn('Jira’s wiki formatting in descriptions was kept as plain text');
  }
  return build.done();
}
