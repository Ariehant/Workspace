import type { Locator, Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, popover, table } from './db';
import { expect, quit, test } from './helpers';

const db = (window: Page) => window.getByTestId('database-view');

// Dates in the current month, so the calendar shows them without navigating.
const now = new Date();
const y = now.getFullYear();
const m = now.getMonth();
const iso = (day: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const shown = (day: number) =>
  new Date(y, m, day).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

async function addView(window: Page, type: string) {
  await db(window).getByRole('button', { name: 'Add a view' }).click();
  await window.getByTestId('add-view-menu').getByRole('menuitem', { name: type }).click();
}

async function setDate(window: Page, title: string, column: string, start: string) {
  await (await cell(window, title, column)).click();
  await popover(window).getByLabel('Start date').fill(start);
  await window.keyboard.press('Escape');
  await expect(popover(window)).toHaveCount(0);
}

/** Native drag in small steps, like a hand (HTML5 drag needs intermediate moves). */
async function dragTo(window: Page, from: Locator, to: Locator, offset = { x: 10, y: 8 }) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await window.mouse.move(a.x + offset.x, a.y + offset.y);
  await window.mouse.down();
  await window.mouse.move(a.x + offset.x + 6, a.y + offset.y + 4, { steps: 3 });
  await window.mouse.move(b.x + b.width / 2, b.y + b.height - 10, { steps: 8 });
  await window.mouse.up();
}

/** Plan: Design on the 10th, Build on the 12th, Test without a date. */
async function seed(window: Page) {
  await newDatabase(window, 'Plan');
  await addProperty(window, 'Date', 'When');
  for (const title of ['Design', 'Build', 'Test']) await addRow(window, title);
  await setDate(window, 'Design', 'When', iso(10));
  await setDate(window, 'Build', 'When', iso(12));
}

test('calendar: rows on their days; drag to reschedule and resize, place undated rows, add on a day', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seed(window);
  await addView(window, 'Calendar');
  const calendar = window.getByTestId('calendar-view');
  const day = (n: number) => calendar.locator(`[data-day="${iso(n)}"]`);
  const event = (title: string) =>
    calendar.getByTestId('calendar-event').filter({ hasText: title });
  await expect(calendar.getByTestId('calendar-title')).toHaveText(
    now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  );
  await expect(event('Design')).toBeVisible();
  await expect(event('Build')).toBeVisible();

  // Drag Design from the 10th to the 17th.
  await dragTo(window, event('Design'), day(17));
  const at = async (title: string) => {
    const box = (await event(title).boundingBox())!;
    const days = await calendar.getByTestId('calendar-day').all();
    for (const d of days) {
      const b = (await d.boundingBox())!;
      if (box.x + 8 >= b.x && box.x + 8 < b.x + b.width && box.y >= b.y && box.y < b.y + b.height) {
        return d.getAttribute('data-day');
      }
    }
    return null;
  };
  await expect.poll(() => at('Design')).toBe(iso(17));

  // Stretch Build to the 14th by its right edge.
  await event('Build').hover();
  await dragTo(window, event('Build').getByRole('separator'), day(14), { x: 2, y: 8 });
  await expect
    .poll(async () => (await event('Build').boundingBox())!.width)
    .toBeGreaterThan((await day(12).boundingBox())!.width * 2);

  // Undated rows wait in the "No date" panel; drag one onto a day.
  await calendar.getByRole('button', { name: 'No date (1)' }).click();
  await dragTo(window, calendar.getByTestId('no-date-row').filter({ hasText: 'Test' }), day(20));
  await expect.poll(() => at('Test')).toBe(iso(20));
  await expect(calendar.getByTestId('no-date-panel')).toHaveCount(0);

  // "+" on a day adds a row on it (and opens it).
  await day(25).hover();
  await calendar.getByRole('button', { name: `New on ${iso(25)}` }).click();
  await window.getByTestId('row-peek').getByLabel('Page title').fill('Ship');
  await window.getByTestId('row-peek').getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => at('Ship')).toBe(iso(25));

  // Week layout and a Monday start.
  await calendar.getByRole('button', { name: 'week', exact: true }).click();
  await expect(calendar.getByTestId('calendar-week')).toHaveCount(1);
  await calendar.getByRole('button', { name: 'month', exact: true }).click();
  await db(window).getByRole('tab', { name: 'Calendar' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Start week on Monday/ })
    .click();
  await window.keyboard.press('Escape');
  await expect(calendar.locator('.grid-cols-7').first()).toHaveText(/^Mon/);

  // The table agrees, and it's all kept.
  await db(window).getByRole('tab', { name: 'Table' }).click();
  await expect(await cell(window, 'Design', 'When')).toHaveText(shown(17));
  await expect(await cell(window, 'Build', 'When')).toHaveText(`${shown(12)} → ${shown(14)}`);
  await expect(await cell(window, 'Test', 'When')).toHaveText(shown(20));
  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Plan' }).click();
  await db(window).getByRole('tab', { name: 'Calendar' }).click();
  await expect(window.getByTestId('calendar-event')).toHaveCount(4);
});

