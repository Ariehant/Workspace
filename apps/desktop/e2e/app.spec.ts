import { editor, expect, quit, sidebarTitles, test, waitForIndexed } from './helpers';

test('first launch shows the getting started page', async ({ launch }) => {
  const { window } = await launch();
  await expect(sidebarTitles(window)).toHaveText(['Getting started']);
  await expect(window.getByLabel('Page title')).toHaveValue('Getting started');
  await expect(editor(window)).toContainText('Welcome! This is your workspace.');
  await expect(editor(window).locator('h2')).toHaveText(['The basics', 'Coming next']);
});

test('pages and their content survive a restart', async ({ launch }, testInfo) => {
  const launched = await launch();
  const { app } = launched;
  let { window } = launched;

  await window.getByRole('button', { name: 'New page' }).click();
  const title = window.getByLabel('Page title');
  await expect(title).toBeFocused();
  await title.fill('Robot arm calibration');
  await title.press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type('# Joint offsets');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Measured with the dial gauge.');
  await window.keyboard.press('Enter');
  await window.keyboard.type('- shoulder: 0.42 deg');

  // A sub-page, created from the sidebar.
  const row = window.getByRole('treeitem').filter({ hasText: 'Robot arm calibration' }).first();
  await row.hover();
  await row.getByRole('button', { name: 'Add a page inside' }).click();
  await window.getByLabel('Page title').fill('Wrist joint');
  await waitForIndexed(window, 'Wrist');
  await window.getByRole('tree').getByText('Robot arm calibration').click();
  await waitForIndexed(window, 'dial gauge');
  await window.screenshot({ path: testInfo.outputPath('before-restart.png') });

  await quit(app);
  ({ window } = await launch());

  // Reopens on the last page, with the tree expanded as it was left.
  await expect(window.getByLabel('Page title')).toHaveValue('Robot arm calibration');
  await expect(sidebarTitles(window)).toHaveText([
    'Getting started',
    'Robot arm calibration',
    'Wrist joint',
  ]);
  await expect(editor(window).locator('h1')).toHaveText('Joint offsets');
  await expect(editor(window).locator('p').first()).toHaveText('Measured with the dial gauge.');
  await expect(editor(window).locator('ul li')).toHaveText('shoulder: 0.42 deg');
  await window.screenshot({ path: testInfo.outputPath('after-restart.png') });
});

test('edits in one window appear in another', async ({ launch }) => {
  const { app, window: first } = await launch();
  const secondPromise = app.waitForEvent('window');
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.getMenuItemById('new-window')?.click(),
  );
  const second = await secondPromise;
  await second.getByRole('tree', { name: 'Pages' }).waitFor();

  await second.getByLabel('Page title').fill('Renamed elsewhere');
  await expect(sidebarTitles(first)).toHaveText(['Renamed elsewhere']);

  await editor(first).click();
  await first.keyboard.press('Control+End');
  await first.keyboard.type(' Typed in window one.');
  await expect(editor(second)).toContainText('Typed in window one.');
});

test('moving a page to the trash hides it and its sub-pages', async ({ launch }) => {
  const { window } = await launch();
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill('Scratch');

  const row = window.getByRole('treeitem').filter({ hasText: 'Scratch' }).first();
  await row.hover();
  await row.getByRole('button', { name: 'Delete, duplicate, and more…' }).click();
  await window.getByRole('menuitem', { name: 'Move to Trash' }).click();

  await expect(sidebarTitles(window)).toHaveText(['Getting started']);
  await expect(window.getByText('This page is in Trash.')).toBeVisible();
  await window.getByRole('button', { name: 'Restore page' }).click();
  await expect(sidebarTitles(window)).toHaveText(['Getting started', 'Scratch']);
});

test('the theme choice applies immediately and is remembered', async ({ launch }, testInfo) => {
  const launched = await launch();
  const { app } = launched;
  let { window } = launched;
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');

  await quit(app);
  ({ window } = await launch());
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  await window.screenshot({ path: testInfo.outputPath('dark.png') });
});
