/**
 * The pure-code performance budgets, on the generated 50,000-row database and
 * 10,000-block page (docs/PHASE7.md, M1). Run with `pnpm --filter @workspace/perf bench`;
 * set PERF_RESULTS to a file to record the timings for CI.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { readBlocks } from '@workspace/core';
import {
  ComputedCache,
  DatabaseHandle,
  readDatabase,
  runView,
  setCell,
  type DatabaseSnapshot,
  type View,
} from '@workspace/database';
import { SqliteStore } from '@workspace/storage-local';
import { BUDGETS, median, recordResults, type Metric, type Results } from './budgets';
import { IDS, TASK_PROPS, buildBigPage, buildDatabases, writeWorkspace } from './fixtures';

const ROWS = Number(process.env.PERF_ROWS ?? 50_000);
const BLOCKS = Number(process.env.PERF_BLOCKS ?? 10_000);
const results: Results = {};

function measure(metric: Metric, value: number) {
  results[metric] = Math.round(value * 10) / 10;
  const { target, limit } = BUDGETS[metric];
  console.log(`${metric}: ${value.toFixed(1)} ms (target ${target} ms, limit ${limit} ms)`);
  expect.soft(value, metric).toBeLessThan(limit);
}

afterAll(() => recordResults(process.env.PERF_RESULTS, results));

describe(`a database with ${ROWS.toLocaleString('en-US')} rows`, () => {
  let tasksUpdate: Uint8Array;
  let projectsUpdate: Uint8Array;
  let tasks: Y.Doc;
  let handle: DatabaseHandle;
  let projects: DatabaseSnapshot;
  let computed: DatabaseSnapshot;
  let table: View;
  const ctx = { users: new Map([[IDS.user, 'Perf']]), me: IDS.user, now: Date.UTC(2026, 5, 1) };

  beforeAll(() => {
    const built = buildDatabases(ROWS);
    tasksUpdate = Y.encodeStateAsUpdate(built.tasks);
    projectsUpdate = Y.encodeStateAsUpdate(built.projects);
    built.tasks.destroy();
    built.projects.destroy();
    const projectsDoc = new Y.Doc();
    Y.applyUpdate(projectsDoc, projectsUpdate);
    projects = new DatabaseHandle(IDS.projects, projectsDoc).snapshot();
    console.log(`tasks doc: ${(tasksUpdate.byteLength / 1e6).toFixed(1)} MB`);
  }, 120_000);

  it('opens: decode, snapshot, computed values', { timeout: 60_000 }, () => {
    let start = performance.now();
    tasks = new Y.Doc();
    Y.applyUpdate(tasks, tasksUpdate);
    measure('pure.database.decode', performance.now() - start);

    handle = new DatabaseHandle(IDS.tasks, tasks);
    start = performance.now();
    const snapshot = handle.snapshot();
    measure('pure.database.snapshot', performance.now() - start);
    expect(snapshot.rows).toHaveLength(ROWS);

    const cache = new ComputedCache();
    const resolve = (id: string) => (id === IDS.projects ? projects : undefined);
    start = performance.now();
    computed = cache.apply(snapshot, ctx, resolve, IDS.tasks);
    measure('pure.database.computed', performance.now() - start);
    const first = computed.rows[0]!;
    expect(first.values[TASK_PROPS.double]).toBe((first.values[TASK_PROPS.estimate] as number) * 2);
    expect(typeof first.values[TASK_PROPS.budget]).toBe('number');
    table = readDatabase(tasks).views.find((v) => v.type === 'table')!;
  });

  it('filters, sorts and groups', { timeout: 60_000 }, () => {
    const done = {
      ...table,
      filter: {
        type: 'group' as const,
        id: 'f',
        conjunction: 'and' as const,
        filters: [
          {
            type: 'rule' as const,
            id: 'r',
            propertyId: TASK_PROPS.status,
            operator: 'is',
            value: ['s3'],
          },
        ],
      },
    };
    let count = 0;
    measure(
      'pure.database.filter',
      median(5, () => (count = runView(computed, done, ctx).rows.length)),
    );
    expect(count).toBeGreaterThan(ROWS / 8);
    expect(count).toBeLessThan(ROWS / 2);

    const sorted = {
      ...table,
      sorts: [{ propertyId: TASK_PROPS.budget, direction: 'desc' as const }],
    };
    measure(
      'pure.database.sort',
      median(5, () => runView(computed, sorted, ctx)),
    );

    const grouped = { ...table, groupBy: { propertyId: TASK_PROPS.status } };
    let groups = 0;
    measure(
      'pure.database.group',
      median(5, () => (groups = runView(computed, grouped, ctx).groups?.length ?? 0)),
    );
    expect(groups).toBeGreaterThanOrEqual(4);
  });

  it('applies an edit: snapshot, computed values and the view again', { timeout: 60_000 }, () => {
    const cache = new ComputedCache();
    const resolve = (id: string) => (id === IDS.projects ? projects : undefined);
    cache.apply(handle.snapshot(), ctx, resolve, IDS.tasks);
    let n = 0;
    measure(
      'pure.database.edit',
      median(9, () => {
        setCell(tasks, `task-${(n++ * 7919) % ROWS}`, TASK_PROPS.estimate, n, null);
        runView(cache.apply(handle.snapshot(), ctx, resolve, IDS.tasks), table, ctx);
      }),
    );
  });
});

describe(`a page with ${BLOCKS.toLocaleString('en-US')} blocks`, () => {
  it('decodes and reads its blocks', () => {
    const update = Y.encodeStateAsUpdate(buildBigPage(BLOCKS));
    const start = performance.now();
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const blocks = readBlocks(doc);
    measure('pure.page.decode', performance.now() - start);
    expect(blocks).toHaveLength(BLOCKS);
  });
});

describe('quick find', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perf-search-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it(`searches ${ROWS.toLocaleString('en-US')} rows and pages`, { timeout: 300_000 }, () => {
    const { buildMs, indexMs } = writeWorkspace(dir, { rows: ROWS, blocks: 100 });
    console.log(
      `workspace written: build ${buildMs.toFixed(0)} ms, index ${indexMs.toFixed(0)} ms`,
    );
    const store = new SqliteStore(join(dir, 'workspace.db'));
    try {
      const queries = ['torque', 'lidar odometry', 'Task 4999', 'servo gripper', 'calib'];
      let hits = 0;
      measure(
        'pure.search',
        Math.max(...queries.map((q) => median(5, () => (hits += store.search(q).length)))),
      );
      expect(hits).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});
