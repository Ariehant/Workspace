/**
 * The UI performance budgets (docs/PHASE7.md, M1), on a generated workspace: a page with
 * 10,000 blocks and a database with 50,000 rows. Skipped unless asked for:
 *
 *   PERF=1 xvfb-run -a npx playwright test e2e/perf.spec.ts
 *
 * Times are taken in the renderer, from the event that starts an action (a click, a key,
 * an input) to the animation frame in which its result is on screen. PERF_RESULTS names a
 * JSON file to record them in; PERF_ROWS and PERF_BLOCKS change the sizes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { BUDGETS, p95, recordResults, writeWorkspace, type Metric } from '@workspace/perf';
import { editor, expect, launchApp, test } from './helpers';
import { startSyncServer } from './server';

const ROWS = Number(process.env.PERF_ROWS ?? 50_000);
const BLOCKS = Number(process.env.PERF_BLOCKS ?? 10_000);

test.skip(!process.env.PERF, 'Set PERF=1 to run the performance budgets');
test.describe.configure({ timeout: 600_000 });
// Actions wait at most this long (they don't time out by default), so a slow step fails
// with its own name rather than as the whole test's timeout.
test.use({ actionTimeout: 30_000 });

const results: Partial<Record<Metric, number>> = {};
test.afterAll(() => recordResults(process.env.PERF_RESULTS, results));

function measured(metric: Metric, value: number) {
  results[metric] = Math.round(value * 10) / 10;
  const { target, limit } = BUDGETS[metric];
  console.log(`${metric}: ${value.toFixed(1)} ms (target ${target} ms, limit ${limit} ms)`);
  expect.soft(value, metric).toBeLessThan(limit);
}

type PerfWindow = typeof globalThis & { __perfStart?: number | null; __perfEnd?: number | null };

/**
 * Time from the first `event` (capture phase, anywhere) after this call to the frame in
 * which `done` holds. `done` runs in the renderer on every animation frame.
 */
async function time(
  window: Page,
  event: string,
  act: () => Promise<void>,
  done: (arg: string | null) => boolean,
  arg: string | null,
): Promise<number> {
  await window.evaluate((event) => {
    const w = globalThis as PerfWindow;
    w.__perfStart = null;
    w.__perfEnd = null;
    const listener = (e: Event) => {
      w.__perfStart ??= e.timeStamp;
    };
    document.addEventListener(event, listener, { capture: true, once: true });
  }, event);
  await act();
  await window.waitForFunction(done, arg, { polling: 'raf', timeout: 120_000 });
  await window.evaluate(() => ((globalThis as PerfWindow).__perfEnd = performance.now()));
  return window.evaluate(() => {
    const w = globalThis as PerfWindow;
    return w.__perfEnd! - w.__perfStart!;
  });
}

/** The longest frame while `act` runs (rAF to rAF). */
async function longestFrame(window: Page, act: () => Promise<void>): Promise<number> {
  await window.evaluate(() => {
    const w = globalThis as typeof globalThis & { __frames?: number[]; __framing?: boolean };
    w.__frames = [];
    w.__framing = true;
    let last = performance.now();
    const tick = (now: number) => {
      w.__frames!.push(now - last);
      last = now;
      if (w.__framing) requestAnimationFrame(tick);
    };
    requestAnimationFrame((now) => {
      last = now;
      requestAnimationFrame(tick);
    });
  });
  await act();
  return window.evaluate(() => {
    const w = globalThis as typeof globalThis & { __frames?: number[]; __framing?: boolean };
    w.__framing = false;
    return Math.max(...w.__frames!);
  });
}

/**
 * Wait until the main process is idle (its index and history work from the last step is
 * done), so each case is timed on its own.
 */
async function quiet(app: ElectronApplication) {
  let fast = 0;
  const until = Date.now() + 60_000;
  while (fast < 3 && Date.now() < until) {
    const start = Date.now();
    await app.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    fast = Date.now() - start < 150 ? fast + 1 : 0;
  }
}

