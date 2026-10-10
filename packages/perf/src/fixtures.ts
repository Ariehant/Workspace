import { join } from 'node:path';
import {
  PageField,
  WORKSPACE_DOC_ID,
  createPage,
  getPageContent,
  setPageKind,
  upsertUser,
} from '@workspace/core';
import {
  RowField,
  TITLE_PROPERTY_ID,
  addProperty,
  addView,
  initDatabase,
  rowsMap,
  type SelectOption,
} from '@workspace/database';
import { DocManager, SqliteStore } from '@workspace/storage-local';
import { generateNKeysBetween } from 'fractional-indexing';
import * as Y from 'yjs';

/**
 * Generated workspaces for the performance budgets (docs/PHASE7.md, M1): a page with
 * thousands of blocks, and a database with tens of thousands of rows using every kind of
 * computed value (a formula, a relation and a rollup), as Yjs docs and as a desktop
 * workspace file. Everything is deterministic: the same sizes give the same content.
 */

export const IDS = {
  bigPage: 'perf-page',
  tasks: 'perf-tasks',
  projects: 'perf-projects',
  user: 'perf-user',
} as const;

/** Property ids in the Tasks database (fixed, so tests and specs can name them). */
export const TASK_PROPS = {
  title: TITLE_PROPERTY_ID,
  status: 'p-status',
  estimate: 'p-estimate',
  due: 'p-due',
  done: 'p-done',
  tags: 'p-tags',
  notes: 'p-notes',
  double: 'p-double',
  project: 'p-project',
  budget: 'p-budget',
} as const;

export const STATUSES = ['Not started', 'In progress', 'Blocked', 'Done'] as const;
const TAGS = ['frontend', 'backend', 'design', 'docs', 'infra', 'research'] as const;
const WORDS = (
  'actuator servo lidar odometry kinematics gripper torque encoder planner trajectory ' +
  'calibration firmware telemetry battery chassis payload sensor fusion mapping localization ' +
  'controller feedback damping inertia wheel joint arm camera depth stereo'
).split(' ');

/** A small deterministic generator (mulberry32), so fixtures don't depend on Math.random. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(list: readonly T[], r: () => number): T => list[Math.floor(r() * list.length)]!;
const words = (n: number, r: () => number) =>
  Array.from({ length: n }, () => pick(WORDS, r)).join(' ');
const options = (names: readonly string[], prefix: string): SelectOption[] =>
  names.map((name, i) => ({
    id: `${prefix}${i}`,
    name,
    color: (['gray', 'blue', 'red', 'green', 'purple', 'orange'] as const)[i % 6]!,
  }));

function setSchema(doc: Y.Doc, id: string, name: string, type: string, config: object) {
  // `addProperty` makes random ids; rename the result to a fixed one.
  const made = addProperty(doc, { name, type: type as never, config });
  const schema = doc.getMap<Y.Map<unknown>>('schema');
  const map = schema.get(made)!;
  const copy = new Y.Map<unknown>();
  for (const [key, value] of map.entries()) copy.set(key, key === 'id' ? id : value);
  schema.delete(made);
  schema.set(id, copy);
  const views = doc.getMap<Y.Map<unknown>>('views');
  for (const view of views.values()) {
    const columns = (view.get('properties') as { id: string; visible: boolean }[]) ?? [];
    view.set(
      'properties',
      columns.map((c) => (c.id === made ? { ...c, id } : c)),
    );
  }
}

function newRow(id: string, title: string, sortKey: string, time: number, uid: number) {
  const row = new Y.Map<unknown>();
  const text = new Y.Text();
  text.insert(0, title);
  row.set(PageField.id, id);
  row.set(PageField.title, text);
  row.set(PageField.icon, null);
  row.set(PageField.sortKey, sortKey);
  row.set(PageField.createdAt, time);
  row.set(PageField.updatedAt, time);
  row.set(PageField.trashedAt, null);
  row.set(RowField.createdBy, IDS.user);
  row.set(RowField.updatedBy, IDS.user);
  row.set(RowField.uid, uid);
  return row;
}

export interface DatabaseFixture {
  tasks: Y.Doc;
  projects: Y.Doc;
}

/**
 * The Tasks database (`rows` rows) and the Projects database it relates to. Tasks has a
 * status, a number, a date, a checkbox, tags, notes, a formula over the number, a relation
 * to a project (stored as the app stores it) and a rollup of that project's budget.
 */
