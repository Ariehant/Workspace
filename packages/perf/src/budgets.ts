import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The performance budgets (docs/PHASE7.md, "Performance"), in milliseconds. `target` is
 * the budget; `limit` is what CI holds every run to: above today's results by the spread
 * seen between runs (more where the target isn't met yet), so a real regression fails
 * while the gap to the target stays visible in the report. Pure-code measurements are the
 * parts of a UI case that need no window, so their targets leave room for rendering.
 */
export const BUDGETS = {
  // UI cases (apps/desktop/e2e/perf.spec.ts).
  'page.open': { target: 1500, limit: 1500 },
  'page.keystroke.p95': { target: 16, limit: 300 },
  'database.open': { target: 2000, limit: 12_000 },
  'database.filter': { target: 300, limit: 2000 },
  'database.sort': { target: 300, limit: 2000 },
  'database.group': { target: 300, limit: 2000 },
  'scroll.frame.max': { target: 50, limit: 250 },
  quickFind: { target: 150, limit: 250 },
  'sync.first': { target: 30_000, limit: 45_000 },
  // Pure code (src/budgets.bench.test.ts), on the 50,000-row database.
  'pure.database.decode': { target: 1000, limit: 5000 },
  'pure.database.snapshot': { target: 500, limit: 1200 },
  'pure.database.computed': { target: 500, limit: 1200 },
  'pure.database.filter': { target: 150, limit: 300 },
  'pure.database.sort': { target: 150, limit: 400 },
  'pure.database.group': { target: 150, limit: 300 },
  'pure.database.edit': { target: 50, limit: 150 },
  'pure.page.decode': { target: 500, limit: 500 },
  'pure.search': { target: 50, limit: 150 },
} as const satisfies Record<string, { target: number; limit: number }>;

export type Metric = keyof typeof BUDGETS;
export type Results = Partial<Record<Metric, number>>;

/** How much slower than the base branch's last run a metric may get before CI fails. */
export const REGRESSION_LIMIT = 0.2;

/**
 * Metrics this fast are left out of the regression check: a few milliseconds of noise
 * would be a 20% "regression".
 */
const NOISE_FLOOR_MS = 10;

/** Add results to a JSON file (several suites write to the same one). */
export function recordResults(file: string | undefined, results: Results): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const existing: Results = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  writeFileSync(file, `${JSON.stringify({ ...existing, ...results }, null, 2)}\n`);
}

export interface Verdict {
  metric: string;
  value: number;
  target: number | null;
  limit: number | null;
  baseline: number | null;
  /** Fails the run: over the limit, or a regression from the base branch. */
  problem: string | null;
  /** Within the limit, but not yet the target. */
  overTarget: boolean;
}

/** Compare results with the budgets, and with a baseline run when there is one. */
export function judge(
  results: Record<string, number>,
  baseline: Record<string, number> = {},
): Verdict[] {
  return Object.entries(results).map(([metric, value]) => {
    const budget = (BUDGETS as Record<string, { target: number; limit: number } | undefined>)[
      metric
    ];
    const base = baseline[metric] ?? null;
    let problem: string | null = null;
    if (!budget) problem = 'no budget';
    else if (value > budget.limit) problem = `over the limit (${budget.limit} ms)`;
    else if (base !== null && base >= NOISE_FLOOR_MS && value > base * (1 + REGRESSION_LIMIT)) {
      problem = `${Math.round((value / base - 1) * 100)}% slower than the base branch`;
    }
    return {
      metric,
      value,
      target: budget?.target ?? null,
      limit: budget?.limit ?? null,
      baseline: base,
      problem,
      overTarget: budget !== undefined && value > budget.target,
    };
  });
}

const ms = (n: number | null) =>
  n === null ? '–' : `${Number.isInteger(n) ? n : n.toFixed(n < 100 ? 1 : 0)} ms`;

/** A Markdown table of verdicts, for the CI summary. */
export function report(verdicts: Verdict[]): string {
  const lines = [
    '| Metric | Result | Target | Limit | Base branch | |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
    ...verdicts.map(
      (v) =>
        `| ${v.metric} | ${ms(v.value)} | ${ms(v.target)} | ${ms(v.limit)} | ${ms(v.baseline)} | ${
          v.problem ? `❌ ${v.problem}` : v.overTarget ? '⚠️ over target' : '✅'
        } |`,
    ),
  ];
  return lines.join('\n');
}

/** The 95th percentile of a list of timings. */
export function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}

/** The median of `runs` timings of `fn`. */
export function median(runs: number, fn: () => void): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}
