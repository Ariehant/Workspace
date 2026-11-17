import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { listPages, readBlocks, readLinks } from '@workspace/core';
import { cellText, readDatabase, readViews } from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { md5Hex } from './md5';
import { importFiles, type ImportTarget } from './import';
import { enmlToHtml, parseEnex } from './evernote';
import type { ArchiveFile } from './paths';

const FIXTURES = join(__dirname, '..', 'fixtures');

/** A fixture folder's files, as an import gets them from a zip. */
function fixture(name: string): ArchiveFile[] {
  const root = join(FIXTURES, name);
  const walk = (dir: string): ArchiveFile[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory()
        ? walk(path)
        : [
            {
              path: relative(root, path).replace(/\\/g, '/'),
              data: new Uint8Array(readFileSync(path)),
            },
          ];
    });
  return walk(root);
}

function target() {
  const workspace = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const stored: { name: string; mime: string; size: number }[] = [];
  const t: ImportTarget = {
    workspace,
    doc: (id) => {
      if (!docs.has(id)) docs.set(id, new Y.Doc());
      return docs.get(id)!;
    },
    storeFile: (bytes, name, mime) => {
      stored.push({ name, mime, size: bytes.length });
      return `file-${name}`;
    },
  };
  const page = (title: string) => listPages(workspace).find((p) => p.title === title)!;
  const blocks = (id: string) => readBlocks(docs.get(id)!);
  return { t, docs, stored, page, blocks };
}

const display = { users: new Map() };

describe('MD5', () => {
  it('matches the RFC 1321 test vectors', () => {
    const md5 = (text: string) => md5Hex(new TextEncoder().encode(text));
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('a'.repeat(1000))).toBe('cabe45dcc9ae5b66ba86600cca6b8ba8');
  });
});

describe('Evernote', () => {
  it('reads notes, dates, tags and attachments', () => {
    const [file] = fixture('evernote');
    const notes = parseEnex(new TextDecoder().decode(file!.data));
    expect(notes.map((n) => n.title)).toEqual(['Gripper ideas & tests', 'Bring-up checklist']);
    expect(notes[0]).toMatchObject({
      tags: ['hardware', 'gripper'],
      sourceUrl: 'https://example.org/grippers',
      createdMs: Date.UTC(2026, 9, 1, 8, 30),
    });
    expect(notes[0]!.resources.map((r) => [r.name, r.hash])).toEqual([
      ['finger.png', '2cd8bde463f5d82aae0f0cec061d6b8f'],
      ['datasheet.pdf', 'f05285f24eb4ca080ccbd573c23954ea'],
    ]);
    const warnings: string[] = [];
    const html = enmlToHtml(notes[0]!.content, (m) => warnings.push(m));
    expect(html).toContain('<img src="evernote-resource:2cd8bde463f5d82aae0f0cec061d6b8f">');
    expect(html).not.toContain('en-crypt');
    expect(warnings).toHaveLength(1);
  });

  it('imports a notebook as a database of notes', () => {
    const { t, docs, stored, page, blocks } = target();
    const report = importFiles(fixture('evernote'), t, { title: 'Evernote' });
    expect(report).toMatchObject({ pages: 0, databases: 1, rows: 2, files: 2 });
    expect(report.warnings).toEqual(['Encrypted text in Evernote notes can’t be imported']);
    expect(stored.map((s) => [s.name, s.mime])).toEqual([
      ['finger.png', 'image/png'],
      ['datasheet.pdf', 'application/pdf'],
    ]);

    const db = readDatabase(docs.get(page('Robotics').id)!);
    const prop = (name: string) => db.properties.find((p) => p.name === name)!;
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([
      ['Title', 'title'],
      ['Tags', 'multiSelect'],
      ['Created', 'date'],
      ['Updated', 'date'],
      ['Source', 'url'],
    ]);
    const [gripper, bringUp] = db.rows;
    expect(gripper!.title).toBe('Gripper ideas & tests');
    expect(gripper!.createdAt).toBe(Date.UTC(2026, 9, 1, 8, 30));
    expect(cellText(gripper!, prop('Tags'), display)).toBe('hardware, gripper');
    expect(cellText(gripper!, prop('Source'), display)).toBe('https://example.org/grippers');
    expect(cellText(bringUp!, prop('Tags'), display)).toBe('hardware');

    const content = blocks(gripper!.id);
    expect(content.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'taskList',
      'taskList',
      'image',
      'bulletList',
      'pdf',
    ]);
    expect(content[1]!.text).toBe('Silicone fingers, two chambers, 40 kPa max.');
    expect(content[2]!.children[0]).toMatchObject({ props: { checked: true } });
    expect(content[3]!.children[0]).toMatchObject({ props: { checked: false } });
    expect(content[4]!.props).toMatchObject({ fileId: 'file-finger.png' });
    // The PDF isn't in the note's text, so it's added at the end.
    expect(content[6]!.props).toMatchObject({ fileId: 'file-datasheet.pdf' });

    // Evernote 10's checklists.
    const list = blocks(bringUp!.id);
    expect(list.map((b) => b.type)).toEqual(['paragraph', 'taskList']);
    expect(list[1]!.children.map((c) => c.props.checked)).toEqual([true, false]);
  });
});