export function buildDatabases(rows: number, projectCount = 200): DatabaseFixture {
  const r = random(rows);
  const base = Date.UTC(2026, 0, 1);

  const projects = new Y.Doc({ guid: IDS.projects });
  initDatabase(projects, { databaseId: IDS.projects });
  setSchema(projects, 'p-budget', 'Budget', 'number', { numberFormat: 'dollar' });
  const projectIds = Array.from({ length: projectCount }, (_, i) => `proj-${i}`);
  projects.transact(() => {
    const map = rowsMap(projects);
    const keys = generateNKeysBetween(null, null, projectCount);
    projectIds.forEach((id, i) => {
      const row = newRow(id, `Project ${i + 1}: ${words(2, r)}`, keys[i]!, base, i + 1);
      const values = new Y.Map<unknown>();
      values.set('p-budget', 1000 + Math.floor(r() * 9000));
      row.set(RowField.values, values);
      map.set(id, row);
    });
  });

  const tasks = new Y.Doc({ guid: IDS.tasks });
  initDatabase(tasks, { databaseId: IDS.tasks, viewName: 'All tasks' });
  tasks.transact(() => {
    setSchema(tasks, TASK_PROPS.status, 'Status', 'select', { options: options(STATUSES, 's') });
    setSchema(tasks, TASK_PROPS.estimate, 'Estimate', 'number', {});
    setSchema(tasks, TASK_PROPS.due, 'Due', 'date', {});
    setSchema(tasks, TASK_PROPS.done, 'Done', 'checkbox', {});
    setSchema(tasks, TASK_PROPS.tags, 'Labels', 'multiSelect', { options: options(TAGS, 't') });
    setSchema(tasks, TASK_PROPS.notes, 'Notes', 'text', {});
    setSchema(tasks, TASK_PROPS.double, 'Double', 'formula', {
      expression: 'prop("Estimate") * 2',
    });
    setSchema(tasks, TASK_PROPS.project, 'Project', 'relation', {
      databaseId: IDS.projects,
      syncedPropertyId: null,
      limitOne: true,
    });
    setSchema(tasks, TASK_PROPS.budget, 'Budget', 'rollup', {
      relationId: TASK_PROPS.project,
      targetPropertyId: 'p-budget',
      calculation: 'sum',
    });
    // Drop the starting "Tags" property: the fixture has its own.
    const schema = tasks.getMap<Y.Map<unknown>>('schema');
    for (const [id, map] of [...schema.entries()]) {
      if (map.get('name') === 'Tags') schema.delete(id);
    }
    addView(tasks, { viewSet: IDS.tasks, name: 'By status', type: 'board' });
    addView(tasks, { viewSet: IDS.tasks, name: 'List', type: 'list' });
    addView(tasks, { viewSet: IDS.tasks, name: 'Gallery', type: 'gallery' });
  });

  tasks.transact(() => {
    const map = rowsMap(tasks);
    const keys = generateNKeysBetween(null, null, rows);
    for (let i = 0; i < rows; i++) {
      const id = `task-${i}`;
      const time = base + i * 60_000;
      const row = newRow(id, `Task ${i + 1}: ${words(3, r)}`, keys[i]!, time, i + 1);
      const values = new Y.Map<unknown>();
      values.set(TASK_PROPS.status, `s${Math.floor(r() * STATUSES.length)}`);
      values.set(TASK_PROPS.estimate, Math.floor(r() * 100));
      const day = new Date(base + Math.floor(r() * 365) * 86_400_000).toISOString().slice(0, 10);
      values.set(TASK_PROPS.due, { start: day });
      values.set(TASK_PROPS.done, r() < 0.3);
      values.set(TASK_PROPS.tags, [`t${Math.floor(r() * TAGS.length)}`]);
      values.set(TASK_PROPS.notes, words(6, r));
      const link = new Y.Map<number>();
      link.set(pick(projectIds, r), 1);
      values.set(TASK_PROPS.project, link);
      row.set(RowField.values, values);
      map.set(id, row);
    }
  });
  return { tasks, projects };
}

