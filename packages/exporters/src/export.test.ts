import { createPage, trashPage } from '@workspace/core';
import {
  addProperty,
  addRow,
  createRelation,
  initDatabase,
  setRelation,
} from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { csvField } from './csv';
import {
  exportName,
  exportPages,
  mermaidSources,
  relativePath,
  type ExportOptions,
  type ExportSource,
} from './export';
import { el, setContent } from './testing';

const hex = (id: string) => id.replace(/-/g, '');

function workspace() {
  const ws = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const doc = (id: string) => {
    if (!docs.has(id)) docs.set(id, new Y.Doc());
    return docs.get(id)!;
  };
  const files = new Map([['abc.png', { bytes: new Uint8Array([1, 2, 3]), name: 'arm.png' }]]);
  const source: ExportSource = {
    workspace: ws,
    doc: (id) => docs.get(id) ?? null,
    file: (id) => files.get(id) ?? null,
    users: new Map([['u1', 'Ravi']]),
    now: new Date(2026, 9, 6).getTime(),
  };

  const robot = createPage(ws, { title: 'Robot / Arm' });
  const specs = createPage(ws, { title: 'Specs', parentId: robot });
  const old = createPage(ws, { title: 'Old notes', parentId: robot });
  trashPage(ws, old);
  const tasks = createPage(ws, { title: 'Tasks', parentId: robot, kind: 'database' });
  const parts = createPage(ws, { title: 'Parts', parentId: robot, kind: 'database' });
  initDatabase(doc(tasks), { databaseId: tasks });
  initDatabase(doc(parts), { databaseId: parts });
  const status = addProperty(doc(tasks), { name: 'Status', type: 'text' });
  const resolve = (id: string) => docs.get(id);
  const { propertyId: rel } = createRelation(resolve, {
    databaseId: tasks,
    name: 'Parts',
    targetId: parts,
    twoWay: { name: 'Tasks' },
  });
  const motor = addRow(doc(parts), { actor: 'u1', title: 'Motor' });
  const wire = addRow(doc(tasks), {
    actor: 'u1',
    title: 'Wire, motors',
    values: { [status]: 'Doing "now"' },
  });
  setRelation(resolve, tasks, wire, rel, [motor], 'u1');
  setContent(
    doc(robot),
    el('paragraph', {}, 'See ', el('mention', { kind: 'page', pageId: specs })),
    el('image', { fileId: 'abc.png', caption: '' }),
    el('image', { fileId: 'abc.png', caption: '' }),
    el('database', { pageId: tasks }),
    el('codeBlock', { language: 'mermaid' }, 'graph TD; A-->B'),
  );
  setContent(
    doc(specs),
    el('paragraph', {}, 'Back to ', el('mention', { kind: 'page', pageId: robot })),
  );
  setContent(
    doc(wire),
    el('paragraph', {}, 'Use the ', el('mention', { kind: 'page', pageId: motor })),
  );
  return { source, ids: { robot, specs, tasks, parts, wire, motor } };
}

const run = (source: ExportSource, options: Partial<ExportOptions> = {}) => {
  const progress: number[] = [];
  const entries = [
    ...exportPages(source, {
      format: 'markdown',
      roots: 'all',
      includeSubpages: true,
      onProgress: (done) => progress.push(done),
      ...options,
    }),
  ];
  return {
    files: new Map(entries.map((e) => [e.path, e.data])),
    paths: entries.map((e) => e.path),
    progress,
  };
};

