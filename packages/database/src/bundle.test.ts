import { createPage, getPageContent, listPages, readLinks, trashPage } from '@workspace/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addRow,
  captureBundle,
  createRelation,
  initDatabase,
  instantiateBundle,
  readDatabase,
  relationIds,
  setMeta,
  setRelation,
  type WithDoc,
} from './index';

class Store {
  docs = new Map<string, Y.Doc>();
  get(id: string) {
    let doc = this.docs.get(id);
    if (!doc) this.docs.set(id, (doc = new Y.Doc()));
    return doc;
  }
  withDoc: WithDoc = async (id, use) => use(this.get(id));
}

function mention(doc: Y.Doc, pageId: string) {
  const p = new Y.XmlElement('paragraph');
  const m = new Y.XmlElement('mention');
  m.setAttribute('kind', 'page');
  m.setAttribute('pageId', pageId);
  p.insert(0, [new Y.XmlText('See '), m]);
  getPageContent(doc).insert(0, [p]);
}

describe('page bundles', () => {
  it('copies a page tree with related databases, rows and links as a new tree', async () => {
    const workspace = new Y.Doc();
    const store = new Store();
    const root = createPage(workspace, { title: 'Lab', icon: '🤖' });
    const tasks = createPage(workspace, { parentId: root, title: 'Tasks', kind: 'database' });
    const projects = createPage(workspace, { parentId: root, title: 'Projects', kind: 'database' });
    const trashed = createPage(workspace, { parentId: root, title: 'Old' });
    trashPage(workspace, trashed);
    initDatabase(store.get(tasks), { databaseId: tasks });
    initDatabase(store.get(projects), { databaseId: projects });
    const resolve = (id: string) => store.docs.get(id);
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: tasks,
      name: 'Project',
      targetId: projects,
      twoWay: { name: 'Tasks' },
    });
    const arm = addRow(store.get(projects), { actor: null, title: 'Arm' });
    const wire = addRow(store.get(tasks), { actor: null, title: 'Wire motors' });
    setRelation(resolve, tasks, wire, propertyId, [arm], null);
    setMeta(store.get(tasks), { defaultTemplateId: null });
    mention(store.get(root), tasks);
    mention(store.get(wire), arm);

    const bundle = await captureBundle(workspace, root, store.withDoc);
    expect(bundle.pages.map((p) => p.title).sort()).toEqual(['Lab', 'Projects', 'Tasks']);
    expect(Object.keys(bundle.docs)).toEqual(expect.arrayContaining([root, tasks, projects, wire]));

    // Into another workspace, through the encoded form (as stored).
    const target = new Y.Doc();
    const out = new Store();
    const parent = createPage(target, { title: 'Home' });
    const copied = structuredClone(bundle);
    const newRoot = await instantiateBundle(copied, target, {
      parentId: parent,
      withDoc: out.withDoc,
    });
    const pages = listPages(target);
    const byTitle = (t: string) => pages.find((p) => p.title === t)!;
    expect(byTitle('Lab').id).toBe(newRoot);
    expect(byTitle('Lab').parentId).toBe(parent);
    expect(byTitle('Lab').icon).toBe('🤖');
    expect(byTitle('Tasks').parentId).toBe(newRoot);
    expect(pages.some((p) => p.title === 'Old')).toBe(false);
    const newTasks = byTitle('Tasks').id;
    const newProjects = byTitle('Projects').id;
    expect([newTasks, newProjects]).not.toContain(tasks);

    // The relation links the copies, both ways.
    const t = readDatabase(out.get(newTasks));
    const p = readDatabase(out.get(newProjects));
    expect(t.views[0]!.viewSet).toBe(newTasks);
    const newWire = t.rows.find((r) => r.title === 'Wire motors')!;
    const newArm = p.rows.find((r) => r.title === 'Arm')!;
    expect(newWire.id).not.toBe(wire);
    expect(relationIds(newWire.values[propertyId])).toEqual([newArm.id]);
    expect(relationIds(newArm.values[syncedPropertyId!])).toEqual([newWire.id]);
    expect(t.properties.find((x) => x.id === propertyId)!.config).toMatchObject({
      databaseId: newProjects,
      syncedPropertyId,
    });

    // Links in pages and rows point at the copies.
    expect(readLinks(out.get(newRoot)).map((l) => l.target)).toEqual([newTasks]);
    expect(readLinks(out.get(newWire.id)).map((l) => l.target)).toEqual([newArm.id]);
  });
});
