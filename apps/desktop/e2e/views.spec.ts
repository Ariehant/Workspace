import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, header, newDatabase, popover, rows, table, titles } from './db';
import { expect, quit, test } from './helpers';

const db = (window: Page) => window.getByTestId('database-view');
const toolbar = (window: Page, name: string) =>
  db(window).getByRole('button', { name, exact: true });
const groups = (window: Page) => table(window).getByTestId('group-header');

/** Rows Alpha/Beta/Gamma with a Stage select (Doing/Done) and a number Cost. */
async function seed(window: Page) {
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Select', 'Stage');
  await addProperty(window, 'Number', 'Cost');
  const data: [string, string, string][] = [
    ['Alpha', 'Doing', '10'],
    ['Beta', 'Done', '25'],
    ['Gamma', 'Doing', '5'],
  ];
  for (const [title, stage, cost] of data) {
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
}

async function pickProperty(window: Page, name: string) {
  await window.getByTestId('property-picker').getByRole('button', { name, exact: true }).click();
}

test('filters: simple chips, from the column menu, advanced AND/OR; kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seed(window);

  // Text filter from the toolbar.
  await toolbar(window, 'Filter').click();
  await pickProperty(window, 'Name');
  const filterPopover = window.getByTestId('filter-popover');
  await filterPopover.getByLabel('Filter value').fill('a');
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);
  await filterPopover.getByLabel('Condition').selectOption('startsWith');
  await filterPopover.getByLabel('Filter value').fill('g');
  await expect(titles(window)).toHaveText(['Gamma']);
  await window.keyboard.press('Escape');
  await expect(db(window).getByTestId('filter-chip')).toHaveText(/Name: starts with g/);

  // Number filter from the column menu.
  await db(window).getByTestId('filter-chip').click();
  await window.getByTestId('filter-popover').getByRole('button', { name: 'Delete filter' }).click();
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);
  await header(window, 'Cost').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: 'Filter' }).click();
  await filterPopover.getByLabel('Condition').selectOption('gt');
  await filterPopover.getByLabel('Filter value').fill('7');
  await expect(titles(window)).toHaveText(['Alpha', 'Beta']);
  await window.keyboard.press('Escape');

  // Advanced: Cost > 7 AND (Stage is Done OR Name contains "alp").
  await db(window).getByTestId('filter-chip').click();
  await window.getByTestId('filter-popover').getByRole('button', { name: 'Advanced' }).click();
  const advanced = window.getByTestId('advanced-filter');
  await advanced.getByRole('button', { name: 'Add filter group' }).click();
  const group = advanced.locator('[data-testid=filter-group][data-depth="1"]');
  await group.getByLabel('Property').selectOption({ label: 'Stage' });
  await group.getByRole('checkbox', { name: 'Done' }).check();
  await group.getByRole('button', { name: 'Add filter rule' }).click();
  await group.getByTestId('filter-rule').nth(1).getByLabel('Filter value').fill('alp');
  await group.getByLabel('And or or').selectOption('or');
  await expect(titles(window)).toHaveText(['Alpha', 'Beta']);
  await group.getByTestId('filter-rule').first().getByRole('checkbox', { name: 'Done' }).uncheck();
  await expect(titles(window)).toHaveText(['Alpha']);
  await window.keyboard.press('Escape');
  await expect(db(window).getByTestId('advanced-chip')).toHaveText(/3 rules/);

  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await expect(titles(window)).toHaveText(['Alpha']);
  await db(window).getByTestId('advanced-chip').click();
  await window
    .getByTestId('advanced-filter')
    .getByRole('button', { name: 'Delete filter', exact: true })
    .click();
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);
});

test('sorts: several, reversed and removed', async ({ launch }) => {
  const { window } = await launch();
  await seed(window);
  await toolbar(window, 'Sort').click();
  await pickProperty(window, 'Stage');
  // Stage ascending (Doing before Done), then Cost descending.
  await expect(titles(window)).toHaveText(['Alpha', 'Gamma', 'Beta']);
  const editor = window.getByTestId('sort-editor');
  await editor.getByRole('button', { name: 'Add sort' }).click();
  await pickProperty(window, 'Cost');
  await editor.getByTestId('sort-row').nth(1).getByLabel('Sort direction').selectOption('desc');
  await expect(titles(window)).toHaveText(['Alpha', 'Gamma', 'Beta']);
  await editor.getByTestId('sort-row').nth(1).getByLabel('Sort direction').selectOption('asc');
  await expect(titles(window)).toHaveText(['Gamma', 'Alpha', 'Beta']);
  await window.keyboard.press('Escape');
  await expect(db(window).getByTestId('sort-chip')).toHaveText(/2 sorts/);
  await db(window).getByTestId('sort-chip').click();
  await editor.getByRole('button', { name: 'Delete sort' }).click();
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);
});

