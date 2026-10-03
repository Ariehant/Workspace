import type { Locator, Page } from '@playwright/test';
import { editor, expect, quit, test, waitForIndexed } from './helpers';

async function newPage(window: Page, title: string, body?: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  if (body) await window.keyboard.type(body);
}

const pagesTree = (window: Page) => window.getByRole('tree', { name: 'Pages' });
/** Titles of the top-level pages, in sidebar order. */
const topLevel = (window: Page) =>
  pagesTree(window).locator(':scope > li > [data-testid=sidebar-row]');
const row = (window: Page, title: string) =>
  pagesTree(window).getByTestId('sidebar-row').filter({ hasText: title });
const title = (window: Page) => window.getByLabel('Page title');

async function rowMenu(window: Page, target: Locator) {
  await target.hover();
  await target.getByRole('button', { name: 'Delete, duplicate, and more…' }).click();
}

test('sidebar drag and drop: reorder, nest, un-nest', async ({ launch }) => {
  const { window } = await launch();
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await newPage(window, name);
  await expect(topLevel(window)).toHaveText(['👋Getting started', 'Alpha', 'Bravo', 'Charlie']);

  // Onto the top edge of a row: before it.
  await row(window, 'Charlie').dragTo(row(window, 'Alpha'), { targetPosition: { x: 40, y: 2 } });
  await expect(topLevel(window)).toHaveText(['👋Getting started', 'Charlie', 'Alpha', 'Bravo']);

  // Onto the middle of a row: inside it (and the new parent opens).
  const box = (await row(window, 'Charlie').boundingBox())!;
  await row(window, 'Bravo').dragTo(row(window, 'Charlie'), {
    targetPosition: { x: 40, y: box.height / 2 },
  });
  await expect(topLevel(window)).toHaveText(['👋Getting started', 'Charlie', 'Alpha']);
  const charlie = pagesTree(window).getByRole('treeitem').filter({ hasText: 'Charlie' });
  await expect(charlie.getByRole('group')).toHaveText('Bravo');

  // Below the tree: back to the end of the top level.
  await row(window, 'Bravo').dragTo(window.getByTestId('sidebar-drop-end'));
  await expect(topLevel(window)).toHaveText(['👋Getting started', 'Charlie', 'Alpha', 'Bravo']);

  // A page can't be dropped into its own sub-page.
  await row(window, 'Alpha').dragTo(row(window, 'Charlie'), {
    targetPosition: { x: 40, y: box.height / 2 },
  });
  await expect(charlie.getByRole('group')).toHaveText('Alpha');
  await row(window, 'Charlie').dragTo(row(window, 'Alpha'), {
    targetPosition: { x: 40, y: box.height / 2 },
  });
  await expect(topLevel(window)).toHaveText(['👋Getting started', 'Charlie', 'Bravo']);
  await expect(charlie.getByRole('group')).toHaveText('Alpha');
});

