import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, popover, titles } from './db';
import { expect, quit, test } from './helpers';

const db = (window: Page) => window.getByTestId('database-view');
const board = (window: Page) => window.getByTestId('board-view');
/** Cards of the board column whose header reads `label`. */
async function columnCards(window: Page, label: string) {
  const headers = await board(window).getByTestId('board-column').allInnerTexts();
  const index = headers.findIndex((h) => h.trim().split('\n')[0]!.trim() === label);
  expect(index, `column ${label}`).toBeGreaterThanOrEqual(0);
  return board(window).getByTestId('board-cell').nth(index).getByTestId('card-title');
}

async function addView(window: Page, type: string) {
  await db(window).getByRole('button', { name: 'Add a view' }).click();
  await window.getByTestId('add-view-menu').getByRole('menuitem', { name: type }).click();
}

async function viewMenu(window: Page, tab: string) {
  await db(window).getByRole('tab', { name: tab }).click();
  return window.getByTestId('view-menu');
}

/** Show a property on cards / list rows (view menu → Properties). */
async function showProperty(window: Page, tab: string, name: string) {
  const menu = await viewMenu(window, tab);
  await menu.getByRole('menuitem', { name: 'Properties' }).click();
  await window.getByRole('menuitem', { name }).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
}

/** Rows Alpha/Beta/Gamma with a Stage select: Doing, Done, (none). */
async function seed(window: Page) {
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Select', 'Stage');
  for (const [title, stage] of [
    ['Alpha', 'Doing'],
    ['Beta', 'Done'],
    ['Gamma', null],
  ] as const) {
    await addRow(window, title);
    if (!stage) continue;
    await (await cell(window, title, 'Stage')).click();
    await popover(window).getByLabel('Search for an option').fill(stage);
    await window.keyboard.press('Enter');
    await expect(popover(window)).toHaveCount(0);
  }
  await window.keyboard.press('Escape');
}

test('board: columns by group, drag cards between them, new cards, hidden columns, kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seed(window);
  await addView(window, 'Board');
  await expect(board(window)).toBeVisible();
  await expect(board(window).getByTestId('board-column')).toHaveText([
    /^No Stage/,
    /^Doing/,
    /^Done/,
  ]);
  await expect(await columnCards(window, 'Doing')).toHaveText(['Alpha']);
  await expect(await columnCards(window, 'No Stage')).toHaveText(['Gamma']);

  // Drag Gamma onto Done, below Beta: its Stage changes.
  const from = (await board(window)
    .getByTestId('card')
    .filter({ hasText: 'Gamma' })
    .boundingBox())!;
  const to = (await board(window).getByTestId('card').filter({ hasText: 'Beta' }).boundingBox())!;
  await window.mouse.move(from.x + 20, from.y + 10);
  await window.mouse.down();
  await window.mouse.move(from.x + 30, from.y + 14, { steps: 3 });
  await window.mouse.move(to.x + 20, to.y + to.height - 4, { steps: 8 });
  await window.mouse.up();
  await expect(await columnCards(window, 'Done')).toHaveText(['Beta', 'Gamma']);
  await expect(await columnCards(window, 'No Stage')).toHaveText([]);

  // Drag it back above Beta: the manual order changes too.
  const g = (await board(window).getByTestId('card').filter({ hasText: 'Gamma' }).boundingBox())!;
  const b = (await board(window).getByTestId('card').filter({ hasText: 'Beta' }).boundingBox())!;
  await window.mouse.move(g.x + 20, g.y + 10);
  await window.mouse.down();
  await window.mouse.move(g.x + 30, g.y + 6, { steps: 3 });
  await window.mouse.move(b.x + 20, b.y + 4, { steps: 8 });
  await window.mouse.up();
  await expect(await columnCards(window, 'Done')).toHaveText(['Gamma', 'Beta']);

  // "+ New" in a column adds a card with that column's value; type its title.
  await board(window).getByTestId('board-cell').nth(1).getByTestId('board-new').click();
  await window.keyboard.type('Delta');
  await window.keyboard.press('Enter');
  await expect(await columnCards(window, 'Doing')).toHaveText(['Alpha', 'Delta']);

  // Properties picked for cards show on them.
  await showProperty(window, 'Board', 'Stage');
  await expect(
    board(window).getByTestId('card').filter({ hasText: 'Delta' }).getByTestId('option'),
  ).toHaveText('Doing');

  // Hide the empty "No Stage" column; it's listed under hidden groups.
  await board(window).getByTestId('board-column').first().hover();
  await board(window).getByRole('button', { name: 'No Stage options' }).click();
  await window.getByRole('menuitem', { name: 'Hide column' }).click();
  await expect(board(window).getByTestId('board-column')).toHaveText([/^Doing/, /^Done/]);
  await expect(board(window).getByTestId('hidden-columns')).toContainText('No Stage');

  // The table agrees.
  await db(window).getByRole('tab', { name: 'Table' }).click();
  await expect(await cell(window, 'Gamma', 'Stage')).toHaveText('Done');
  await expect(await cell(window, 'Delta', 'Stage')).toHaveText('Doing');
  await expect(titles(window)).toHaveText(['Alpha', 'Gamma', 'Beta', 'Delta']);

  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await db(window).getByRole('tab', { name: 'Board' }).click();
  await expect(await columnCards(window, 'Done')).toHaveText(['Gamma', 'Beta']);
  await expect(board(window).getByTestId('board-column')).toHaveText([/^Doing/, /^Done/]);
});

