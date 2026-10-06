import type { Page } from '@playwright/test';
import { editor, expect, quit, settle, test } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}
const openPage = (window: Page, title: string) =>
  window.getByRole('treeitem').filter({ hasText: title }).first().click();
const pageMenu = async (window: Page) => {
  await window.getByRole('button', { name: 'Page options' }).click();
  return window.getByTestId('page-menu');
};

test('backlinks: mentions show under the title, open the linking block, follow edits', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window, 'Gripper');
  await window.keyboard.type('Two-finger design.');
  await newPage(window, 'Arm notes');
  await window.keyboard.type('Intro');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Uses the @gripp');
  await expect(window.getByTestId('mention-menu').getByRole('option').first()).toHaveText(
    /Gripper/,
  );
  await window.keyboard.press('Enter');
  await window.keyboard.type(' for pick and place');

  await openPage(window, 'Gripper');
  const backlinks = window.getByTestId('backlinks');
  await expect(backlinks.getByRole('button', { name: '1 backlink' })).toBeVisible({
    timeout: 10_000,
  });
  await backlinks.getByRole('button', { name: '1 backlink' }).click();
  const item = window.getByTestId('backlink');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Arm notes');
  await expect(item.getByTestId('backlink-snippet')).toHaveText('Uses the @ for pick and place');
  await item.click();
  await expect(window.getByLabel('Page title')).toHaveValue('Arm notes');

  // Shown expanded under the title, as a page setting.
  await openPage(window, 'Gripper');
  const menu = await pageMenu(window);
  await menu.getByRole('menuitem', { name: /Show backlinks/ }).click();
  await window.getByRole('menuitemradio', { name: 'Expanded' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('backlinks-list').getByTestId('backlink')).toHaveText(
    /Arm notes/,
  );

  // Deleting the mention removes the backlink.
  await openPage(window, 'Arm notes');
  await editor(window).locator('p').filter({ hasText: 'Uses the' }).click();
  await settle(window);
  await window.keyboard.press('End');
  await window.keyboard.press('Shift+Home');
  await window.keyboard.press('Backspace');
  await expect(editor(window).getByTestId('mention')).toHaveCount(0);
  await openPage(window, 'Gripper');
  await expect(window.getByTestId('backlinks')).toHaveCount(0, { timeout: 10_000 });
});

test('page history: versions before editing sessions, preview with changes, restore and undo', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Log');
  await window.keyboard.type('First draft');
  // The next editing session (1.5 s apart in tests) starts with a saved version.
  await window.waitForTimeout(1800);
  await window.keyboard.type(', revised');
  await expect(editor(window)).toHaveText('First draft, revised');

  let menu = await pageMenu(window);
  await menu.getByRole('menuitem', { name: 'Page history' }).click();
  const dialog = window.getByTestId('history-dialog');
  await expect(dialog.getByTestId('history-version').first()).toBeVisible();
  await expect(dialog.getByTestId('history-version').first()).toContainText('Before editing');
  await expect(dialog.getByTestId('history-preview')).toContainText('First draft');
  await expect(dialog.getByTestId('history-preview')).not.toContainText('revised');
  await expect(dialog.getByTestId('history-diff')).toHaveText(/^1 changed · 0 removed since/);

  await dialog.getByRole('button', { name: 'Restore this version' }).click();
  await expect(editor(window).first()).toHaveText('First draft');
  await dialog.getByRole('button', { name: 'Undo restore' }).click();
  await expect(editor(window).first()).toHaveText('First draft, revised');
  await window.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await quit(first.app);
  ({ window } = await launch());
  await openPage(window, 'Log');
  await expect(editor(window)).toHaveText('First draft, revised');
  menu = await pageMenu(window);
  await menu.getByRole('menuitem', { name: 'Page history' }).click();
  // The editing-session version and the one taken before the restore are kept.
  const versions = window.getByTestId('history-version');
  await expect(versions.filter({ hasText: 'Before a restore' })).toHaveCount(1);
  await expect(versions.filter({ hasText: 'Before editing' }).first()).toBeVisible();
});
