import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ComputedCache,
  DatabaseHandle,
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  computeRollup,
  copyDatabase,
  createRelation,
  deleteRelation,
  duplicateProperty,
  duplicateRow,
  enableDependencies,
  enableSubItems,
  groupRows,
  initDatabase,
  matchesFilter,
  readDatabase,
  readMeta,
  readRelation,
  rollupCalculationsFor,
  setCell,
  setRelation,
  syncTwoWayLinks,
  trashRow,
  updateRelation,
  type DatabaseSnapshot,
  type DocResolver,
  type RollupCalculation,
} from './index';
import { prop, row } from './testing';

const ctx = { users: new Map<string, string>() };

function setup() {
  const docs = new Map<string, Y.Doc>();
  const make = (id: string) => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: id });
    docs.set(id, doc);
    return doc;
  };
  const projects = make('projects');
  const tasks = make('tasks');
  const resolve: DocResolver = (id) => docs.get(id);
  for (const t of ['Design', 'Build', 'Test']) {
    addRow(tasks, { actor: null, id: t.toLowerCase(), title: t });
  }
  for (const p of ['Alpha', 'Beta']) {
    addRow(projects, { actor: null, id: p.toLowerCase(), title: p });
  }
  return { docs, projects, tasks, resolve };
}

describe('relations', () => {
  it('two-way relations keep both sides in sync', () => {
    const { projects, tasks, resolve } = setup();
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
      twoWay: { name: 'Project' },
    });
    expect(readDatabase(tasks).properties.find((p) => p.id === syncedPropertyId)).toMatchObject({
      name: 'Project',
      type: 'relation',
      config: { databaseId: 'projects', syncedPropertyId: propertyId },
    });

    setRelation(resolve, 'projects', 'alpha', propertyId, ['design', 'build'], 'u1');
    expect(readRelation(projects, 'alpha', propertyId)).toEqual(['design', 'build']);
    expect(readRelation(tasks, 'design', syncedPropertyId!)).toEqual(['alpha']);
    expect(readRelation(tasks, 'build', syncedPropertyId!)).toEqual(['alpha']);

    // Editing from the other side updates this one.
    setRelation(resolve, 'tasks', 'test', syncedPropertyId!, ['alpha', 'beta'], null);
    expect(readRelation(projects, 'alpha', propertyId)).toEqual(['design', 'build', 'test']);
    expect(readRelation(projects, 'beta', propertyId)).toEqual(['test']);

    setRelation(resolve, 'projects', 'alpha', propertyId, ['test'], null);
    expect(readRelation(tasks, 'design', syncedPropertyId!)).toEqual([]);
    expect(readRelation(tasks, 'test', syncedPropertyId!)).toEqual(['alpha', 'beta']);
  });

  it('one-way relations only change their own side', () => {
    const { projects, tasks, resolve } = setup();
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
    });
    expect(syncedPropertyId).toBeNull();
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design'], null);
    expect(readRelation(projects, 'alpha', propertyId)).toEqual(['design']);
    expect(readDatabase(tasks).properties.map((p) => p.type)).not.toContain('relation');
  });

  it('a one-page limit on the other side moves the page away from its old link', () => {
    const { projects, tasks, resolve } = setup();
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
      twoWay: { name: 'Project' },
    });
    updateRelation(resolve, 'tasks', syncedPropertyId!, { limitOne: true });
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design'], null);
    setRelation(resolve, 'projects', 'beta', propertyId, ['design'], null);
    expect(readRelation(tasks, 'design', syncedPropertyId!)).toEqual(['beta']);
    expect(readRelation(projects, 'alpha', propertyId)).toEqual([]);

    // This side's limit keeps the last page picked.
    setRelation(resolve, 'tasks', 'build', syncedPropertyId!, ['alpha', 'beta'], null);
    expect(readRelation(tasks, 'build', syncedPropertyId!)).toEqual(['beta']);
    expect(readRelation(projects, 'beta', propertyId)).toEqual(['design', 'build']);
  });

  it('turning two-way on links existing values back; off keeps the other side', () => {
    const { projects, tasks, resolve } = setup();
    const { propertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
    });
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design', 'build'], null);
    updateRelation(resolve, 'projects', propertyId, { twoWay: { name: 'Project' } });
    const synced = readDatabase(projects).properties.find((p) => p.id === propertyId)!.config
      .syncedPropertyId!;
    expect(readRelation(tasks, 'build', synced)).toEqual(['alpha']);

    updateRelation(resolve, 'projects', propertyId, { twoWay: null });
    const other = readDatabase(tasks).properties.find((p) => p.id === synced)!;
    expect(other.config.syncedPropertyId).toBeNull();
    setRelation(resolve, 'projects', 'beta', propertyId, ['test'], null);
    expect(readRelation(tasks, 'test', synced)).toEqual([]);

    deleteRelation(resolve, 'tasks', synced);
    expect(readDatabase(tasks).properties.some((p) => p.id === synced)).toBe(false);
  });

  it('concurrent edits on two replicas merge as a set', () => {
    const { projects, resolve } = setup();
    const { propertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
    });
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design'], null);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(projects));
    const other: DocResolver = (id) => (id === 'projects' ? replica : resolve(id));

    setRelation(resolve, 'projects', 'alpha', propertyId, ['design', 'build'], null);
    setRelation(other, 'projects', 'alpha', propertyId, ['test'], null);
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(projects));
    Y.applyUpdate(projects, Y.encodeStateAsUpdate(replica));
    // One side added Build, the other removed Design and added Test.
    expect(readRelation(projects, 'alpha', propertyId).sort()).toEqual(['build', 'test']);
    expect(readRelation(replica, 'alpha', propertyId).sort()).toEqual(['build', 'test']);
  });

  it('duplicated rows and properties, and copied databases', () => {
    const { projects, tasks, resolve } = setup();
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
      twoWay: { name: 'Project' },
    });
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design'], null);
    const copy = duplicateRow(projects, 'alpha', null);
    syncTwoWayLinks(resolve, 'projects', copy);
    expect(readRelation(projects, copy, propertyId)).toEqual(['design']);
    expect(readRelation(tasks, 'design', syncedPropertyId!)).toEqual(['alpha', copy]);

    const dup = duplicateProperty(projects, propertyId);
    const dupProperty = readDatabase(projects).properties.find((p) => p.id === dup)!;
    expect(dupProperty.config.syncedPropertyId).toBeNull();
    expect(readRelation(projects, 'alpha', dup)).toEqual(['design']);

    // Copying a database: self-relations follow the new rows, others become one-way.
    enableSubItems(projects, 'projects');
    const { parentId } = readMeta(projects).subItems!;
    setRelation(resolve, 'projects', 'beta', parentId, ['alpha'], null);
    const to = new Y.Doc();
    const mapping = copyDatabase(projects, to, { fromViewSet: 'projects', toViewSet: 'copy' });
    const parent = readDatabase(to).properties.find((p) => p.id === parentId)!;
    expect(parent.config.databaseId).toBe('copy');
    expect(readRelation(to, mapping.get('beta')!, parentId)).toEqual([mapping.get('alpha')]);
    const tasksRel = readDatabase(to).properties.find((p) => p.id === propertyId)!;
    expect(tasksRel.config).toMatchObject({ databaseId: 'tasks', syncedPropertyId: null });
  });

  it('sub-items and dependencies are self-relation pairs', () => {
    const { projects, resolve } = setup();
    enableSubItems(projects, 'projects');
    const { parentId, childrenId } = readMeta(projects).subItems!;
    const names = readDatabase(projects).properties.map((p) => p.name);
    expect(names).toContain('Parent item');
    expect(names).toContain('Sub-items');

    setRelation(resolve, 'projects', 'alpha', childrenId, ['beta'], null);
    expect(readRelation(projects, 'beta', parentId)).toEqual(['alpha']);
    // A sub-item has one parent: re-parenting moves it.
    addRow(projects, { actor: null, id: 'gamma', title: 'Gamma' });
    setRelation(resolve, 'projects', 'gamma', childrenId, ['beta'], null);
    expect(readRelation(projects, 'beta', parentId)).toEqual(['gamma']);
    expect(readRelation(projects, 'alpha', childrenId)).toEqual([]);

    enableDependencies(projects, 'projects');
    const { blockedById, blockingId } = readMeta(projects).dependencies!;
    setRelation(resolve, 'projects', 'beta', blockedById, ['alpha', 'gamma'], null);
    expect(readRelation(projects, 'alpha', blockingId)).toEqual(['beta']);
    expect(readRelation(projects, 'gamma', blockingId)).toEqual(['beta']);
  });
});

