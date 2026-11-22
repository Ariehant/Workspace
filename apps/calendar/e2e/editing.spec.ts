/**
 * Editing in the calendar (HANDOFF.md 1 and 3.7), against a real Workspace server: drag to
 * create, drag to move, drag the bottom edge to resize, the event panel, delete with Undo, and
 * Open in Workspace. Each edit is checked in Workspace itself.
 */
import type { Page } from '@playwright/test';
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { connect, expect, test, type V1 } from './helpers';

/** The grid's hour height (`HOUR_PX` in src/renderer/week.tsx). */
const HOUR_PX = 48;
const week = startOfWeek(today(), 1);
const day = (i: number) => addDays(week, i);

/** Scroll the grid so 08:00 is at the top (the times dragged to are then on screen). */
async function showWorkingHours(window: Page) {
  await window.getByTestId('time-grid').evaluate((el, px) => (el.scrollTop = px), 8 * HOUR_PX);
}

/** The window point of a time in a day's column. */
async function point(window: Page, d: string, hours: number, xFraction = 0.5) {
  const box = (await window.getByTestId(`day-${d}`).boundingBox())!;
  return { x: box.x + box.width * xFraction, y: box.y + hours * HOUR_PX };
}

async function drag(window: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await window.mouse.move(from.x, from.y);
  await window.mouse.down();
  await window.mouse.move(to.x, to.y, { steps: 12 });
  await window.mouse.up();
}

/** The row's date in Workspace, once it's what's expected. */
async function expectRowDate(v1: V1, id: string, date: { start: string; end: string | null }) {
  await expect
    .poll(async () => {
      const page = await v1.page(id);
      const value = (page.properties.When as { date: { start: string; end: string | null } | null })
        .date;
      return value && { start: value.start, end: value.end };
    })
    .toEqual(date);
}

async function rowsTitled(v1: V1, db: string, title: string) {
  const res = await v1.call<{ results: { id: string }[] }>('POST', `/databases/${db}/query`, {
    filter: { property: 'Name', title: { equals: title } },
  });
  return res.results.map((r) => r.id);
}

const at = (d: string, time: string) => `${d}T${time}:00.000+00:00`;

/** Screenshots for review, when asked for (`CALENDAR_SCREENSHOTS=<dir>`). */
async function shot(window: Page, name: string) {
  if (process.env.CALENDAR_SCREENSHOTS)
    await window.screenshot({ path: `${process.env.CALENDAR_SCREENSHOTS}/${name}.png` });
}

test('drags to create, move and resize, and Workspace gets each change', async ({
  launch,
  seed,
  v1,
}) => {
  const db = await v1.database('Drag work');
  const review = await v1.row(db, 'Review', { start: `${day(1)}T09:00`, end: `${day(1)}T10:00` });
  const launched = await launch();
  await connect(launched, seed.base, seed.integration.token, 'Drag work');
  const { window } = launched;
  const grid = window.getByRole('region', { name: 'Calendar' });
  await expect(grid.getByRole('button', { name: /^Review, 9:00/ })).toBeVisible();
  await showWorkingHours(window);

  // Drag on empty space: the panel opens for the new event, saved with a title.
  await drag(window, await point(window, day(2), 10), await point(window, day(2), 11.5));
  const panel = window.getByRole('complementary', { name: 'New event' });
  await expect(panel.getByLabel('Title')).toBeFocused();
  await panel.getByLabel('Title').fill('Design sync');
  await window.keyboard.press('Enter');
  await expect(panel).toBeHidden();
  await expect(
    grid.getByRole('button', { name: /^Design sync, 10:00 AM – 11:30 AM/ }),
  ).toBeVisible();
  await expect.poll(() => rowsTitled(v1, db, 'Design sync')).toHaveLength(1);
  const [created] = await rowsTitled(v1, db, 'Design sync');
  await expectRowDate(v1, created!, { start: at(day(2), '10:00'), end: at(day(2), '11:30') });

  // Drag an event two days later and an hour later.
  const event = grid.getByRole('button', { name: /^Review, 9:00/ });
  const box = (await event.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + 10 };
  const target = await point(window, day(3), 0);
  await drag(window, from, { x: target.x, y: from.y + HOUR_PX });
  await expect(grid.getByRole('button', { name: /^Review, 10:00 AM – 11:00 AM/ })).toBeVisible();
  await expectRowDate(v1, review, { start: at(day(3), '10:00'), end: at(day(3), '11:00') });

  // Drag its bottom edge to 12:30.
  const handle = grid.getByRole('button', { name: /^Review, 10:00/ }).getByTestId('resize-handle');
  const h = (await handle.boundingBox())!;
  await drag(
    window,
    { x: h.x + h.width / 2, y: h.y + h.height / 2 },
    { x: h.x + h.width / 2, y: (await point(window, day(3), 12.5)).y },
  );
  await expect(grid.getByRole('button', { name: /^Review, 10:00 AM – 12:30 PM/ })).toBeVisible();
  await expectRowDate(v1, review, { start: at(day(3), '10:00'), end: at(day(3), '12:30') });

  // Drag it onto the all-day row.
  const moved = grid.getByRole('button', { name: /^Review, 10:00/ });
  const m = (await moved.boundingBox())!;
  const row = (await window.getByTestId(`all-day-${day(4)}`).boundingBox())!;
  await drag(
    window,
    { x: m.x + m.width / 2, y: m.y + 10 },
    { x: row.x + row.width / 2, y: row.y + row.height / 2 },
  );
  await expect(grid.getByRole('button', { name: 'Review, all day' })).toBeVisible();
  await expectRowDate(v1, review, { start: day(4), end: null });
});

