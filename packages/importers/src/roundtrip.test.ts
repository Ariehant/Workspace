import {
  createPage,
  getPageContent,
  listPages,
  readBlocks,
  readLinks,
  type Block,
} from '@workspace/core';
import {
  addProperty,
  addRow,
  cellText,
  createRelation,
  initDatabase,
  readDatabase,
  relationIds,
  setRelation,
} from '@workspace/database';
import { exportPages, type ExportSource } from '@workspace/exporters';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { importFiles, type ImportTarget } from './import';

function el(
  type: string,
  attrs: Record<string, unknown> = {},
  ...children: (Y.XmlElement | string | Y.XmlText)[]
) {
  const e = new Y.XmlElement(type);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v as string);
  e.insert(
    0,
    children.map((c) => (typeof c === 'string' ? new Y.XmlText(c) : c)),
  );
  return e;
}
const bold = (text: string) => {
  const t = new Y.XmlText();
  t.insert(0, text, { bold: {} });
  return t;
};

/** A source workspace: pages, a sub-page, two related databases, an image. */
function source() {
  const ws = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const doc = (id: string) => {
    if (!docs.has(id)) docs.set(id, new Y.Doc());
    return docs.get(id)!;
  };
  const robot = createPage(ws, { title: 'Robot' });
  const specs = createPage(ws, { title: 'Specs', parentId: robot });
  const tasks = createPage(ws, { title: 'Tasks', parentId: robot, kind: 'database' });
  const projects = createPage(ws, { title: 'Projects', parentId: robot, kind: 'database' });
  initDatabase(doc(tasks), { databaseId: tasks });
  initDatabase(doc(projects), { databaseId: projects });
  const resolve = (id: string) => docs.get(id);
  const status = addProperty(doc(tasks), {
    name: 'Status',
    type: 'select',
    config: {
      options: [
        { id: 's1', name: 'Done', color: 'green' },
        { id: 's2', name: 'Doing', color: 'blue' },
      ],
    },
  });
  const hours = addProperty(doc(tasks), { name: 'Hours', type: 'number' });
  const due = addProperty(doc(tasks), { name: 'Due', type: 'date' });
  const ok = addProperty(doc(tasks), { name: 'Reviewed', type: 'checkbox' });
  const { propertyId: rel } = createRelation(resolve, {
    databaseId: tasks,
    name: 'Projects',
    targetId: projects,
    twoWay: { name: 'Tasks' },
  });
  const arm = addRow(doc(projects), { actor: null, title: 'Arm' });
  const base = addRow(doc(projects), { actor: null, title: 'Base' });
  const rows = [
    ['Wire motors', 's1', 3, '2026-10-01', true, [arm]],
    ['Tune PID', 's2', 1.5, '2026-10-09', false, [arm, base]],
    ['Order wheels', 's2', 2, null, false, [base]],
  ] as const;
  const ids = rows.map(([title, s, h, d, r, links]) => {
    const id = addRow(doc(tasks), {
      actor: null,
      title,
      values: { [status]: s, [hours]: h, ...(d ? { [due]: { start: d } } : {}), [ok]: r },
    });
    setRelation(resolve, tasks, id, rel, [...links], null);
    return id;
  });
  getPageContent(doc(robot)).insert(0, [
    el('heading', { level: 2 }, 'Overview'),
    el(
      'paragraph',
      {},
      'A ',
      bold('two-joint'),
      ' arm, see ',
      el('mention', { kind: 'page', pageId: specs }),
    ),
    el('callout', { icon: '⚠️' }, el('paragraph', {}, 'Pinch points')),
    el(
      'bulletList',
      {},
      el('listItem', {}, el('paragraph', {}, 'Joint A')),
      el('listItem', {}, el('paragraph', {}, 'Joint B')),
    ),
    el('taskList', {}, el('taskItem', { checked: true }, el('paragraph', {}, 'Mount base'))),
    el('codeBlock', { language: 'python' }, 'print("hi")'),
    el('blockMath', { latex: 'E = mc^2' }),
    el(
      'table',
      {},
      el(
        'tableRow',
        {},
        el('tableHeader', {}, el('paragraph', {}, 'J')),
        el('tableHeader', {}, el('paragraph', {}, 'Limit')),
      ),
      el(
        'tableRow',
        {},
        el('tableCell', {}, el('paragraph', {}, '1')),
        el('tableCell', {}, el('paragraph', {}, '90°')),
      ),
    ),
    el('image', { fileId: 'abc.png', caption: 'The arm' }),
    el('database', { pageId: tasks }),
  ]);
  getPageContent(doc(specs)).insert(0, [
    el('paragraph', {}, 'Torque 2 Nm, back to ', el('mention', { kind: 'page', pageId: robot })),
  ]);
  getPageContent(doc(ids[1]!)).insert(0, [el('paragraph', {}, 'Use Ziegler–Nichols')]);
  const src: ExportSource = {
    workspace: ws,
    doc: (id) => docs.get(id) ?? null,
    file: (id) =>
      id === 'abc.png' ? { bytes: new Uint8Array([137, 80, 78, 71]), name: 'arm.png' } : null,
    users: new Map(),
  };
  return src;
}