describe('export layout', () => {
  it('names and paths like Notion', () => {
    expect(exportName(' Robot / Arm: v2 ', 'ab-cd')).toBe('Robot Arm v2 abcd');
    expect(exportName('', 'x')).toBe('Untitled x');
    expect(relativePath('A/B/c.md', 'A/d.md')).toBe('../d.md');
    expect(relativePath('A/c.md', 'A/c/e.md')).toBe('c/e.md');
    expect(relativePath('a.md', 'b.md')).toBe('b.md');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('plain')).toBe('plain');
  });

  it('exports pages, sub-pages, databases as CSV and rows, with links and attachments', () => {
    const { source, ids } = workspace();
    const { files, paths, progress } = run(source);
    const root = `Robot Arm ${hex(ids.robot)}`;
    const specs = `${root}/Specs ${hex(ids.specs)}.md`;
    const tasks = `${root}/Tasks ${hex(ids.tasks)}`;
    const wire = `${tasks}/Wire, motors ${hex(ids.wire)}.md`;
    const motor = `${root}/Parts ${hex(ids.parts)}/Motor ${hex(ids.motor)}.md`;
    expect(paths).toEqual([
      `${root}.md`,
      `${root}/arm.png`,
      specs,
      `${tasks}.csv`,
      wire,
      `${root}/Parts ${hex(ids.parts)}.csv`,
      motor,
    ]);
    // The trashed sub-page isn't there.
    expect(paths.some((p) => p.includes('Old notes'))).toBe(false);
    expect(progress.at(-1)).toBe(6);

    const page = files.get(`${root}.md`) as string;
    expect(page).toContain(`# Robot / Arm\n\nSee [Specs](${encodeURI(specs)})`);
    // The same file used twice is copied once.
    expect(page).toContain(`![image](${encodeURI(root)}/arm.png)`);
    expect(page.match(/arm\.png/g)).toHaveLength(2);
    expect(page).toContain(`[Tasks](${encodeURI(`${tasks}.csv`)})`);
    expect(page).toContain('```mermaid\ngraph TD; A-->B\n```');
    expect(files.get(`${root}/arm.png`)).toEqual(new Uint8Array([1, 2, 3]));
    // Links go up from sub-folders.
    expect(files.get(specs)).toContain(`[Robot / Arm](../${encodeURI(root)}.md)`);

    const csv = files.get(`${tasks}.csv`) as string;
    expect(csv.startsWith('﻿Name,Tags,Status,Parts\r\n')).toBe(true);
    expect(csv).toContain('"Wire, motors",,"Doing ""now""",Motor\r\n');
    const row = files.get(wire) as string;
    expect(row).toBe(
      `# Wire, motors\n\nStatus: Doing "now"\nParts: Motor\n\nUse the [Motor](${encodeURI(`../Parts ${hex(ids.parts)}/Motor ${hex(ids.motor)}.md`)})\n`,
    );
  });

  it('exports one page without its sub-pages; links elsewhere become workspace:// links', () => {
    const { source, ids } = workspace();
    const { paths, files } = run(source, { roots: [ids.specs], includeSubpages: false });
    expect(paths).toEqual([`Specs ${hex(ids.specs)}.md`]);
    expect(files.get(paths[0]!)).toContain(`[Robot / Arm](workspace://page/${ids.robot})`);
  });

  it('exports HTML with database tables and Mermaid diagrams', () => {
    const { source, ids } = workspace();
    expect(mermaidSources(source, { format: 'html', roots: 'all', includeSubpages: true })).toEqual(
      ['graph TD; A-->B'],
    );
    const { files } = run(source, {
      format: 'html',
      mermaidSvg: () => '<svg viewBox="0 0 1 1"></svg>',
    });
    const root = `Robot Arm ${hex(ids.robot)}`;
    const page = files.get(`${root}.html`) as string;
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain('<h1 class="page-title">Robot / Arm</h1>');
    expect(page).toContain('class="diagram"');
    const table = files.get(`${root}/Tasks ${hex(ids.tasks)}.html`) as string;
    expect(table).toContain('<th>Status</th>');
    expect(table).toContain(
      `<td class="title"><a href="Tasks ${hex(ids.tasks)}/Wire, motors ${hex(ids.wire)}.html">Wire, motors</a></td>`,
    );
    expect(
      files.get(`${root}/Tasks ${hex(ids.tasks)}/Wire, motors ${hex(ids.wire)}.html`),
    ).toContain('<dt>Status</dt><dd>Doing &quot;now&quot;</dd>');
  });
});
