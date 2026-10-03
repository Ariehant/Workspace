import type { Page } from '@playwright/test';
import { editor, expect, quit, sidebarTitles, test, waitForIndexed } from './helpers';

/** 4×3 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

const article = (window: Page) => window.getByTestId('page-article');
const cover = (window: Page) => window.getByTestId('page-cover');

async function openPageMenu(window: Page) {
  await window.getByRole('button', { name: 'Page options' }).click();
  return window.getByTestId('page-menu');
}

test('page icon: random, emoji picker, uploaded image, remove', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Rover');
  await window.getByLabel('Page title').hover();
  await window.getByRole('button', { name: 'Add icon' }).click();
  const iconButton = window.getByRole('button', { name: 'Change page icon' });
  await expect(iconButton).toHaveText(/\S/u);

  await iconButton.click();
  const picker = window.getByTestId('icon-picker');
  await picker.getByLabel('Search emoji').fill('robot');
  await picker.getByRole('button', { name: 'robot', exact: true }).click();
  await expect(iconButton).toHaveText('🤖');
  const row = window.getByRole('treeitem').filter({ hasText: 'Rover' });
  await expect(row).toContainText('🤖');

  await iconButton.click();
  await picker.getByRole('tab', { name: 'Upload' }).click();
  await picker
    .getByLabel('Upload icon image')
    .setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(iconButton.locator('img')).toHaveAttribute('src', /^ws-file:\/\/[0-9a-f]{64}\.png$/);
  await expect(row.locator('img')).toHaveAttribute('src', /^ws-file:/);

  await iconButton.click();
  await picker.getByRole('button', { name: 'Remove' }).click();
  await expect(iconButton).toHaveCount(0);
});

test('page cover: add, change, upload, reposition, remove; kept after restart', async ({
  launch,
}) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Covered');
  await window.getByLabel('Page title').hover();
  await window.getByRole('button', { name: 'Add cover' }).click();
  await expect(cover(window)).toHaveAttribute('data-kind', 'gradient');

  await cover(window).hover();
  await window.getByRole('button', { name: 'Change cover' }).click();
  await window.getByTestId('cover-picker').getByRole('button', { name: 'blue color' }).click();
  await expect(cover(window)).toHaveAttribute('data-kind', 'color');

  await cover(window).hover();
  await window.getByRole('button', { name: 'Change cover' }).click();
  await window.getByTestId('cover-picker').getByRole('tab', { name: 'Upload' }).click();
  await window
    .getByLabel('Upload cover image')
    .setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: PNG });
  await expect(cover(window)).toHaveAttribute('data-kind', 'file');
  await expect(cover(window)).toHaveCSS('background-image', /ws-file:\/\//);

  // Drag the image up to show more of its bottom, then save.
  await cover(window).hover();
  await window.getByRole('button', { name: 'Reposition' }).click();
  const box = (await cover(window).boundingBox())!;
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await window.mouse.down();
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - box.height * 0.3, {
    steps: 5,
  });
  await window.mouse.up();
  await window.getByRole('button', { name: 'Save position' }).click();
  await expect(cover(window)).toHaveCSS('background-position', '50% 80%');
  await waitForIndexed(window, 'Covered');

  await quit(launched.app);
  ({ window } = await launch());
  await expect(cover(window)).toHaveAttribute('data-kind', 'file');
  await expect(cover(window)).toHaveCSS('background-position', '50% 80%');
  await cover(window).hover();
  await window.getByRole('button', { name: 'Remove' }).click();
  await expect(cover(window)).toHaveCount(0);
});

test('page menu: font, small text, full width and word count', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Styled');
  await window.keyboard.type('One two three four five.');
  const prose = editor(window);

  let menu = await openPageMenu(window);
  await expect(menu.getByTestId('word-count')).toHaveText('Word count: 5');
  await menu.getByRole('button', { name: /Serif/ }).click();
  await expect(prose).toHaveCSS('font-family', /serif/i);
  await window.keyboard.press('Escape');

  menu = await openPageMenu(window);
  await menu.getByRole('menuitem', { name: 'Small text' }).click();
  await expect(prose).toHaveCSS('font-size', '14px');
  await menu.getByRole('menuitem', { name: 'Full width' }).click();
  await expect(article(window)).toHaveAttribute('data-full-width', 'true');
  await window.keyboard.press('Escape');
  const width = (await article(window).boundingBox())!.width;
  expect(width).toBeGreaterThan(950);
});

test('locked pages cannot be edited until unlocked', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Spec');
  await window.keyboard.type('Final values');
  const menu = await openPageMenu(window);
  await menu.getByRole('menuitem', { name: 'Lock page' }).click();
  await window.keyboard.press('Escape');

  await expect(editor(window)).toHaveAttribute('contenteditable', 'false');
  await expect(window.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await editor(window).click();
  await window.keyboard.type('XYZ');
  await expect(editor(window)).toHaveText('Final values');

  await window.getByRole('button', { name: 'Locked' }).click();
  await expect(editor(window)).toHaveAttribute('contenteditable', 'true');
});

test('duplicate copies sub-pages and content, with links pointing at the copies', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window, 'Robot');
  await window.keyboard.type('Robot overview');
  await window.keyboard.press('Enter');
  await window.keyboard.type('/page');
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
  await window.getByLabel('Page title').fill('Arm');
  await window.getByRole('tree').getByText('Robot', { exact: true }).click();
  await waitForIndexed(window, 'overview');

  const menu = await openPageMenu(window);
  await menu.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Robot (1)');
  await expect(editor(window).locator('p').first()).toHaveText('Robot overview');
  await expect(sidebarTitles(window)).toContainText(['Robot', 'Arm', 'Robot (1)']);

  // The page link in the copy opens the copied sub-page, not the original.
  await editor(window).getByTestId('page-link').click();
  await expect(window.getByLabel('Page title')).toHaveValue('Arm');
  await expect(window.getByRole('list', { name: 'Breadcrumb' })).toContainText('Robot (1)');
});

test('move to puts a page under another', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Parts');
  await newPage(window, 'Motors');
  const menu = await openPageMenu(window);
  await menu.getByRole('menuitem', { name: 'Move to', exact: true }).click();
  const dialog = window.getByTestId('move-dialog');
  await expect(dialog.getByRole('option').first()).toHaveText('Top level');
  // A page can't be moved into itself.
  await expect(dialog.getByRole('option', { name: 'Motors' })).toHaveCount(0);
  await dialog.getByLabel('Search for a page to move to').fill('part');
  await dialog.getByLabel('Search for a page to move to').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(window.getByRole('list', { name: 'Breadcrumb' })).toHaveText(/Parts\/Motors/);
});