/** Wait until the window's frames are short again (the last change has rendered). */
async function calm(window: Page) {
  await window.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = performance.now();
        let quietFrames = 0;
        const until = last + 10_000;
        const tick = (now: number) => {
          quietFrames = now - last < 25 ? quietFrames + 1 : 0;
          last = now;
          if (quietFrames >= 10 || now > until) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/** One notch of a mouse wheel; a step every frame is fast, continuous scrolling. */
const WHEEL = 120;

async function scroll(window: Page, steps: number, dy: number) {
  for (let i = 0; i < steps; i++) {
    await window.mouse.wheel(0, dy);
    await window.waitForTimeout(16);
  }
}

const db = (window: Page) => window.getByTestId('database-view');
const toolbar = (window: Page, name: string) =>
  db(window).getByRole('button', { name, exact: true });
const firstTitle = () =>
  document.querySelector('[data-testid=table-row] [data-testid=row-title]')?.textContent ?? '';

test(`a ${BLOCKS.toLocaleString('en-US')}-block page and a ${ROWS.toLocaleString('en-US')}-row database`, async ({
  dataDir,
  launch,
}) => {
  const written = writeWorkspace(dataDir, { rows: ROWS, blocks: BLOCKS });
  console.log(
    `workspace: built in ${written.buildMs.toFixed(0)} ms, indexed in ${written.indexMs.toFixed(0)} ms`,
  );
  const { app, window } = await launch();
  await window.setViewportSize({ width: 1400, height: 900 });
  const tree = window.getByRole('treeitem');

  // --- The long page --------------------------------------------------------------
  measured(
    'page.open',
    await time(
      window,
      'click',
      () => tree.filter({ hasText: 'Long page' }).click(),
      () =>
        !!document.querySelector('[data-testid=page-editor]')?.textContent?.includes('Section 1:'),
      null,
    ),
  );
  await expect(editor(window)).toContainText(`Section ${BLOCKS / 50}:`);

  // Keystrokes: from the key event to the frame after it (Chromium paints right after).
  await editor(window).locator('p').nth(2).click();
  await window.keyboard.press('End');
  await window.evaluate(() => {
    const w = globalThis as typeof globalThis & { __keys?: number[] };
    w.__keys = [];
    document.addEventListener(
      'keydown',
      (e) => {
        const start = e.timeStamp;
        requestAnimationFrame(() => setTimeout(() => w.__keys!.push(performance.now() - start)));
      },
      { capture: true },
    );
  });
  await window.keyboard.type(' the quick brown fox jumps over the lazy robot arm', { delay: 40 });
  await window.waitForTimeout(200);
  const keys = await window.evaluate(
    () => (globalThis as typeof globalThis & { __keys?: number[] }).__keys!,
  );
  measured('page.keystroke.p95', p95(keys));

  measured('scroll.frame.max', await longestFrame(window, () => scroll(window, 60, WHEEL)));

  // --- The database -----------------------------------------------------------------
  await quiet(app);
  measured(
    'database.open',
    await time(
      window,
      'click',
      () => tree.filter({ hasText: 'Tasks (' }).click(),
      () => !!document.querySelector('[data-testid=table-row]'),
      null,
    ),
  );

  await quiet(app);
  const before = await window.evaluate(firstTitle);
  await toolbar(window, 'Sort').click();
  measured(
    'database.sort',
    await time(
      window,
      'click',
      () =>
        window
          .getByTestId('property-picker')
          .getByRole('button', { name: 'Estimate', exact: true })
          .click(),
      (before: string | null) =>
        (document.querySelector('[data-testid=table-row] [data-testid=row-title]')?.textContent ??
          before) !== before,
      before,
    ),
  );
  await window.getByTestId('sort-editor').getByRole('button', { name: 'Delete sort' }).click();
  await window.keyboard.press('Escape');

  await quiet(app);
  await toolbar(window, 'Filter').click();
  await window
    .getByTestId('property-picker')
    .getByRole('button', { name: 'Name', exact: true })
    .click();
  measured(
    'database.filter',
    await time(
      window,
      'input',
      () => window.getByTestId('filter-popover').getByLabel('Filter value').fill('Task 4242:'),
      () => document.querySelectorAll('[data-testid=table-row]').length === 1,
      null,
    ),
  );
  await window.getByTestId('filter-popover').getByRole('button', { name: 'Delete filter' }).click();
  await window.keyboard.press('Escape');

  await quiet(app);
  await toolbar(window, 'Group').click();
  measured(
    'database.group',
    await time(
      window,
      'change',
      async () => {
        await window
          .getByTestId('group-editor')
          .getByLabel('Group by')
          .selectOption({ label: 'Status' });
      },
      // Only the groups in view are rendered: the first one shows.
      () => document.querySelectorAll('[data-testid=group-header]').length >= 1,
      null,
    ),
  );
  await window
    .getByTestId('group-editor')
    .getByLabel('Group by', { exact: true })
    .selectOption({ label: 'None' });
  await window.keyboard.press('Escape');

  // Scrolling each view.
  await quiet(app);
  await calm(window);
  await window.mouse.move(700, 500);
  let worst = await longestFrame(window, () => scroll(window, 60, WHEEL));
  console.log(`scroll Table: ${worst.toFixed(1)} ms`);
  for (const view of ['By status', 'List', 'Gallery']) {
    await db(window).getByRole('tab', { name: view }).click();
    // Scrolling, not the view's first render, is what's timed.
    await quiet(app);
    await calm(window);
    await window.mouse.move(700, 600);
    const frame = await longestFrame(window, () => scroll(window, 60, WHEEL));
    console.log(`scroll ${view}: ${frame.toFixed(1)} ms`);
    worst = Math.max(worst, frame);
  }
  console.log(`scroll (views): ${worst.toFixed(1)} ms`);
  measured('scroll.frame.max', Math.max(results['scroll.frame.max'] ?? 0, worst));

  // --- Quick find -------------------------------------------------------------------
  await quiet(app);
  await window.keyboard.press('Control+k');
  const search = window.getByTestId('quick-find').getByLabel('Search pages');
  await expect(search).toBeVisible();
  measured(
    'quickFind',
    await time(
      window,
      'input',
      () => search.fill('Task 4242'),
      () =>
        [...document.querySelectorAll('[data-testid=quick-find-result]')].some((r) =>
          r.textContent?.includes('Task 4242:'),
        ),
      null,
    ),
  );
});

test(`first sync of that workspace from a server`, async ({ dataDir }) => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-perf-sync-'));
  const server = await startSyncServer(root);
  const apps: Awaited<ReturnType<typeof launchApp>>['app'][] = [];
  const open = async (dir: string) => {
    const launched = await launchApp(dir);
    apps.push(launched.app);
    return launched;
  };
  try {
    writeWorkspace(dataDir, { rows: ROWS, blocks: BLOCKS });
    // Device A has the workspace: it makes the account and uploads it.
    const a = await open(dataDir);
    const indicator = (window: Page) => window.getByTestId('sync-indicator');
    await indicator(a.window).click();
    let dialog = a.window.getByTestId('sync-dialog');
    await dialog.getByTestId('sync-server').fill(server.base);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByTestId('sync-name').fill('Perf');
    await dialog.getByTestId('sync-email').fill('perf@lab.io');
    await dialog.getByTestId('sync-password').fill('correct horse battery');
    await dialog.getByTestId('sync-sign-in').click();
    await dialog.getByTestId('sync-workspace-name').fill('Large workspace');
    let start = Date.now();
    await dialog.getByTestId('sync-start').click();
    await expect(indicator(a.window)).toHaveText('Synced', { timeout: 300_000 });
    console.log(`upload: ${Date.now() - start} ms`);
    await a.app.close();

    // Device B, a fresh install, takes it: its first sync.
    const dirB = join(root, 'device-b');
    let b = await open(dirB);
    await indicator(b.window).click();
    dialog = b.window.getByTestId('sync-dialog');
    await dialog.getByTestId('sync-server').fill(server.base);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByTestId('sync-email').fill('perf@lab.io');
    await dialog.getByTestId('sync-password').fill('correct horse battery');
    await dialog.getByTestId('sync-sign-in').click();
    await dialog.getByTestId('sync-remote-Large workspace').click();
    await dialog.getByTestId('sync-replace').check();
    const closed = b.app.waitForEvent('close');
    await dialog.getByTestId('sync-start').click();
    await closed;
    start = Date.now();
    b = await open(dirB);
    await expect(indicator(b.window)).toHaveText('Synced', { timeout: 300_000 });
    measured('sync.first', Date.now() - start);
    await expect(b.window.getByRole('treeitem').filter({ hasText: 'Tasks (' })).toBeVisible();
    await b.app.close();
  } finally {
    await Promise.all(apps.map((app) => app.close().catch(() => {})));
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
