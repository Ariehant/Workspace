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
  // Measured in whole frames (16.7 ms at 60 Hz, under xvfb too): one frame more is +40% of a
  // 40 ms result, so a regression must be more than a frame (keystrokes: 40-74 ms on unchanged
  // code across CI runs in November 2026).
  'page.keystroke.p95': { target: 16, limit: 300, minRegressionMs: 17 },
  'database.open': { target: 2000, limit: 12_000 },
  'database.filter': { target: 300, limit: 2000 },
  'database.sort': { target: 300, limit: 2000 },
  'database.group': { target: 300, limit: 2000 },
  // The single longest frame of a scroll: one frame (16.8 ms) on most runs, but 33 and 50 ms on
  // busy runners with unchanged code. A maximum of one sample isn't comparable run to run, so
  // it's held to its target and limit only.
  'scroll.frame.max': { target: 50, limit: 250, compare: false },
  quickFind: { target: 150, limit: 250 },
  // First sync over a real server, disk and two processes: on shared runners the same code
  // took 5.5 s to 10.7 s (CI runs of November 2026), a spread no CPU measurement explains, so
  // it's held to its limit only, not compared with the base branch.
  'sync.first': { target: 30_000, limit: 45_000, compare: false },
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
} as const satisfies Record<string, Budget>;

interface Budget {
  target: number;
  limit: number;
  /** False: too noisy between runs to compare with the base branch (the limit still holds). */
  compare?: false;
  /** A regression must be at least this much slower (ms), when that's more than the default. */
  minRegressionMs?: number;
}

export type Metric = keyof typeof BUDGETS;
export type Results = Partial<Record<Metric, number>>;

/** How much slower than the base branch's last run a metric may get before CI fails. */
export const REGRESSION_LIMIT = 0.2;

/**
 * Metrics this fast are left out of the regression check: a few milliseconds of noise
 * would be a 20% "regression".
 */
const NOISE_FLOOR_MS = 10;

/**
 * A regression must also be this much slower in absolute terms: on shared runners the same code
 * measured `pure.database.edit` between 13 and 35 ms, so 20% of a ~15 ms metric (3 ms) is
 * noise, not a change anyone would notice. Doubling a 10 ms metric still fails.
 */
const MIN_REGRESSION_MS = 10;

/**
 * Add results to a JSON file (several suites write to the same one). A metric already in it
 * keeps the faster of the two: CI runs the pure-code benchmarks more than once, and the fastest
 * run is the closest to the code's own cost (a busy runner only ever adds time).
 */
export function recordResults(file: string | undefined, results: Results): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const existing: Results = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged: Results = { ...existing };
  for (const [metric, value] of Object.entries(results) as [Metric, number][]) {
    const before = existing[metric];
    merged[metric] = before === undefined ? value : Math.min(before, value);
  }
  writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
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

/** The runner's speed is only read from this many pure-code measurements or more. */
const MIN_CALIBRATION_METRICS = 3;

/**
 * How much slower this run's machine is than the base branch's (2 = twice as slow), read from
 * the pure-code benchmarks: they run the same code on both, so their median ratio is the
 * runner's speed, not a change in the code (one slower benchmark among them doesn't move the
 * median). 1 without enough of them; kept between 0.5 and 4.
 *
 * Shared CI runners differ by 30–60% from run to run, which alone used to fail the 20%
 * regression check.
 */
export function runnerFactor(
  results: Record<string, number>,
  baseline: Record<string, number>,
): number {
  const ratios = Object.entries(results)
    .filter(([metric]) => metric.startsWith('pure.'))
    .map(([metric, value]) => [value, baseline[metric]] as const)
    .filter((pair): pair is readonly [number, number] => {
      const base = pair[1];
      return base !== undefined && base >= NOISE_FLOOR_MS && pair[0] > 0;
    })
    .map(([value, base]) => value / base)
    .sort((a, b) => a - b);
  if (ratios.length < MIN_CALIBRATION_METRICS) return 1;
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2;
  return Math.min(4, Math.max(0.5, median));
}

/**
 * Compare results with the budgets, and with a baseline run when there is one. The baseline is
 * first scaled by the runner's speed (`runnerFactor`), so a regression means slower code, not a
 * slower machine. The absolute limits aren't scaled: they hold on any runner.
 */
export function judge(
  results: Record<string, number>,
  baseline: Record<string, number> = {},
): Verdict[] {
  const factor = runnerFactor(results, baseline);
  return Object.entries(results).map(([metric, value]) => {
    const budget = (BUDGETS as Record<string, Budget | undefined>)[metric];
    const base = baseline[metric] ?? null;
    let problem: string | null = null;
    if (!budget) problem = 'no budget';
    else if (value > budget.limit) problem = `over the limit (${budget.limit} ms)`;
    else if (
      base !== null &&
      budget.compare !== false &&
      base >= NOISE_FLOOR_MS &&
      value > base * factor * (1 + REGRESSION_LIMIT) &&
      value - base * factor > Math.max(MIN_REGRESSION_MS, budget.minRegressionMs ?? 0)
    ) {
      problem = `${Math.round((value / (base * factor) - 1) * 100)}% slower than the base branch${
        factor === 1 ? '' : ` (allowing for this runner's speed, ×${factor.toFixed(2)})`
      }`;
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

/** A Markdown table of verdicts, for the CI summary (with the runner's speed, when known). */
export function report(verdicts: Verdict[], factor = 1): string {
  const lines = [
    ...(factor === 1
      ? []
      : [
          `This runner ran the pure-code benchmarks ×${factor.toFixed(2)} as long as the base branch's run; its results are compared with the base branch's scaled by that.`,
          '',
        ]),
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