test('groups: headers with counts, new rows in a group, collapse, hide, sub-groups', async ({
  launch,
}) => {
  const { window } = await launch();
  await seed(window);
  await toolbar(window, 'Group').click();
  const editor = window.getByTestId('group-editor');
  await editor.getByLabel('Group by').selectOption({ label: 'Stage' });
  await window.keyboard.press('Escape');
  await expect(groups(window).getByTestId('group-label')).toHaveText([
    'No Stage0',
    'Doing2',
    'Done1',
  ]);

  // "+ New" in a group gives the row the group's value.
  const doing = groups(window).filter({ hasText: 'Doing' });
  const newInDoing = table(window).getByTestId('table-new-row').nth(1);
  await newInDoing.click();
  await window.keyboard.type('Delta');
  await window.keyboard.press('Enter');
  await expect(doing.getByTestId('group-count')).toHaveText('3');
  await expect(await cell(window, 'Delta', 'Stage')).toHaveText('Doing');

  // Collapse, then hide a group and show it again.
  await doing.getByRole('button', { name: 'Collapse group' }).click();
  await expect(titles(window)).toHaveText(['Beta']);
  await doing.getByRole('button', { name: 'Expand group' }).click();
  const done = groups(window).filter({ hasText: 'Done' });
  await done.hover();
  await done.getByRole('button', { name: 'Hide group' }).click();
  await expect(groups(window)).toHaveCount(2);
  await toolbar(window, 'Group').click();
  await editor.getByTestId('hidden-groups').getByRole('button', { name: 'Show' }).click();
  await editor.getByLabel('Hide empty groups').check();
  await expect(groups(window).getByTestId('group-label')).toHaveText(['Doing3', 'Done1']);

  // Sub-group by a checkbox.
  await window.keyboard.press('Escape');
  await addProperty(window, 'Checkbox', 'Ordered');
  await (await cell(window, 'Alpha', 'Ordered')).getByRole('checkbox').click();
  await toolbar(window, 'Group').click();
  await editor.getByLabel('Sub-group by').selectOption({ label: 'Ordered' });
  await window.keyboard.press('Escape');
  await expect(groups(window).getByTestId('group-label')).toHaveText([
    'Doing3',
    'Checked1',
    'Unchecked2',
    'Done1',
    'Checked0',
    'Unchecked1',
  ]);

  // Dragging a row into another group changes its value.
  await toolbar(window, 'Group').click();
  await editor.getByLabel('Sub-group by').selectOption('');
  await window.keyboard.press('Escape');
  // (Row handles sit left of the first column; scroll back if the table moved sideways.)
  // Hover the title cell: hovering the whole (wide) row would scroll the table sideways.
  await table(window).evaluate((el) => (el.scrollLeft = 0));
  await (await cell(window, 'Gamma', 'Name')).hover();
  const grip = rows(window)
    .filter({ hasText: 'Gamma' })
    .getByRole('button', { name: 'Drag to move, click to open menu' });
  const from = (await grip.boundingBox())!;
  const to = (await rows(window).filter({ hasText: 'Beta' }).boundingBox())!;
  await window.mouse.move(from.x + 5, from.y + 5);
  await window.mouse.down();
  await window.mouse.move(from.x + 10, from.y + 8, { steps: 3 });
  await window.mouse.move(to.x + 100, to.y + to.height - 4, { steps: 6 });
  await window.mouse.up();
  await expect(await cell(window, 'Gamma', 'Stage')).toHaveText('Done');
  await expect(groups(window).getByTestId('group-label')).toHaveText(['Doing2', 'Done2']);
});

test('calculations, number and date formats, ID prefix, search', async ({ launch }) => {
  const { window } = await launch();
  await seed(window);

  // Sum under Cost, count under Name.
  const calcCell = (index: number) =>
    table(window).getByTestId('calc-row').getByTestId('calc-cell').nth(index);
  await calcCell(3).click();
  await window.getByTestId('calc-menu').getByRole('menuitem', { name: 'Sum' }).click();
  await expect(calcCell(3)).toHaveText(/Sum\s*40/i);
  await calcCell(0).click();
  await window.getByTestId('calc-menu').getByRole('menuitem', { name: 'Count all' }).click();
  await expect(calcCell(0)).toHaveText(/Count\s*3/i);

  // Number format: US dollar, in cells and in the sum.
  await header(window, 'Cost').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: /Number format/ })
    .click();
  await window.getByRole('menuitemradio', { name: 'US dollar' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Beta', 'Cost')).toHaveText('$25.00');
  await expect(calcCell(3)).toHaveText(/\$40\.00/);

  // Date format.
  await addProperty(window, 'Date', 'Due');
  await (await cell(window, 'Alpha', 'Due')).click();
  await popover(window).getByLabel('Start date').fill('2026-03-07');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Alpha', 'Due')).toHaveText('Mar 7, 2026');
  await header(window, 'Due').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: /Date format/ })
    .click();
  await window.getByRole('menuitemradio', { name: 'Year/Month/Day' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Alpha', 'Due')).toHaveText('2026/03/07');

  // ID with a prefix.
  await addProperty(window, 'ID', 'Ref');
  await header(window, 'Ref').click();
  await window.getByTestId('property-menu').getByLabel('ID prefix').fill('part');
  await window.getByTestId('property-menu').getByLabel('ID prefix').press('Enter');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Gamma', 'Ref')).toHaveText('PART-3');

  // Search inside the view.
  await db(window).getByRole('button', { name: 'Search', exact: true }).click();
  await db(window).getByLabel('Search in view').fill('done');
  await expect(titles(window)).toHaveText(['Beta']);
  await db(window).getByLabel('Search in view').fill('zzz');
  await expect(db(window).getByTestId('no-results')).toBeVisible();
  await db(window).getByLabel('Search in view').press('Escape');
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);
});

