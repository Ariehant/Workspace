import { listPages, readBlocks, readLinks } from '@workspace/core';
import { cellText, readDatabase, relationIds } from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { importFiles, type ImportTarget } from './import';
import { parseCsv } from './csv';
import { inferType } from './infer';
import { parseName, resolvePath } from './paths';

const R = '1a2b3c4d5e6f40718293a4b5c6d7e8f9';
const S = '2a2b3c4d5e6f40718293a4b5c6d7e8f9';
const T = '3a2b3c4d5e6f40718293a4b5c6d7e8f9';
const P = '4a2b3c4d5e6f40718293a4b5c6d7e8f9';
const W = '5a2b3c4d5e6f40718293a4b5c6d7e8f9';
const A = '6a2b3c4d5e6f40718293a4b5c6d7e8f9';
const enc = (text: string) => new TextEncoder().encode(text);

function target() {
  const workspace = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const t: ImportTarget = {
    workspace,
    doc: (id) => {
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return docs.get(id)!;
    },
    storeFile: (_bytes, name) => `file-${name}`,
  };
  const page = (title: string) => listPages(workspace).find((p) => p.title === title)!;
  return { t, workspace, docs, page };
}

describe('Notion export pieces', () => {
  it('reads names, paths, CSV and column types', () => {
    expect(parseName(`Robot arm ${R}.md`)).toEqual({
      title: 'Robot arm',
      id: R,
      ext: 'md',
      all: false,
    });
    expect(parseName(`Tasks ${T}_all.csv`)).toMatchObject({ title: 'Tasks', id: T, all: true });
    expect(parseName('notes.txt')).toMatchObject({ title: 'notes', id: null, ext: 'txt' });
    expect(resolvePath(`Robot ${R}.md`, `Robot%20${R}/Specs%20${S}.md`)).toBe(
      `Robot ${R}/Specs ${S}.md`,
    );
    expect(resolvePath(`A/B/c.md`, '../d.png')).toBe('A/d.png');
    expect(resolvePath('a.md', 'https://x.y')).toBeNull();
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
    expect(inferType(['Yes', 'No', 'Yes'])).toBe('checkbox');
    expect(inferType(['1,200', '3.5', ''])).toBe('number');
    expect(
      inferType(['October 1, 2026', 'October 6, 2026 9:15 AM', 'Oct 2, 2026 → Oct 4, 2026']),
    ).toBe('date');
    expect(inferType(['Run 1', 'Run 2', 'Run 3', 'Run 4'])).toBe('text');
    expect(inferType(['Done', 'Doing', 'Done', ''])).toBe('select');
    expect(inferType(['a, b', 'b', 'a, c'])).toBe('multiSelect');
    expect(inferType(['https://ros.org', 'http://x.y'])).toBe('url');
  });
});