test('favorites and sidebar width are kept after restart', async ({ launch }) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Gripper');
  const favorites = window.getByRole('tree', { name: 'Favorites' });
  await expect(favorites).toHaveCount(0);

  await rowMenu(window, row(window, 'Gripper'));
  await window.getByRole('menuitem', { name: 'Add to Favorites' }).click();
  await expect(favorites).toHaveText('Gripper');
  await expect(window.getByRole('button', { name: 'Remove from Favorites' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
  const handle = window.getByTestId('sidebar-resize');
  const h = (await handle.boundingBox())!;
  await window.mouse.move(h.x + h.width / 2, h.y + 200);
  await window.mouse.down();
  await window.mouse.move(h.x + h.width / 2 + 100, h.y + 200, { steps: 5 });
  await window.mouse.up();
  await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(340);

  // Let the debounced width setting save.
  await window.waitForTimeout(500);
  await quit(first.app);
  ({ window } = await launch());
  await expect(window.getByRole('tree', { name: 'Favorites' })).toHaveText('Gripper');
  await expect
    .poll(
      async () => (await window.getByRole('navigation', { name: 'Sidebar' }).boundingBox())!.width,
    )
    .toBe(340);

  // Header star toggles it off again.
  await window.getByRole('button', { name: 'Remove from Favorites' }).click();
  await expect(window.getByRole('tree', { name: 'Favorites' })).toHaveCount(0);
});

test('trash: open, restore, delete permanently', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Old notes');
  await newPage(window, 'Draft');
  for (const name of ['Old notes', 'Draft']) {
    await rowMenu(window, row(window, name));
    await window.getByRole('menuitem', { name: 'Move to Trash' }).click();
  }
  await expect(row(window, 'Draft')).toHaveCount(0);

  await window.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = window.getByTestId('trash');
  await expect(trash.getByTestId('trash-item')).toHaveText(['Draft', 'Old notes']);
  await trash.getByLabel('Search pages in Trash').fill('old');
  await expect(trash.getByTestId('trash-item')).toHaveText(['Old notes']);
  await trash.getByLabel('Search pages in Trash').fill('');

  // Restore.
  await trash.getByTestId('trash-item').filter({ hasText: 'Draft' }).hover();
  await trash
    .getByTestId('trash-item')
    .filter({ hasText: 'Draft' })
    .getByRole('button', { name: 'Restore' })
    .click();
  await expect(trash.getByTestId('trash-item')).toHaveText(['Old notes']);
  await expect(row(window, 'Draft')).toHaveCount(1);

  // Clicking a trashed page opens it, with the trash banner.
  await trash.getByTestId('trash-item').click();
  await expect(title(window)).toHaveValue('Old notes');
  await expect(window.getByText('This page is in Trash.')).toBeVisible();

  // Delete permanently, after confirming.
  await window.getByRole('button', { name: 'Trash', exact: true }).click();
  await trash.getByRole('button', { name: 'Delete from Trash' }).click();
  const confirm = window.getByTestId('confirm-delete');
  await expect(confirm).toContainText('Old notes');
  await confirm.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(confirm).toHaveCount(0);
  await window.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(trash).toContainText('Trash is empty');
});

test('quick find: recent pages, search in content, open', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Locomotion', 'The quadruped gait planner runs at 200 Hz.');
  await newPage(window, 'Perception', 'Stereo depth.');
  await waitForIndexed(window, 'quadruped');

  // No query: recently visited pages, most recent first.
  await window.keyboard.press('Control+k');
  const dialog = window.getByTestId('quick-find');
  const results = dialog.getByTestId('quick-find-result');
  await expect(results.first()).toContainText('Perception');
  await expect(results.nth(1)).toContainText('Locomotion');
  await window.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Words in a page's content, with the match highlighted.
  await window.keyboard.press('Control+p');
  await window.keyboard.type('quadru');
  await expect(results).toHaveCount(1);
  await expect(results).toContainText('Locomotion');
  await expect(results.locator('mark')).toHaveText('quadruped');

  // Titles match before the index answers, and match anywhere.
  await dialog.getByLabel('Search pages').fill('cept');
  await expect(results).toHaveText([/Perception/]);
  await dialog.getByLabel('Search pages').fill('gait');
  await expect(results).toHaveText([/Locomotion/]);
  await window.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(title(window)).toHaveValue('Locomotion');

  // Search from the sidebar too.
  await window.getByRole('button', { name: /^Search/ }).click();
  await dialog.getByLabel('Search pages').fill('nothing matches this');
  await expect(dialog).toContainText('No results');
});

test('back and forward history', async ({ launch }) => {
  const { window } = await launch();
  for (const name of ['One', 'Two', 'Three']) await newPage(window, name);
  await expect(title(window)).toHaveValue('Three');

  await window.keyboard.press('Alt+ArrowLeft');
  await expect(title(window)).toHaveValue('Two');
  await window.getByRole('button', { name: 'Go back (Alt+←)' }).click();
  await expect(title(window)).toHaveValue('One');
  await window.keyboard.press('Alt+ArrowRight');
  await expect(title(window)).toHaveValue('Two');

  // Visiting a page drops the forward history.
  await row(window, 'One').click();
  await expect(window.getByRole('button', { name: 'Go forward (Alt+→)' })).toBeDisabled();
  await window.getByRole('button', { name: 'Go back (Alt+←)' }).click();
  await expect(title(window)).toHaveValue('Two');
});

test('workspace:// links open pages and blocks; open in new window', async ({ launch }) => {
  const { app, window } = await launch();
  await newPage(window, 'Target', 'First line');
  for (let i = 0; i < 40; i++) await window.keyboard.press('Enter');
  await window.keyboard.type('Deep block');
  const block = editor(window).locator('p').filter({ hasText: 'Deep block' });
  const blockId = await block.getAttribute('data-id');
  expect(blockId).toBeTruthy();

  await window.getByRole('button', { name: 'Page options' }).click();
  await window.getByRole('menuitem', { name: 'Copy link' }).click();
  const link = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(link).toMatch(/^workspace:\/\/page\/[0-9a-f-]+$/);

  await newPage(window, 'Elsewhere');
  // Links reach the main process the way a clicked link in a page does.
  await window.evaluate((url) => globalThis.open(url), `${link}#${blockId}`);
  await expect(title(window)).toHaveValue('Target');
  await expect(block).toBeInViewport();
  expect(await block.evaluate((el) => el.getAnimations().map((a) => a.id))).toContain('ws-flash');

  // Ctrl+Enter in quick find opens the page in a new window.
  await window.keyboard.press('Control+k');
  await window.getByTestId('quick-find').getByLabel('Search pages').fill('Elsewhere');
  const opened = app.waitForEvent('window');
  await window.keyboard.press('Control+Enter');
  const second = await opened;
  await expect(second.getByLabel('Page title')).toHaveValue('Elsewhere');
  await expect(title(window)).toHaveValue('Target');
});