test('list and gallery: compact rows, cards with covers, layout and card settings', async ({
  launch,
}) => {
  const { window } = await launch();
  await seed(window);

  // List: titles, plus the properties picked for it.
  await addView(window, 'List');
  const list = window.getByTestId('list-view');
  await expect(list.getByTestId('list-title')).toHaveText(['Alpha', 'Beta', 'Gamma']);
  await expect(list.getByTestId('list-property')).toHaveCount(0);
  await showProperty(window, 'List', 'Stage');
  await expect(
    list.getByTestId('list-row').filter({ hasText: 'Beta' }).getByTestId('option'),
  ).toHaveText('Done');
  await list.getByTestId('list-new').click();
  await window.keyboard.type('Delta');
  await window.keyboard.press('Enter');
  await expect(list.getByTestId('list-title')).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);

  // Clicking a row opens its page; give Beta a cover there.
  await list.getByTestId('list-row').filter({ hasText: 'Beta' }).click();
  const peek = window.getByTestId('row-peek');
  await peek.getByLabel('Page title').hover();
  await peek.getByRole('button', { name: 'Add cover' }).click();
  await peek.getByRole('button', { name: 'Close' }).click();

  // Switch the list to a gallery from the view menu.
  let menu = await viewMenu(window, 'List');
  await menu.getByRole('menuitem', { name: /^Layout/ }).click();
  await window.getByRole('menuitemradio', { name: 'Gallery' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  const gallery = window.getByTestId('gallery-view');
  await expect(gallery.getByTestId('card-title')).toHaveText(['Alpha', 'Beta', 'Gamma', 'Delta']);

  // Card preview: the page cover.
  menu = await viewMenu(window, 'List');
  await menu.getByRole('menuitem', { name: /^Card preview/ }).click();
  await window.getByRole('menuitemradio', { name: 'Page cover' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(
    gallery.getByTestId('card').filter({ hasText: 'Beta' }).getByTestId('card-cover'),
  ).toBeVisible();
  await expect(gallery.getByTestId('card-cover')).toHaveCount(1);

  // Card size changes the grid; grouping works in galleries too.
  const width = async () => (await gallery.getByTestId('card').first().boundingBox())!.width;
  const before = await width();
  menu = await viewMenu(window, 'List');
  await menu.getByRole('menuitem', { name: /^Card size/ }).click();
  await window.getByRole('menuitemradio', { name: 'Large' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect.poll(width).toBeGreaterThan(before);

  await db(window).getByRole('button', { name: 'Group', exact: true }).click();
  await window.getByTestId('group-editor').getByLabel('Group by').selectOption({ label: 'Stage' });
  await window.keyboard.press('Escape');
  await expect(gallery.getByTestId('group-label')).toHaveText(['No Stage2', 'Doing1', 'Done1']);
});
