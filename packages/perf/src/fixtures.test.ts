import { mkdtempSync, rmSync } from 'node:fs';
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
import { judge, p95, report } from './budgets';

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

  it('takes the 95th percentile', () => {
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([])).toBe(0);
  });
});