test('edits in the panel, deletes with Undo, and opens rows in Workspace', async ({
  launch,
  seed,
  v1,
}) => {
  const db = await v1.database('Panel work');
  const row = await v1.row(db, 'Retro', { start: `${day(2)}T15:00`, end: `${day(2)}T16:00` });
  const launched = await launch();
  await connect(launched, seed.base, seed.integration.token, 'Panel work');
  const { app, window } = launched;
  const grid = window.getByRole('region', { name: 'Calendar' });

  await grid.getByRole('button', { name: /^Retro, 3:00/ }).click();
  const panel = window.getByRole('complementary', { name: 'Event' });
  await expect(panel.getByLabel('Title')).toHaveValue('Retro');
  await shot(window, 'panel');

  // Rename, and change the start time (the end follows).
  await panel.getByLabel('Title').fill('Sprint retro');
  await window.keyboard.press('Enter');
  await panel.getByLabel('Starts time').fill('16:30');
  await expect(
    grid.getByRole('button', { name: /^Sprint retro, 4:30 PM – 5:30 PM/ }),
  ).toBeVisible();
  await expectRowDate(v1, row, { start: at(day(2), '16:30'), end: at(day(2), '17:30') });
  await expect
    .poll(async () => {
      const page = await v1.page(row);
      return (page.properties.Name as { title: { plain_text: string }[] }).title[0]?.plain_text;
    })
    .toBe('Sprint retro');

  // Open in Workspace opens the row's link in the browser.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      (globalThis as { __opened?: string }).__opened = url;
    };
  });
  await panel.getByRole('button', { name: 'Open in Workspace' }).click();
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __opened?: string }).__opened))
    .toBe(`${seed.base}/w/${seed.workspaceId}#page=${row}`);

  // Delete, then Undo: it comes back and Workspace never trashes it.
  await panel.getByRole('button', { name: 'Delete' }).click();
  await expect(grid.getByRole('button', { name: /^Sprint retro/ })).toHaveCount(0);
  await window
    .getByRole('status', { name: 'Deleted' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(grid.getByRole('button', { name: /^Sprint retro/ })).toBeVisible();
  await window.waitForTimeout(6_000);
  expect((await v1.page(row)).in_trash).toBe(false);

  // Delete with the keyboard: in Workspace's trash once Undo's few seconds are up.
  await grid.getByRole('button', { name: /^Sprint retro/ }).focus();
  await window.keyboard.press('Delete');
  await expect(grid.getByRole('button', { name: /^Sprint retro/ })).toHaveCount(0);
  await expect.poll(async () => (await v1.page(row)).in_trash, { timeout: 15_000 }).toBe(true);
});

test('switches views, goes to dates and finds events from the command bar', async ({
  launch,
  seed,
  v1,
}) => {
  const db = await v1.database('Views');
  await v1.row(db, 'Quarterly planning', { start: `${day(1)}T11:00`, end: `${day(1)}T12:00` });
  const launched = await launch();
  await connect(launched, seed.base, seed.integration.token, 'Views');
  const { window } = launched;
  const view = window.getByRole('button', { name: /^View:/ });
  const grid = window.getByRole('region', { name: 'Calendar' });

  await window.keyboard.press('m');
  await expect(view).toHaveAccessibleName('View: Month');
  await expect(grid.getByRole('button', { name: /^Quarterly planning/ })).toBeVisible();
  await shot(window, 'month');
  await window.keyboard.press('a');
  await expect(view).toHaveAccessibleName('View: Agenda');
  await window.keyboard.press('3');
  await expect(view).toHaveAccessibleName('View: 3 days');
  await window.keyboard.press('w');
  await expect(view).toHaveAccessibleName('View: Week');

  // Go to a date.
  await window.keyboard.press('Control+k');
  const bar = window.getByRole('dialog', { name: 'Command bar' });
  await bar.getByRole('combobox').fill('2027-03-15');
  await window.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(window.getByRole('heading', { level: 1 })).toHaveText(/Mar.*2027/);

  // Find an event by title: it opens, on its day.
  await window.keyboard.press('Control+k');
  await bar.getByRole('combobox').fill('quarterly');
  await expect(bar.getByRole('option', { name: /Quarterly planning/ })).toBeVisible();
  await shot(window, 'command');
  await window.keyboard.press('Enter');
  await expect(
    window.getByRole('complementary', { name: 'Event' }).getByLabel('Title'),
  ).toHaveValue('Quarterly planning');
  await window.keyboard.press('Escape');

  // A command: the day view.
  await window.keyboard.press('Control+k');
  await bar.getByRole('combobox').fill('day view');
  await window.keyboard.press('Enter');
  await expect(view).toHaveAccessibleName('View: Day');

  // The shortcuts sheet.
  await window.keyboard.press('?');
  await expect(window.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await window.keyboard.press('Escape');

  // A second time zone as another time column, from Settings.
  await window.getByRole('button', { name: 'Settings' }).click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  await settings.getByLabel('Second time zone').selectOption('Asia/Kolkata');
  await window.keyboard.press('Escape');
  await expect(window.getByRole('group', { name: 'Times in Asia/Kolkata' })).toBeVisible();
});