describe('rollups', () => {
  const tasks = [
    row('a', { pts: 3, due: { start: '2026-10-01' }, done: true, tag: 'x' }),
    row('b', { pts: 5, due: { start: '2026-10-09', end: '2026-10-12' }, tag: 'x' }),
    row('c', { done: false, tag: 'y' }),
    row('d', {}),
  ];
  const pts = prop('pts', 'number');
  const due = prop('due', 'date');
  const done = prop('done', 'checkbox');
  const tag = prop('tag', 'text');
  const title = prop(TITLE_PROPERTY_ID, 'title');
  const roll = (property: typeof pts, calc: RollupCalculation) =>
    computeRollup(tasks, property, calc, ctx);

  it.each<[typeof pts, RollupCalculation, unknown]>([
    [title, 'showOriginal', 'a, b, c, d'],
    [tag, 'showUnique', 'x, y'],
    [tag, 'countAll', 4],
    [tag, 'countValues', 3],
    [tag, 'countUnique', 2],
    [tag, 'countEmpty', 1],
    [tag, 'countNotEmpty', 3],
    [tag, 'percentEmpty', 25],
    [tag, 'percentNotEmpty', 75],
    [pts, 'sum', 8],
    [pts, 'average', 4],
    [pts, 'median', 4],
    [pts, 'min', 3],
    [pts, 'max', 5],
    [pts, 'range', 2],
    [due, 'earliest', { start: '2026-10-01' }],
    [due, 'latest', { start: '2026-10-12' }],
    [due, 'dateRange', { start: '2026-10-01', end: '2026-10-12' }],
    [done, 'checked', 1],
    [done, 'unchecked', 3],
    [done, 'percentChecked', 25],
    [done, 'percentUnchecked', 75],
  ])('%s %s', (property, calc, expected) => {
    expect(roll(property, calc)).toEqual(expected);
  });

  it('empty relations: sums are 0, other results empty', () => {
    expect(computeRollup([], pts, 'sum', ctx)).toBe(0);
    expect(computeRollup([], pts, 'average', ctx)).toBeNull();
    expect(computeRollup([], tag, 'showOriginal', ctx)).toBeNull();
    expect(computeRollup([], tag, 'percentEmpty', ctx)).toBe(0);
  });

  it('calculations offered depend on the target type', () => {
    const ids = (p: typeof pts) => rollupCalculationsFor(p).map((c) => c.id);
    expect(ids(pts)).toContain('median');
    expect(ids(due)).toContain('dateRange');
    expect(ids(done)).toContain('percentChecked');
    expect(ids(tag)).not.toContain('sum');
  });
});