describe('Notion Markdown & CSV export', () => {
  const files = [
    {
      path: `Robot ${R}.md`,
      data: enc(
        [
          '# Robot',
          'Arm with **two** joints. See [Specs](Robot%20' +
            R +
            '/Specs%20' +
            S +
            '.md) and [docs](https://ros.org).',
          '<aside>\n💡 Keep hands clear\n\n</aside>',
          '![arm.png](Robot%20' + R + '/arm.png)',
          '[Specs](Robot%20' + R + '/Specs%20' + S + '.md)',
          '[Tasks](Robot%20' + R + '/Tasks%20' + T + '.csv)',
          '- [x] Mount base',
          '```cpp\nint main() {}\n```',
          '$$\n\\tau = J^T F\n$$',
          'Line one<br>line two',
          '[Missing](Robot%20' + R + '/Gone%20' + A + '.md)',
        ].join('\n\n'),
      ),
    },
    { path: `Robot ${R}/arm.png`, data: new Uint8Array([1, 2, 3]) },
    { path: `Robot ${R}/Specs ${S}.md`, data: enc('# Specs\n\nTorque 2 Nm') },
    {
      path: `Robot ${R}/Tasks ${T}.csv`,
      data: enc('﻿Name,Status\nWire motors,Done\n'),
    },
    {
      path: `Robot ${R}/Tasks ${T}_all.csv`,
      data: enc(
        '﻿Name,Status,Due,Reviewed,Project,Created\n' +
          `Wire motors,Done,"October 1, 2026",Yes,Arm (../Projects%20${P}/Arm%20${A}.md),"October 6, 2026 9:15 AM"\n` +
          `Tune PID,Doing,,No,Arm (../Projects%20${P}/Arm%20${A}.md),"October 6, 2026 9:20 AM"\n`,
      ),
    },
    {
      path: `Robot ${R}/Tasks ${T}/Wire motors ${W}.md`,
      data: enc('# Wire motors\n\nStatus: Done\nDue: October 1, 2026\n\nUse 18 AWG.'),
    },
    { path: `Robot ${R}/Projects ${P}.csv`, data: enc('Name,Lead\nArm,Ravi\n') },
    {
      path: `Robot ${R}/Projects ${P}/Arm ${A}.md`,
      data: enc('# Arm\n\nLead: Ravi\n\nThe 6-DOF arm.'),
    },
  ];

  it('imports pages, databases, rows, relations, links and files', () => {
    const { t, docs, page } = target();
    const report = importFiles(files, t, { title: 'Notion' });
    expect(report).toMatchObject({ pages: 2, databases: 2, rows: 3, files: 1 });
    expect(report.warnings).toEqual(['A link to a missing file was kept as text: Robot/Gone.md']);

    const robot = readBlocks(docs.get(page('Robot').id)!);
    expect(robot.map((b) => b.type)).toEqual([
      'paragraph',
      'callout',
      'image',
      'pageLink',
      'database',
      'taskList',
      'codeBlock',
      'blockMath',
      'paragraph',
      'paragraph',
    ]);
    expect(robot[1]!.props.icon).toBe('💡');
    expect(robot[1]!.children[0]!.text).toBe('Keep hands clear');
    expect(robot[2]!.props).toMatchObject({ fileId: 'file-arm.png' });
    expect(robot[6]!.props.language).toBe('cpp');
    expect(robot[7]!.props.latex).toBe('\\tau = J^T F');
    const links = readLinks(docs.get(page('Robot').id)!);
    expect(links.map((l) => [l.kind, l.target])).toEqual([
      ['mention', page('Specs').id],
      ['pageLink', page('Specs').id],
    ]);
    // `<br>` became a line break.
    const breakPara = docs.get(page('Robot').id)!.getXmlFragment('content').get(8) as Y.XmlElement;
    expect(
      breakPara.toArray().some((n) => n instanceof Y.XmlElement && n.nodeName === 'hardBreak'),
    ).toBe(true);

    const tasks = readDatabase(docs.get(page('Tasks').id)!);
    expect(tasks.properties.map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      ['Status', 'select'],
      ['Due', 'date'],
      ['Reviewed', 'checkbox'],
      ['Project', 'relation'],
      ['Created', 'date'],
    ]);
    // `_all.csv` wins over the view's CSV.
    expect(tasks.rows.map((r) => r.title)).toEqual(['Wire motors', 'Tune PID']);
    const wire = tasks.rows[0]!;
    const prop = (name: string) => tasks.properties.find((p) => p.name === name)!;
    expect(cellText(wire, prop('Due'), { users: new Map() })).toBe('Oct 1, 2026');
    expect(wire.values[prop('Reviewed').id]).toBe(true);
    const projects = readDatabase(docs.get(page('Projects').id)!);
    const arm = projects.rows[0]!;
    expect(relationIds(wire.values[prop('Project').id])).toEqual([arm.id]);
    // The row page matched its file, so links to it and its content work.
    expect(readBlocks(docs.get(wire.id)!)[0]!.text).toBe('Use 18 AWG.');
    expect(readBlocks(docs.get(arm.id)!)[0]!.text).toBe('The 6-DOF arm.');
  });
});