test('timeline: drag bars and edges, draw a dependency', async ({ launch }) => {
  const { window } = await launch();
  await seed(window);
  await addView(window, 'Timeline');
  const timeline = window.getByTestId('timeline-view');
  await timeline.getByLabel('Zoom').selectOption('day'); // 160px per day
  const bar = (title: string) => timeline.getByTestId('timeline-bar').filter({ hasText: title });
  await expect(timeline.getByTestId('timeline-bar')).toHaveCount(2);
  await expect(timeline.getByTestId('timeline-row')).toHaveText([/Design/, /Build/, /Test/]);

  // Move Design two days later.
  await timeline.getByLabel('Jump to date').fill(iso(10));
  await bar('Design').scrollIntoViewIfNeeded();
  const box = (await bar('Design').boundingBox())!;
  await window.mouse.move(box.x + 30, box.y + 8);
  await window.mouse.down();
  await window.mouse.move(box.x + 30 + 160, box.y + 8, { steps: 5 });
  await window.mouse.move(box.x + 30 + 320, box.y + 8, { steps: 5 });
  await window.mouse.up();
  await expect
    .poll(async () => (await bar('Design').boundingBox())!.x)
    .toBeGreaterThan(box.x + 300);

  // Stretch Build one day by its end.
  await bar('Build').scrollIntoViewIfNeeded();
  const b = (await bar('Build').boundingBox())!;
  await window.mouse.move(b.x + b.width - 2, b.y + 8);
  await window.mouse.down();
  await window.mouse.move(b.x + b.width + 80, b.y + 8, { steps: 4 });
  await window.mouse.move(b.x + b.width + 160, b.y + 8, { steps: 4 });
  await window.mouse.up();
  await expect
    .poll(async () => (await bar('Build').boundingBox())!.width)
    .toBeGreaterThan(b.width + 100);

  // Turn on dependencies, then draw one from Build to Design.
  await db(window).getByRole('tab', { name: 'Timeline' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Dependencies/ })
    .click();
  await bar('Build').evaluate((el) => el.scrollIntoView({ inline: 'center', block: 'center' }));
  await bar('Build').hover();
  const handle = timeline.getByRole('button', { name: 'Draw dependency from Build' });
  const h = (await handle.boundingBox())!;
  const d = (await bar('Design').boundingBox())!;
  await window.mouse.move(h.x + 4, h.y + 4);
  await window.mouse.down();
  await window.mouse.move(h.x + 40, h.y + 10, { steps: 4 });
  await window.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 6 });
  await window.mouse.up();
  await expect(timeline.getByTestId('dependency-arrow')).toHaveCount(1);

  await db(window).getByRole('tab', { name: 'Table' }).click();
  await expect(await cell(window, 'Design', 'When')).toHaveText(shown(12));
  await expect(await cell(window, 'Build', 'When')).toHaveText(`${shown(12)} → ${shown(13)}`);
  await expect(
    (await cell(window, 'Design', 'Blocked by')).getByTestId('relation-page'),
  ).toHaveText('Build');
  await expect(table(window)).toBeVisible();
});

test('chart: counts by group, sums a property, labels, pie and donut', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Select', 'Stage');
  await addProperty(window, 'Number', 'Cost');
  for (const [title, stage, cost] of [
    ['Alpha', 'Doing', '10'],
    ['Beta', 'Done', '25'],
    ['Gamma', 'Doing', '5'],
  ] as const) {
    await addRow(window, title);
    await (await cell(window, title, 'Stage')).click();
    await popover(window).getByLabel('Search for an option').fill(stage);
    await window.keyboard.press('Enter');
    await expect(popover(window)).toHaveCount(0);
    await (await cell(window, title, 'Cost')).click();
    await window.keyboard.type(cost);
    await window.keyboard.press('Enter');
  }
  await window.keyboard.press('Escape');

  await addView(window, 'Chart');
  const chart = window.getByTestId('chart-view');
  const ticks = chart.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value');
  await expect(ticks).toHaveText(['No Stage', 'Doing', 'Done']);
  await expect(chart.locator('.recharts-bar-rectangle .recharts-rectangle')).toHaveCount(2);

  await chart.getByRole('button', { name: 'Chart settings' }).click();
  const settings = window.getByTestId('chart-settings');
  await settings.getByLabel('Y axis').selectOption({ label: 'Cost' });
  await settings.getByLabel('Data labels').check();
  await settings.getByLabel('Hide empty groups').check();
  await settings.getByLabel('Sort').selectOption('yDesc');
  await expect(ticks).toHaveText(['Done', 'Doing']);
  await expect(chart.locator('.recharts-label-list text')).toHaveText(['25', '15']);

  await settings.getByLabel('Chart type').selectOption('pie');
  await expect(chart.locator('.recharts-pie-sector')).toHaveCount(2);
  await settings.getByLabel('Chart type').selectOption('donut');
  await expect(chart).toHaveAttribute('data-chart-type', 'donut');
  await settings.getByLabel('Chart type').selectOption('horizontalBar');
  await expect(
    chart.locator('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value'),
  ).toHaveText(['Done', 'Doing']);
  await window.keyboard.press('Escape');
});
