/**
 * The handoff's lightness targets (HANDOFF.md 1): under 150 MB of memory idle with a few
 * calendars, and a cold start to the week view in under 2 seconds. Measured on the built app
 * and printed; the test fails only well past them (CI machines vary, and draw with software).
 */
import { readFileSync } from 'node:fs';
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { closeApp, connect, expect, launchApp, test } from './helpers';

const TARGET_MB = 150;
const TARGET_START_MS = 2_000;

test('stays light: memory when idle, and a cold start to the week view', async ({
  launch,
  dataDir,
  seed,
  v1,
}) => {
  test.setTimeout(240_000);
  // Three calendars with 200 rows over the next weeks.
  const week = startOfWeek(today(), 1);
  for (const name of ['Team', 'Projects', 'Personal']) {
    const db = await v1.database(`Measure ${name}`);
    for (let i = 0; i < 67; i++) {
      const day = addDays(week, i % 28);
      const hour = String(8 + (i % 10)).padStart(2, '0');
      await v1.row(db, `${name} ${i}`, { start: `${day}T${hour}:00`, end: `${day}T${hour}:45` });
    }
  }
  const first = await launch();
  for (const name of ['Team', 'Projects', 'Personal']) {
    if (name !== 'Team') {
      await first.window.getByRole('button', { name: 'Connect another Workspace' }).click();
      const dialog = first.window.getByRole('dialog', { name: 'Connect Workspace' });
      await dialog.getByLabel('Server address').fill(seed.base);
      await dialog.getByLabel('Integration token').fill(seed.integration.token);
      await dialog.getByRole('button', { name: 'Connect' }).click();
      await dialog.getByRole('checkbox', { name: `Measure ${name}` }).check();
      await dialog.getByRole('button', { name: 'Next' }).click();
      await dialog.getByRole('button', { name: 'Add calendar' }).click();
      await expect(dialog).toBeHidden();
    } else {
      await connect(first, seed.base, seed.integration.token, 'Measure Team');
    }
  }
  await expect(
    first.window
      .getByRole('region', { name: 'Calendar' })
      .getByRole('button', { name: /^Personal 0,/ }),
  ).toBeVisible();
  await closeApp(first.app);

  // Cold start: from launching Electron to the week view showing the saved events.
  const started = Date.now();
  const again = await launchApp(dataDir, { CALENDAR_SYNC_INTERVAL_MS: '600000' });
  await expect(
    again.window
      .getByRole('region', { name: 'Calendar' })
      .getByRole('button', { name: /^Team 0,/ }),
  ).toBeVisible();
  const startMs = Date.now() - started;

  // Idle: every process of the app, after it settles. Memory is the proportional set size
  // (PSS: shared pages divided among the processes using them), so Chromium's libraries mapped
  // into every process count once, as they take memory once.
  await again.window.waitForTimeout(8_000);
  const pids = await again.app.evaluate(({ app }) => app.getAppMetrics().map((p) => p.pid));
  const pss = (pid: number) =>
    Number(/^Pss:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'))?.[1] ?? 0);
  const mb = Math.round(pids.reduce((sum, pid) => sum + pss(pid), 0) / 1024);
  await closeApp(again.app);

  const report = `cold start ${startMs} ms (target ${TARGET_START_MS}), idle memory ${mb} MB PSS in ${pids.length} processes (target ${TARGET_MB})`;
  console.log(report);
  test.info().annotations.push({ type: 'measurements', description: report });
  expect(startMs).toBeLessThan(TARGET_START_MS * 3);
  expect(mb).toBeLessThan(TARGET_MB * 2);
});
