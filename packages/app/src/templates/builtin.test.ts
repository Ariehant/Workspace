import { createPage, getPageContent, listPages, readLinks } from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  cellText,
  instantiateBundle,
  readDatabase,
  relationIds,
} from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { BUILTIN_TEMPLATES, TEMPLATE_CATEGORIES } from './builtin';

async function use(id: string) {
  const template = BUILTIN_TEMPLATES.find((t) => t.id === id)!;
  const bundle = await template.build();
  const workspace = new Y.Doc();
  const docs = new Map<string, Y.Doc>();
  const doc = (docId: string) => {
    if (!docs.has(docId)) docs.set(docId, new Y.Doc());
    return docs.get(docId)!;
  };
  const home = createPage(workspace, { title: 'Home' });
  const root = await instantiateBundle(bundle, workspace, {
    parentId: home,
    withDoc: async (docId, fn) => fn(doc(docId)),
  });
  const pages = listPages(workspace);
  const byTitle = (title: string) => pages.find((p) => p.title === title)!;
  return { root, pages, byTitle, doc };
}

describe('built-in templates', () => {
  it('cover every category, with unique ids', () => {
    expect(new Set(BUILTIN_TEMPLATES.map((t) => t.id)).size).toBe(BUILTIN_TEMPLATES.length);
    for (const category of TEMPLATE_CATEGORIES) {
      expect(
        BUILTIN_TEMPLATES.some((t) => t.category === category),
        category,
      ).toBe(true);
    }
  });

  it.each(BUILTIN_TEMPLATES.map((t) => t.id))(
    '%s builds and copies into a workspace',
    async (id) => {
      const template = BUILTIN_TEMPLATES.find((t) => t.id === id)!;
      const { root, pages, doc } = await use(id);
      const top = pages.find((p) => p.id === root)!;
      expect(top.title).toBe(template.name === 'Contacts (CRM)' ? 'Contacts' : template.name);
      for (const page of pages.filter((p) => p.kind === 'database')) {
        const db = readDatabase(doc(page.id));
        expect(db.rows.length, page.title).toBeGreaterThan(0);
        expect(db.views[0]!.viewSet).toBe(page.id);
      }
      for (const page of pages.filter((p) => p.kind === 'page' && p.title !== 'Home')) {
        expect(getPageContent(doc(page.id)).length, page.title).toBeGreaterThan(0);
      }
    },
  );

  it('tasks and projects: selects set, tasks linked to their projects both ways', async () => {
    const { root, byTitle, doc } = await use('tasks-projects');
    const tasks = readDatabase(doc(byTitle('Tasks').id));
    const projects = readDatabase(doc(byTitle('Projects').id));
    const status = tasks.properties.find((p) => p.name === 'Status')!;
    const print = tasks.rows.find((r) => r.title === 'Print test fingers')!;
    expect(cellText(print, status, { users: new Map() })).toBe('In progress');
    const relation = tasks.properties.find((p) => p.name === 'Project')!;
    const gripper = projects.rows.find((r) => r.title === 'Gripper v2')!;
    expect(relationIds(print.values[relation.id])).toEqual([gripper.id]);
    const back = projects.properties.find((p) => p.name === 'Tasks')!;
    expect(relationIds(gripper.values[back.id])).toHaveLength(3);
    expect(projects.views.map((v) => v.type)).toEqual(['table', 'timeline']);
    // Bars run from Start to End.
    const timeline = projects.views.find((v) => v.type === 'timeline')!;
    const named = (id: string | null) => projects.properties.find((p) => p.id === id)?.name;
    expect([named(timeline.dateProperty), named(timeline.endDateProperty)]).toEqual([
      'Start',
      'End',
    ]);
    // The root page shows both databases inline.
    expect(readLinks(doc(root)).length).toBe(0);
    const blocks = getPageContent(doc(root))
      .toArray()
      .map((n) => (n as Y.XmlElement).nodeName);
    expect(blocks.filter((b) => b === 'database')).toHaveLength(2);
    // Row pages keep their content.
    const test = tasks.rows.find((r) => r.title === 'Grip force test')!;
    expect(getPageContent(doc(test.id)).length).toBeGreaterThan(0);
  });

  it('experiment log: title property renamed, link to its sub-page points at the copy', async () => {
    const { root, byTitle, doc } = await use('experiment-log');
    const runs = readDatabase(doc(byTitle('Runs').id));
    expect(runs.properties.find((p) => p.id === TITLE_PROPERTY_ID)!.name).toBe('Run');
    expect(readLinks(doc(root)).map((l) => l.target)).toEqual([
      byTitle('Setup and calibration').id,
    ]);
  });
});