describe('Trello', () => {
  it('imports a board as a database shown as a board', () => {
    const { t, docs, page, blocks } = target();
    const report = importFiles(fixture('trello'), t, { title: 'Trello' });
    expect(report).toMatchObject({ databases: 1, rows: 3 });
    expect(report.warnings).toEqual(['2 archived Trello cards were left out']);

    const doc = docs.get(page('Arm build').id)!;
    const db = readDatabase(doc);
    const prop = (name: string) => db.properties.find((p) => p.name === name)!;
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([
      ['Card', 'title'],
      ['List', 'select'],
      ['Labels', 'multiSelect'],
      ['Due', 'date'],
      ['Done', 'checkbox'],
      ['Members', 'text'],
    ]);
    // Lists in their board order; archived ones left out.
    expect(prop('List').config.options!.map((o) => o.name)).toEqual(['To do', 'Doing', 'Done']);
    expect(prop('Labels').config.options!.map((o) => [o.name, o.color])).toEqual([
      ['Hardware', 'orange'],
      ['Software', 'blue'],
      ['red', 'red'],
    ]);
    expect(db.rows.map((r) => r.title)).toEqual([
      'Write the joint driver',
      'Mount the base',
      'Order servos',
    ]);
    const mount = db.rows[1]!;
    expect(cellText(mount, prop('List'), display)).toBe('Doing');
    expect(cellText(mount, prop('Labels'), display)).toBe('Hardware, red');
    expect(cellText(mount, prop('Members'), display)).toBe('Asha Rao, lee');
    const due = new Date('2026-11-20T15:30:00.000Z');
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(mount.values[prop('Due').id]).toEqual({
      start: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T${pad(due.getHours())}:${pad(due.getMinutes())}`,
    });
    expect(db.rows[2]!.values[prop('Done').id]).toBe(true);
    // Created when the card's id says.
    expect(mount.createdAt).toBe(0x6720a1b2 * 1000);

    const [board, table] = readViews(doc);
    expect(board).toMatchObject({
      name: 'Board',
      type: 'board',
      groupBy: { propertyId: prop('List').id },
    });
    expect(table).toMatchObject({ name: 'All cards', type: 'table' });

    const content = blocks(mount.id);
    expect(content.map((b) => [b.type, b.text])).toEqual([
      ['paragraph', 'Bolt the base to the bench.'],
      ['bulletList', ''],
      ['heading', 'Steps'],
      ['taskList', ''],
      ['heading', 'Attachments'],
      ['bulletList', ''],
      ['heading', 'Comments'],
      ['paragraph', 'Asha Rao, 2026-11-02: Bolts arrived.'],
    ]);
    expect(content[3]!.children.map((c) => [c.props.checked, c.children[0]!.text])).toEqual([
      [true, 'Drill holes'],
      [false, 'Level the plate'],
    ]);
    // Only web links are kept.
    expect(content[5]!.children).toHaveLength(1);
  });
});

describe('Confluence', () => {
  it('imports a space: the page tree, content, attachments and links', () => {
    const { t, stored, page, blocks, docs } = target();
    const report = importFiles(fixture('confluence'), t, { title: 'Confluence' });
    expect(report).toMatchObject({ pages: 4, databases: 0, files: 2 });
    expect(report.warnings).toEqual([]);
    expect(stored.map((s) => s.name)).toEqual(['elbow.png', 'drive-datasheet.pdf']);

    // The space, its home page, and the tree under it.
    expect(page('Robotics').parentId).toBe(page('Confluence').id);
    expect(page('Home').parentId).toBe(page('Robotics').id);
    expect(page('Arm design').parentId).toBe(page('Home').id);
    expect(page('Controllers').parentId).toBe(page('Arm design').id);

    const arm = blocks(page('Arm design').id);
    expect(arm.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'callout',
      'image',
      'codeBlock',
      'taskList',
      'table',
      'paragraph',
      'pdf',
    ]);
    expect(arm[2]!.props.icon).toBe('❗');
    expect(arm[2]!.children.map((c) => c.text)).toEqual([
      'Pinch points',
      'Keep hands clear of the elbow.',
    ]);
    expect(arm[3]!.props).toMatchObject({ fileId: 'file-elbow.png' });
    expect(arm[4]!.props.language).toBe('python');
    expect(arm[4]!.text).toBe('limits = {"elbow": 2.6}');
    expect(arm[5]!.children.map((c) => c.props.checked)).toEqual([true, false]);
    // The datasheet is only in the attachments list, so it's added at the end.
    expect(arm[8]!.props).toMatchObject({ fileId: 'file-drive-datasheet.pdf' });

    // Links between pages point at the new pages.
    const targets = (title: string) => readLinks(docs.get(page(title).id)!).map((l) => l.target);
    expect(targets('Home')).toEqual([page('Arm design').id]);
    expect(targets('Arm design')).toEqual([page('Controllers').id]);
    expect(targets('Controllers')).toEqual([page('Arm design').id]);
  });

  it('falls back to the breadcrumbs without an index', () => {
    const { t, page } = target();
    const files = fixture('confluence').filter((f) => !f.path.endsWith('index.html'));
    importFiles(files, t, { title: 'Space' });
    expect(page('Controllers').parentId).toBe(page('Arm design').id);
    expect(page('Arm design').parentId).toBe(page('Home').id);
  });
});

describe('Choosing the importer', () => {
  it('keeps an .enex or board .json inside a Notion export as an attachment', () => {
    const { t, stored } = target();
    const enex = fixture('evernote')[0]!;
    const board = fixture('trello')[0]!;
    const report = importFiles(
      [
        {
          path: 'Notes.md',
          data: new TextEncoder().encode('# Notes\n\n[nb](nb.enex) [b](b.json)'),
        },
        { path: 'nb.enex', data: enex.data },
        { path: 'b.json', data: board.data },
      ],
      t,
      { title: 'Mixed' },
    );
    expect(report).toMatchObject({ pages: 1, databases: 0, files: 2 });
    expect(stored.map((s) => s.name)).toEqual(['nb.enex', 'b.json']);
  });
});