describe('Notion HTML export', () => {
  const page = (body: string, title: string, header = '') =>
    enc(
      `<html><head><title>${title}</title></head><body><article class="page sans"><header>${header}<h1 class="page-title">${title}</h1></header><div class="page-body">${body}</div></article></body></html>`,
    );
  const files = [
    {
      path: `Robot ${R}.html`,
      data: page(
        `<p id="1">Arm with <strong>two</strong> joints, <mark class="highlight-red">hot</mark>. See <a href="Robot%20${R}/Specs%20${S}.html">Specs</a>.</p>` +
          `<h2>Parts</h2>` +
          `<ul class="bulleted-list"><li style="list-style-type:disc">Base<ul class="bulleted-list"><li>Bolts</li></ul></li></ul>` +
          `<ul class="to-do-list"><li><div class="checkbox checkbox-on"></div> <span class="to-do-children-checked">Mount</span></li></ul>` +
          `<ul class="toggle"><li><details open=""><summary>More</summary><p>Hidden detail</p></details></li></ul>` +
          `<figure class="block-color-gray_background callout" style="display:flex"><div style="font-size:1.5em"><span class="icon">⚠️</span></div><div style="width:100%">Pinch points</div></figure>` +
          `<pre class="code"><code class="language-Python">print(1)</code></pre>` +
          `<figure class="equation"><div class="equation-container"><span class="katex-display"><span class="katex"><annotation encoding="application/x-tex">E=mc^2</annotation></span></span></div></figure>` +
          `<figure class="image"><a href="Robot%20${R}/arm.png"><img src="Robot%20${R}/arm.png"/></a><figcaption>The arm</figcaption></figure>` +
          `<figure class="link-to-page"><a href="Robot%20${R}/Tasks%20${T}.html"><span class="icon">📋</span>Tasks</a></figure>` +
          `<div class="column-list"><div class="column"><p>Left</p></div><div class="column"><p>Right</p></div></div>` +
          `<table class="simple-table"><tbody><tr><td>J1</td><td>90°</td></tr></tbody></table>` +
          `<figure><a href="https://ros.org" class="bookmark source"><div class="bookmark-info"><div class="bookmark-text"><div class="bookmark-title">ROS</div></div></div></a></figure>`,
        'Robot',
        '<div class="page-header-icon undefined"><span class="icon">🤖</span></div>',
      ),
    },
    { path: `Robot ${R}/arm.png`, data: new Uint8Array([1]) },
    { path: `Robot ${R}/Specs ${S}.html`, data: page('<p>Torque 2 Nm</p>', 'Specs') },
    {
      path: `Robot ${R}/Tasks ${T}.html`,
      data: enc(
        `<html><body><article class="page sans"><header><h1 class="page-title">Tasks</h1></header><table class="collection-content"><thead><tr>` +
          `<th><span class="icon property-icon"><svg class="typesTitle"></svg></span>Name</th>` +
          `<th><span class="icon property-icon"><svg class="typesStatus"></svg></span>State</th>` +
          `<th><span class="icon property-icon"><svg class="typesNumber"></svg></span>Hours</th>` +
          `<th><span class="icon property-icon"><svg class="typesCheckbox"></svg></span>Reviewed</th>` +
          `<th><span class="icon property-icon"><svg class="typesFormula"></svg></span>Score</th>` +
          `</tr></thead><tbody>` +
          `<tr><td class="cell-title"><a href="Tasks%20${T}/Wire%20motors%20${W}.html">Wire motors</a></td><td><span class="selected-value select-value-color-green">Done</span></td><td>3</td><td><div class="checkbox checkbox-on"></div></td><td>7</td></tr>` +
          `<tr><td class="cell-title"><a href="Tasks%20${T}/Tune%20${A}.html">Tune</a></td><td><span class="selected-value select-value-color-blue">Blocked</span></td><td>1</td><td><div class="checkbox checkbox-off"></div></td><td>2</td></tr>` +
          `</tbody></table></article></body></html>`,
      ),
    },
    {
      path: `Robot ${R}/Tasks ${T}/Wire motors ${W}.html`,
      data: page('<p>Use 18 AWG.</p>', 'Wire motors'),
    },
  ];

  it('imports blocks, icons, colors, databases with their types and row pages', () => {
    const { t, docs, workspace, page: byTitle } = target();
    const report = importFiles(files, t, { title: 'Notion HTML' });
    expect(report).toMatchObject({ pages: 2, databases: 1, rows: 2, files: 1 });
    expect(report.warnings).toEqual(['“Score” in “Tasks” (a formula) was imported as text']);
    expect(byTitle('Robot').icon).toBe('🤖');
    const blocks = readBlocks(docs.get(byTitle('Robot').id)!);
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'heading',
      'bulletList',
      'taskList',
      'details',
      'callout',
      'codeBlock',
      'blockMath',
      'image',
      'database',
      'columnList',
      'table',
      'bookmark',
    ]);
    expect(blocks[0]!.text).toBe('Arm with two joints, hot. See .');
    expect(blocks[2]!.children[0]!.children.map((c) => c.type)).toEqual([
      'paragraph',
      'bulletList',
    ]);
    expect(blocks[3]!.children[0]!.props.checked).toBe(true);
    expect(blocks[5]!.props).toMatchObject({ icon: '⚠️', color: 'gray_background' });
    expect(blocks[6]!.props.language).toBe('python');
    expect(blocks[7]!.props.latex).toBe('E=mc^2');
    expect(blocks[8]!.props).toMatchObject({ fileId: 'file-arm.png', caption: 'The arm' });
    expect(blocks[12]!.props).toMatchObject({ url: 'https://ros.org', title: 'ROS' });
    const xml = docs.get(byTitle('Robot').id)!.getXmlFragment('content').toString();
    expect(xml).toContain('<color color="red">hot</color>');
    expect(readLinks(docs.get(byTitle('Robot').id)!).map((l) => l.target)).toEqual([
      byTitle('Specs').id,
    ]);

    const tasks = readDatabase(docs.get(byTitle('Tasks').id)!);
    expect(tasks.properties.map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      ['State', 'status'],
      ['Hours', 'number'],
      ['Reviewed', 'checkbox'],
      ['Score', 'text'],
    ]);
    const state = tasks.properties[1]!;
    expect(state.config.options!.find((o) => o.name === 'Blocked')).toMatchObject({
      color: 'blue',
    });
    const wire = tasks.rows.find((r) => r.title === 'Wire motors')!;
    expect(cellText(wire, state, { users: new Map() })).toBe('Done');
    expect(wire.values[tasks.properties[3]!.id]).toBe(true);
    expect(readBlocks(docs.get(wire.id)!)[0]!.text).toBe('Use 18 AWG.');
    expect(listPages(workspace).some((p) => p.title === 'Wire motors')).toBe(false);
  });

  it('imports plain Markdown, CSV and text files', () => {
    const { t, docs, page } = target();
    const report = importFiles(
      [
        { path: 'Notes/Meeting.md', data: enc('# Weekly sync\n\n- Arm is done') },
        { path: 'Notes/parts.csv', data: enc('Part,Qty\nBolt,12\nNut,30\n') },
        { path: 'Notes/todo.txt', data: enc('Buy motors\n\nCall vendor') },
      ],
      t,
      { title: 'Files' },
    );
    expect(report).toMatchObject({ pages: 2, databases: 1, rows: 2 });
    expect(readBlocks(docs.get(page('Weekly sync').id)!)[0]!.type).toBe('bulletList');
    expect(readBlocks(docs.get(page('todo').id)!).map((b) => b.text)).toEqual([
      'Buy motors',
      'Call vendor',
    ]);
    const parts = readDatabase(docs.get(page('parts').id)!);
    expect(parts.properties.map((p) => [p.name, p.type])).toEqual([
      ['Part', 'title'],
      ['Qty', 'number'],
    ]);
  });
});

describe('Notion links', () => {
  it('finds a database by its view CSV name when only `_all.csv` was exported', () => {
    const { t, docs, page } = target();
    importFiles(
      [
        { path: `Home ${R}.md`, data: enc(`# Home\n\n[Tasks](Home%20${R}/Tasks%20${T}.csv)`) },
        { path: `Home ${R}/Tasks ${T}_all.csv`, data: enc('Name\nA\n') },
      ],
      t,
      { title: 'x' },
    );
    expect(readBlocks(docs.get(page('Home').id)!)[0]).toMatchObject({
      type: 'database',
      props: { pageId: page('Tasks').id },
    });
  });
});

describe('the import page', () => {
  it('links to the top-level pages it holds', () => {
    const { t, docs } = target();
    const report = importFiles(
      [
        { path: 'a.md', data: enc('# A') },
        { path: 'b.csv', data: enc('Name\nx\n') },
      ],
      t,
      {
        title: 'Import',
      },
    );
    expect(readBlocks(docs.get(report.rootId)!).map((b) => b.type)).toEqual([
      'pageLink',
      'pageLink',
    ]);
  });
});
