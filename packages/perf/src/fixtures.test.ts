import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { listPages, readBlocks } from '@workspace/core';
import { ComputedCache, DatabaseHandle } from '@workspace/database';
import { DocManager, SqliteStore } from '@workspace/storage-local';
import {
  IDS,
  TASK_PROPS,
  buildBigPage,
  buildDatabases,
  buildWorkspace,
  writeWorkspace,
} from './index';
import { judge, p95, recordResults, report, runnerFactor } from './budgets';

describe('fixtures', () => {
  it('builds the same database every time, with computed values', () => {
    const a = buildDatabases(50, 5);
    const b = buildDatabases(50, 5);
    const snapshot = new DatabaseHandle(IDS.tasks, a.tasks).snapshot();
    const other = new DatabaseHandle(IDS.tasks, b.tasks).snapshot();
    expect(snapshot.rows.map((r) => r.values)).toEqual(other.rows.map((r) => r.values));
    expect(snapshot.rows).toHaveLength(50);
    expect(snapshot.properties.map((p) => p.name)).toEqual([
      'Name',
      'Status',
      'Estimate',
      'Due',
      'Done',
      'Labels',
      'Notes',
      'Double',
      'Project',
      'Budget',
    ]);

    const projects = new DatabaseHandle(IDS.projects, a.projects).snapshot();
    const ctx = { users: new Map<string, string>() };
    const computed = new ComputedCache().apply(
      snapshot,
      ctx,
      (id) => (id === IDS.projects ? projects : undefined),
      IDS.tasks,
    );
    const row = computed.rows[7]!;
    const project = projects.rows.find(
      (p) => p.id === (row.values[TASK_PROPS.project] as string[])[0],
    )!;
    expect(row.values[TASK_PROPS.double]).toBe((row.values[TASK_PROPS.estimate] as number) * 2);
    expect(row.values[TASK_PROPS.budget]).toBe(project.values['p-budget']);
  });

  it('builds a long page of blocks with ids', () => {
    const blocks = readBlocks(buildBigPage(120));
    expect(blocks).toHaveLength(120);
    expect(blocks[0]).toMatchObject({ type: 'heading', props: { id: 'b0' } });
    expect(new Set(blocks.map((b) => b.type))).toEqual(
      new Set(['heading', 'paragraph', 'bulletList', 'taskList']),
    );
  });

  it('builds a workspace with the three pages', () => {
    const docs = buildWorkspace({ rows: 10, blocks: 10 });
    const pages = listPages(docs.get('workspace')!);
    expect(pages.map((p) => [p.id, p.kind])).toEqual(
      expect.arrayContaining([
        [IDS.bigPage, 'page'],
        [IDS.tasks, 'database'],
        [IDS.projects, 'database'],
      ]),
    );
  });

  it('writes a desktop workspace with its search index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-fixture-'));
    try {
      writeWorkspace(dir, { rows: 30, blocks: 20 });
      const store = new SqliteStore(join(dir, 'workspace.db'));
      try {
        expect(store.rowIdsOf(IDS.tasks)).toHaveLength(30);
        expect(store.search('Task 17').map((r) => r.id)).toContain('task-16');
        const manager = new DocManager(store);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, manager.open(IDS.bigPage));
        expect(readBlocks(doc)).toHaveLength(20);
        manager.close();
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('budgets', () => {
  it('fails results over the limit and regressions from the base branch', () => {
    const verdicts = judge(
      {
        'database.filter': 2100,
        'database.sort': 400,
        'database.group': 100,
        'page.keystroke.p95': 5,
        'page.open': 900,
      },
      { 'database.sort': 300, 'database.group': 95, 'page.keystroke.p95': 3 },
    );
    expect(verdicts.map((v) => [v.metric, v.problem, v.overTarget])).toEqual([
      ['database.filter', 'over the limit (2000 ms)', true],
      ['database.sort', '33% slower than the base branch', true],
      ['database.group', null, false],
      // Under the noise floor: not compared with the base branch.
      ['page.keystroke.p95', null, false],
      ['page.open', null, false],
    ]);
    expect(report(verdicts)).toContain(
      '| database.group | 100 ms | 300 ms | 2000 ms | 95 ms | ✅ |',
    );
  });

  it('allows for a slower runner, read from the pure-code benchmarks', () => {
    const base = {
      'pure.database.filter': 100,
      'pure.database.sort': 100,
      'pure.database.group': 100,
      'pure.search': 20,
      'database.open': 4000,
      'database.sort': 200,
    };
    // A runner half as fast: everything takes about twice as long.
    const slow = {
      'pure.database.filter': 200,
      'pure.database.sort': 200,
      'pure.database.group': 200,
      'pure.search': 40,
      'database.open': 8100,
      'database.sort': 410,
    };
    expect(runnerFactor(slow, base)).toBe(2);
    expect(judge(slow, base).filter((v) => v.problem)).toEqual([]);

    // On that runner, a real regression still fails: one pure benchmark, and one UI case.
    const regressed = { ...slow, 'pure.database.group': 300, 'database.sort': 600 };
    expect(runnerFactor(regressed, base)).toBe(2);
    expect(
      judge(regressed, base)
        .filter((v) => v.problem)
        .map((v) => [v.metric, v.problem]),
    ).toEqual([
      ['pure.database.group', expect.stringMatching(/^50% slower .*×2\.00/)],
      ['database.sort', expect.stringMatching(/^50% slower/)],
    ]);
    expect(report(judge(slow, base), runnerFactor(slow, base))).toContain('×2.00');
  });

  it('passes the CI run that failed on runner speed alone (PR #4, November 2026)', () => {
    // The same code as its base branch, on a slower runner: 10 metrics failed before.
    const base = {
      'pure.database.decode': 1120,
      'pure.database.snapshot': 183,
      'pure.database.computed': 188,
      'pure.database.filter': 17,
      'pure.database.sort': 50.6,
      'pure.database.group': 12.9,
      'pure.database.edit': 16.4,
      'pure.page.decode': 61.1,
      'pure.search': 20.6,
      'page.keystroke.p95': 42.6,
      'database.group': 80.9,
      'sync.first': 5469,
    };
    const run = {
      'pure.database.decode': 1275,
      'pure.database.snapshot': 242,
      'pure.database.computed': 250,
      'pure.database.filter': 25.8,
      'pure.database.sort': 60.3,
      'pure.database.group': 19.9,
      'pure.database.edit': 25.8,
      'pure.page.decode': 92.4,
      'pure.search': 26.8,
      'page.keystroke.p95': 65.4,
      'database.group': 105,
      'sync.first': 9216,
    };
    expect(runnerFactor(run, base)).toBeCloseTo(1.33, 2);
    expect(judge(run, base).filter((v) => v.problem)).toEqual([]);
    // Still over its limit, sync.first fails.
    expect(judge({ 'sync.first': 46_000 }, base)[0]!.problem).toBe('over the limit (45000 ms)');
  });

  it('passes the runs that failed on small timings alone (PRs #9 and #10, November 2026)', () => {
    // pure.database.edit, same code as the base branch: 18.6 ms against 13.5 ms (×1.08 runner).
    const base = {
      'pure.database.decode': 1014,
      'pure.database.snapshot': 202,
      'pure.database.computed': 167,
      'pure.database.filter': 17,
      'pure.database.sort': 49.4,
      'pure.database.group': 12,
      'pure.database.edit': 13.5,
      'pure.search': 20.8,
    };
    const run = {
      'pure.database.decode': 1090,
      'pure.database.snapshot': 196,
      'pure.database.computed': 185,
      'pure.database.filter': 17.8,
      'pure.database.sort': 56.8,
      'pure.database.group': 13.3,
      'pure.database.edit': 18.6,
      'pure.search': 21.5,
    };
    expect(judge(run, base).filter((v) => v.problem)).toEqual([]);
    // Twice as slow is still a regression.
    expect(judge({ ...run, 'pure.database.edit': 32 }, base).map((v) => v.problem)).toContainEqual(
      expect.stringMatching(/^\d+% slower/),
    );
  });

  it('judges frame-timed metrics at their resolution: more than a frame (PR #10, Nov 2026)', () => {
    const base = { 'page.keystroke.p95': 40, 'scroll.frame.max': 16.8 };
    // 52.5 ms against 40 ms (×1.05 runner): less than a frame more.
    const pure = { 'pure.database.filter': 17, 'pure.database.sort': 49.4, 'pure.search': 20.8 };
    const run = {
      ...pure,
      'pure.database.filter': 17.85,
      'pure.database.sort': 51.9,
      'pure.search': 21.84,
      'page.keystroke.p95': 52.5,
      'scroll.frame.max': 16.8,
    };
    expect(judge(run, { ...base, ...pure }).filter((v) => v.problem)).toEqual([]);
    // Two frames more is a regression.
    expect(
      judge({ ...run, 'page.keystroke.p95': 78 }, { ...base, ...pure }).find(
        (v) => v.metric === 'page.keystroke.p95',
      )?.problem,
    ).toMatch(/slower than the base branch/);
  });

  it("doesn't calibrate without enough pure-code results, and keeps the factor in bounds", () => {
    expect(runnerFactor({ 'pure.search': 40 }, { 'pure.search': 20 })).toBe(1);
    const tenTimes = Object.fromEntries(
      ['filter', 'sort', 'group'].map((m) => [`pure.database.${m}`, 1000]),
    );
    const base = Object.fromEntries(
      ['filter', 'sort', 'group'].map((m) => [`pure.database.${m}`, 100]),
    );
    expect(runnerFactor(tenTimes, base)).toBe(4);
  });

  it('keeps the fastest of repeated runs in the results file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perf-results-'));
    try {
      const file = join(dir, 'results.json');
      recordResults(file, { 'pure.search': 30, 'pure.database.edit': 20 });
      recordResults(file, { 'pure.search': 25, 'pure.database.edit': 24, 'page.open': 12 });
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
        'pure.search': 25,
        'pure.database.edit': 20,
        'page.open': 12,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the 95th percentile', () => {
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([])).toBe(0);
  });
});
