/**
 * Compare a run's results with the budgets, and with the base branch's last run; print the
 * table, and add it to the GitHub job summary. Exits with 1 when a metric fails.
 *
 *   node --experimental-strip-types packages/perf/src/report.ts results.json [baseline.json]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { judge, report } from './budgets.ts';

const [resultsFile, baselineFile] = process.argv.slice(2);
if (!resultsFile) {
  console.error('Usage: report.ts results.json [baseline.json]');
  process.exit(2);
}
const read = (file: string | undefined) =>
  file && existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>)
    : {};

const verdicts = judge(read(resultsFile), read(baselineFile));
const table = report(verdicts);
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Performance budgets\n\n${table}\n`);
}
const failed = verdicts.filter((v) => v.problem);
if (failed.length) {
  console.error(`\n${failed.length} over: ${failed.map((v) => v.metric).join(', ')}`);
  process.exit(1);
}