function target() {
  const workspace = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const stored = new Map<string, Uint8Array>();
  const t: ImportTarget = {
    workspace,
    doc: (id) => {
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return docs.get(id)!;
    },
    storeFile: (bytes, name) => {
      stored.set(name, bytes);
      return `stored-${name}`;
    },
  };
  return { t, workspace, docs, stored };
}

const types = (blocks: Block[]): string[] => blocks.map((b) => b.type);

describe('export → import round trip (Markdown & CSV)', () => {
  it('keeps pages, text, structure, links, files and database values', () => {
    const entries = [
      ...exportPages(source(), { format: 'markdown', roots: 'all', includeSubpages: true }),
    ];
    const files = entries.map((e) => ({
      path: e.path,
      data: typeof e.data === 'string' ? new TextEncoder().encode(e.data) : e.data,
    }));
    const { t, workspace, docs, stored } = target();
    const report = importFiles(files, t, { title: 'Import' });
    expect(report).toMatchObject({ pages: 2, databases: 2, rows: 5, files: 1 });

    const pages = listPages(workspace);
    const byTitle = (title: string) => pages.find((p) => p.title === title)!;
    expect(byTitle('Import').id).toBe(report.rootId);
    expect(byTitle('Robot').parentId).toBe(report.rootId);
    for (const child of ['Specs', 'Tasks', 'Projects'])
      expect(byTitle(child).parentId).toBe(byTitle('Robot').id);
    expect(byTitle('Tasks').kind).toBe('database');

    const robot = docs.get(byTitle('Robot').id)!;
    const blocks = readBlocks(robot);
    expect(types(blocks)).toEqual([
      'heading',
      'paragraph',
      'callout',
      'bulletList',
      'taskList',
      'codeBlock',
      'blockMath',
      'table',
      'image',
      'database',
    ]);
    expect(blocks[1]!.text).toBe('A two-joint arm, see ');
    expect(blocks[2]!.props.icon).toBe('⚠️');
    expect(blocks[2]!.children[0]!.text).toBe('Pinch points');
    expect(blocks[5]!.props.language).toBe('python');
    expect(blocks[6]!.props.latex).toBe('E = mc^2');
    expect(blocks[8]!.props).toMatchObject({ fileId: 'stored-arm.png', caption: 'The arm' });
    expect(stored.get('arm.png')).toEqual(new Uint8Array([137, 80, 78, 71]));
    // Links point at the new pages.
    const links = readLinks(robot).map((l) => [l.kind, l.target]);
    expect(links).toEqual([['mention', byTitle('Specs').id]]);
    expect(readLinks(docs.get(byTitle('Specs').id)!).map((l) => l.target)).toEqual([
      byTitle('Robot').id,
    ]);

    // Databases: types and values, relations both ways.
    const tasks = readDatabase(docs.get(byTitle('Tasks').id)!);
    const projects = readDatabase(docs.get(byTitle('Projects').id)!);
    expect(tasks.properties.map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      // Empty in the source, so its type can't be told from the CSV.
      ['Tags', 'text'],
      ['Status', 'select'],
      ['Hours', 'number'],
      ['Due', 'date'],
      ['Reviewed', 'checkbox'],
      ['Projects', 'relation'],
    ]);
    const prop = (name: string) => tasks.properties.find((p) => p.name === name)!;
    const ctx = { users: new Map() };
    const row = (title: string) => tasks.rows.find((r) => r.title === title)!;
    expect(cellText(row('Tune PID'), prop('Status'), ctx)).toBe('Doing');
    expect(cellText(row('Tune PID'), prop('Hours'), ctx)).toBe('1.5');
    expect(row('Wire motors').values[prop('Due').id]).toEqual({ start: '2026-10-01' });
    expect(row('Wire motors').values[prop('Reviewed').id]).toBe(true);
    const arm = projects.rows.find((r) => r.title === 'Arm')!;
    expect(relationIds(row('Tune PID').values[prop('Projects').id]).sort()).toEqual(
      projects.rows.map((r) => r.id).sort(),
    );
    const back = projects.properties.find((p) => p.name === 'Tasks')!;
    expect(back.type).toBe('relation');
    expect(relationIds(arm.values[back.id]).length).toBe(2);
    // Row pages keep their content.
    expect(readBlocks(docs.get(row('Tune PID').id)!)[0]!.text).toBe('Use Ziegler–Nichols');
    expect(report.warnings).toEqual([]);
  });
});