describe('computed snapshots', () => {
  function computed() {
    const { docs, projects, tasks, resolve } = setup();
    const { propertyId, syncedPropertyId } = createRelation(resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
      twoWay: { name: 'Project' },
    });
    const pts = addProperty(tasks, { name: 'Points', type: 'number' });
    setCell(tasks, 'design', pts, 3, null);
    setCell(tasks, 'build', pts, 5, null);
    const total = addProperty(projects, {
      name: 'Total',
      type: 'rollup',
      config: {
        relationId: propertyId,
        targetPropertyId: pts,
        calculation: 'sum',
        numberFormat: undefined,
      },
    });
    const formula = addProperty(projects, {
      name: 'Names',
      type: 'formula',
      config: {
        expression: 'prop("Tasks").map(format(current)).join("/") + " " + format(prop("Total"))',
      },
    });
    setRelation(resolve, 'projects', 'alpha', propertyId, ['design', 'build'], null);
    const handles = new Map([...docs].map(([id, doc]) => [id, new DatabaseHandle(id, doc)]));
    const caches = new Map<string, ComputedCache>();
    const visiting = new Set<string>();
    const snap = (id: string, compute = true): DatabaseSnapshot => {
      const raw = handles.get(id)!.snapshot();
      if (!compute || visiting.has(id)) return raw;
      let cache = caches.get(id);
      if (!cache) caches.set(id, (cache = new ComputedCache()));
      visiting.add(id);
      try {
        return cache.apply(raw, ctx, snap, id);
      } finally {
        visiting.delete(id);
      }
    };
    return { projects, tasks, resolve, propertyId, syncedPropertyId, pts, total, formula, snap };
  }

  it('normalizes relations, computes rollups and feeds formulas', () => {
    const { tasks, propertyId, total, formula, snap, pts } = computed();
    let s = snap('projects');
    const alpha = () => s.rows.find((r) => r.id === 'alpha')!;
    expect(alpha().values[propertyId]).toEqual(['design', 'build']);
    expect(alpha().values[total]).toBe(8);
    expect(s.properties.find((p) => p.id === total)!.config.resultType).toBe('number');
    expect(alpha().values[formula]).toBe('Design/Build 8');
    expect(s.related?.get('design')).toMatchObject({ title: 'Design', databaseId: 'tasks' });

    // Trashed pages drop out of relations and rollups.
    trashRow(tasks, 'build');
    s = snap('projects');
    expect(alpha().values[propertyId]).toEqual(['design']);
    expect(alpha().values[total]).toBe(3);
    setCell(tasks, 'design', pts, 10, null);
    s = snap('projects');
    expect(alpha().values[total]).toBe(10);
  });

  it('reuses rows that did not change', () => {
    const { projects, snap } = computed();
    const first = snap('projects');
    const second = snap('projects');
    expect(second.rows[0]).toBe(first.rows[0]);
    expect(second.properties).toBe(first.properties);
    setCell(projects, 'beta', 'nothing', 'x', null);
    const third = snap('projects');
    expect(third.rows.find((r) => r.id === 'alpha')).toBe(first.rows.find((r) => r.id === 'alpha'));
  });

  it('filters and groups relations by page titles', () => {
    const { propertyId, snap } = computed();
    const s = snap('projects');
    const property = s.properties.find((p) => p.id === propertyId)!;
    const pctx = { ...ctx, pages: s.related };
    const byId = new Map(s.properties.map((p) => [p.id, p]));
    const match = (operator: string, value?: unknown) =>
      s.rows
        .filter((r) =>
          matchesFilter(r, { type: 'rule', id: 'f', propertyId, operator, value }, byId, pctx),
        )
        .map((r) => r.id);
    expect(match('contains', 'desi')).toEqual(['alpha']);
    expect(match('doesNotContain', 'build')).toEqual(['beta']);
    expect(match('isEmpty')).toEqual(['beta']);
    const groups = groupRows(s.rows, property, { propertyId }, pctx);
    expect(groups.map((g) => [g.info.label, g.rows.map((r) => r.id)])).toEqual([
      ['No Tasks', ['beta']],
      ['Build', ['alpha']],
      ['Design', ['alpha']],
    ]);
  });
});
