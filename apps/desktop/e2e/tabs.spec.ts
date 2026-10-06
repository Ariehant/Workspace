import type { Page } from '@playwright/test';
import { editor, expect, quit, test } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}
const sidebarItem = (window: Page, title: string) =>
  window.getByRole('tree', { name: 'Pages' }).getByRole('treeitem').filter({ hasText: title });
const tabs = (window: Page) => window.getByTestId('tab-bar').getByRole('tab');
const activeTab = (window: Page) =>
  window.getByTestId('tab-bar').getByRole('tab', { selected: true });
const title = (window: Page) => window.getByLabel('Page title');

test('tabs: open with Ctrl+click and middle-click, switch, reorder, close, restored after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Alpha');
  await newPage(window, 'Beta');
  await newPage(window, 'Gamma');
  // One tab: no tab bar.
  await expect(window.getByTestId('tab-bar')).toHaveCount(0);

  // Ctrl+click opens the page in a new tab after the current one.
  await sidebarItem(window, 'Alpha').click({ modifiers: ['Control'] });
  await expect(tabs(window).getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha']);
  await expect(activeTab(window)).toHaveText('Alpha');
  await expect(title(window)).toHaveValue('Alpha');

  // Each tab keeps its own history.
  await sidebarItem(window, 'Beta').click();
  await expect(activeTab(window)).toHaveText('Beta');
  await window.keyboard.press('Control+Tab');
  await expect(activeTab(window)).toHaveText('Gamma');
  await expect(title(window)).toHaveValue('Gamma');
  await window.keyboard.press('Control+Shift+Tab');
  await expect(title(window)).toHaveValue('Beta');
  await window.keyboard.press('Alt+ArrowLeft');
  await expect(title(window)).toHaveValue('Alpha');
  await expect(tabs(window).getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha']);

  // Middle-click opens a tab too; Ctrl+T opens one with quick find.
  await sidebarItem(window, 'Beta').click({ button: 'middle' });
  await expect(tabs(window).getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha', 'Beta']);
  await window.keyboard.press('Control+t');
  const find = window.getByTestId('quick-find');
  await expect(find.getByLabel('Search pages')).toBeFocused();
  await window.keyboard.type('Gamma');
  await expect(find.getByTestId('quick-find-result').first()).toContainText('Gamma');
  await window.keyboard.press('Enter');
  await expect(tabs(window)).toHaveCount(4);
  await expect(activeTab(window)).toHaveText('Gamma');

  // Drag a tab to reorder.
  await tabs(window).nth(3).dragTo(tabs(window).nth(0));
  await expect(tabs(window).getByTestId('tab-title')).toHaveText([
    'Gamma',
    'Gamma',
    'Alpha',
    'Beta',
  ]);
  await expect(activeTab(window)).toHaveCount(1);

  // Close: Ctrl+W, the close button, and middle-click.
  await window.keyboard.press('Control+w');
  await expect(tabs(window)).toHaveCount(3);
  await tabs(window)
    .filter({ hasText: 'Beta' })
    .getByRole('button', { name: 'Close Beta' })
    .click();
  await expect(tabs(window).getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha']);
  await tabs(window).nth(1).click();
  await expect(title(window)).toHaveValue('Alpha');

  await quit(first.app);
  ({ window } = await launch());
  await expect(tabs(window).getByTestId('tab-title')).toHaveText(['Gamma', 'Alpha']);
  await expect(activeTab(window)).toHaveText('Alpha');
  await expect(title(window)).toHaveValue('Alpha');
  // History came back too.
  await window.keyboard.press('Alt+ArrowRight');
  await expect(title(window)).toHaveValue('Beta');

  await tabs(window).nth(0).click({ button: 'middle' });
  await expect(window.getByTestId('tab-bar')).toHaveCount(0);
  await expect(title(window)).toHaveValue('Beta');
});

test('tabs: each tab keeps its scroll position', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Short');
  await newPage(window, 'Long');
  for (let i = 0; i < 60; i++) {
    await window.keyboard.type(`Line ${i}`);
    await window.keyboard.press('Enter');
  }
  const scroll = window.getByTestId('page-scroll');
  await scroll.evaluate((el) => (el.scrollTop = 600));
  await sidebarItem(window, 'Short').click({ modifiers: ['Control'] });
  await expect(title(window)).toHaveValue('Short');
  await tabs(window).nth(0).click();
  await expect(title(window)).toHaveValue('Long');
  await expect
    .poll(() => scroll.evaluate((el) => Math.round(el.scrollTop)))
    .toBeGreaterThanOrEqual(590);
});