test('view tabs: add, rename, duplicate, reorder, delete; each keeps its own settings', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seed(window);
  const tabs = () => db(window).getByRole('tab');

  // A second view with its own filter.
  await db(window).getByRole('button', { name: 'Add a view' }).click();
  await window.getByTestId('add-view-menu').getByRole('menuitem', { name: 'Table' }).click();
  await expect(tabs()).toHaveText(['Table', 'Table 2']);
  await toolbar(window, 'Filter').click();
  await pickProperty(window, 'Stage');
  await window.getByTestId('filter-popover').getByRole('checkbox', { name: 'Done' }).check();
  await window.keyboard.press('Escape');
  await expect(titles(window)).toHaveText(['Beta']);

  // Rename it, then duplicate it.
  await tabs().nth(1).click();
  const name = window.getByTestId('view-menu').getByLabel('View name');
  await name.fill('Finished');
  await window.keyboard.press('Escape');
  await expect(tabs()).toHaveText(['Table', 'Finished']);
  await tabs().nth(1).click();
  await window.getByTestId('view-menu').getByRole('menuitem', { name: 'Duplicate view' }).click();
  await expect(tabs()).toHaveText(['Table', 'Finished', 'Finished (1)']);
  await expect(titles(window)).toHaveText(['Beta']);

  // The first view is unfiltered.
  await tabs().first().click();
  await expect(titles(window)).toHaveText(['Alpha', 'Beta', 'Gamma']);

  // Reorder by dragging a tab, delete one.
  await tabs().nth(2).dragTo(tabs().first());
  await expect(tabs()).toHaveText(['Finished (1)', 'Table', 'Finished']);
  await tabs().nth(2).click();
  await tabs().nth(2).click();
  await window.getByTestId('view-menu').getByRole('menuitem', { name: 'Delete view' }).click();
  await expect(tabs()).toHaveText(['Finished (1)', 'Table']);

  // The window remembers the view it showed.
  await tabs().first().click();
  await expect(titles(window)).toHaveText(['Beta']);
  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await expect(db(window).getByRole('tab', { selected: true })).toHaveText('Finished (1)');
  await expect(titles(window)).toHaveText(['Beta']);
});

test('row pages hide empty properties; date reminders notify', async ({ launch }) => {
  const { app, window } = await launch();
  await seed(window);
  await addProperty(window, 'Date', 'Due');
  await addProperty(window, 'Text', 'Notes');

  // Hide empty properties on row pages.
  await (await cell(window, 'Alpha', 'Name')).hover();
  await table(window).getByRole('button', { name: 'Open', exact: true }).click();
  const peek = window.getByTestId('row-peek');
  await expect(peek.getByTestId('property-row')).toHaveCount(5);
  await peek.getByRole('button', { name: 'Hide empty properties' }).click();
  await expect(peek.getByTestId('property-row')).toHaveCount(2);
  await expect(peek.getByRole('button', { name: /3 more properties/ })).toBeVisible();

  // A reminder on a date that is already past fires right away.
  await peek.getByRole('button', { name: /3 more properties/ }).click();
  await peek.getByRole('button', { name: 'Edit Due' }).click();
  const yesterday = new Date(Date.now() - 86_400_000);
  const iso = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  await popover(window).getByLabel('Start date').fill(iso);
  await popover(window).getByLabel('Remind').selectOption('onDay');
  await window.keyboard.press('Escape');
  const notifications = () =>
    app.evaluate(
      () =>
        (globalThis as { __notifications?: { title: string; body: string; pageId: string }[] })
          .__notifications ?? [],
    );
  await expect.poll(notifications, { timeout: 10_000 }).toHaveLength(1);
  expect((await notifications())[0]).toMatchObject({ title: 'Alpha', body: 'Due: Alpha' });
});