const element = (
  type: string,
  attrs: Record<string, string | number | boolean>,
  children: Y.XmlElement[] | string,
) => {
  const el = new Y.XmlElement(type);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value as string);
  el.insert(0, typeof children === 'string' ? [new Y.XmlText(children)] : children);
  return el;
};

/**
 * A page doc with `blocks` top-level blocks: a heading every 50 blocks, and paragraphs,
 * bulleted items and to-dos in between, each with a block id as the editor gives them.
 */
export function buildBigPage(blocks: number): Y.Doc {
  const r = random(blocks + 1);
  const doc = new Y.Doc({ guid: IDS.bigPage });
  const nodes: Y.XmlElement[] = [];
  for (let i = 0; i < blocks; i++) {
    const id = `b${i}`;
    if (i % 50 === 0) {
      nodes.push(element('heading', { id, level: 2 }, `Section ${i / 50 + 1}: ${words(3, r)}`));
    } else if (i % 7 === 3) {
      nodes.push(
        element('bulletList', {}, [
          element('listItem', { id }, [element('paragraph', {}, words(8, r))]),
        ]),
      );
    } else if (i % 11 === 5) {
      nodes.push(
        element('taskList', {}, [
          element('taskItem', { id, checked: r() < 0.5 }, [element('paragraph', {}, words(6, r))]),
        ]),
      );
    } else {
      nodes.push(element('paragraph', { id }, `${i}. ${words(12 + Math.floor(r() * 12), r)}`));
    }
  }
  getPageContent(doc).insert(0, nodes);
  return doc;
}

export interface WorkspaceSizes {
  rows: number;
  blocks: number;
}

/** The workspace doc holding the three pages, and their docs. */
export function buildWorkspace(sizes: WorkspaceSizes): Map<string, Y.Doc> {
  const workspace = new Y.Doc({ guid: WORKSPACE_DOC_ID });
  const now = Date.UTC(2026, 0, 1);
  upsertUser(workspace, { id: IDS.user, name: 'Perf' });
  createPage(workspace, {
    id: IDS.bigPage,
    title: `Long page (${sizes.blocks.toLocaleString('en-US')} blocks)`,
    icon: '📜',
    now,
  });
  createPage(workspace, { id: IDS.projects, title: 'Projects', icon: '📁', now });
  setPageKind(workspace, IDS.projects, 'database');
  createPage(workspace, {
    id: IDS.tasks,
    title: `Tasks (${sizes.rows.toLocaleString('en-US')} rows)`,
    icon: '✅',
    now,
  });
  setPageKind(workspace, IDS.tasks, 'database');
  const { tasks, projects } = buildDatabases(sizes.rows);
  return new Map([
    [WORKSPACE_DOC_ID, workspace],
    [IDS.bigPage, buildBigPage(sizes.blocks)],
    [IDS.projects, projects],
    [IDS.tasks, tasks],
  ]);
}

/**
 * Write a desktop workspace (`<dir>/workspace.db`) holding the generated docs, with its
 * search index built, as the app would have it after a restore. Returns the timings.
 */
export function writeWorkspace(
  dir: string,
  sizes: WorkspaceSizes,
): { buildMs: number; indexMs: number } {
  let start = performance.now();
  const docs = buildWorkspace(sizes);
  const buildMs = performance.now() - start;
  const store = new SqliteStore(join(dir, 'workspace.db'));
  try {
    for (const [id, doc] of docs) {
      store.appendUpdate(id, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    }
    start = performance.now();
    const manager = new DocManager(store);
    manager.reindexAll();
    manager.close();
    return { buildMs, indexMs: performance.now() - start };
  } finally {
    store.close();
  }
}
