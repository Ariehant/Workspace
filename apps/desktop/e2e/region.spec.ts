/**
 * Phase 7 M3: Language and region. The region sets how dates, times and numbers look (and the
 * first day of the week); each can be chosen on its own, a database property's own format
 * wins, and the setting is kept.
 */
import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, popover } from './db';
import { expect, quit, test } from './helpers';

async function openRegion(window: Page) {
  await window.getByRole('button', { name: /workspace menu/i }).click();
  await window.getByRole('menuitem', { name: 'Language and region…' }).click();
  const dialog = window.getByTestId('region-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the region sets dates, times, numbers and the week; each can be chosen', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Shipments');
  await addProperty(window, 'Date', 'Due');
  await addProperty(window, 'Number', 'Weight');
  await addRow(window, 'Gearbox');
  await window.keyboard.press('Escape');

  // A date with a time, and a number with thousands.
  await (await cell(window, 'Gearbox', 'Due')).click();
  await popover(window).getByLabel('Start date').fill('2026-11-17');
  await popover(window).getByLabel('Include time').check();
  await popover(window).getByLabel('Start date').fill('2026-11-17T15:05');
  await window.keyboard.press('Escape');
  await (await cell(window, 'Gearbox', 'Weight')).click();
  await window.keyboard.type('1234.5');
  await window.keyboard.press('Enter');

  // The United States (the test machine's locale) by default.
  const due = async () => (await cell(window, 'Gearbox', 'Due')).innerText();
  await expect.poll(due).toBe('Nov 17, 2026 3:05 PM');
  await expect(await cell(window, 'Gearbox', 'Weight')).toHaveText('1234.5');

  // The United Kingdom: day first, 24-hour, weeks from Monday.
  let dialog = await openRegion(window);
  await expect(dialog.getByLabel('Language')).toHaveValue('en');
  await dialog.getByLabel('Region').selectOption({ label: 'United Kingdom' });
  await expect(dialog.getByLabel('Time format')).toContainText('Automatic (24-hour)');
  await expect(dialog.getByTestId('region-preview')).toContainText('1,234,567.89');
  await window.keyboard.press('Escape');
  await expect.poll(due).toBe('17 Nov 2026 15:05');

  // Germany: the decimal comma, also in plain numbers.
  dialog = await openRegion(window);
  await dialog.getByLabel('Region').selectOption({ label: 'Germany' });
  await expect(dialog.getByTestId('region-preview')).toContainText('1.234.567,89');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Gearbox', 'Weight')).toHaveText('1234,5');

  // Each format on its own: 12-hour time and Year/Month/Day in Germany.
  dialog = await openRegion(window);
  await dialog.getByLabel('Time format').selectOption('12h');
  await dialog.getByLabel('Date format').selectOption('ymd');
  await window.keyboard.press('Escape');
  await expect.poll(due).toBe('2026/11/17 3:05 PM');

  // A calendar view starts its weeks on Monday (Germany), unless the view says otherwise.
  const database = window.getByTestId('database-view');
  await database.getByRole('button', { name: 'Add a view' }).click();
  await window.getByTestId('add-view-menu').getByRole('menuitem', { name: 'Calendar' }).click();
  const calendar = window.getByTestId('calendar-view');
  await expect(calendar.locator('.grid-cols-7').first()).toHaveText(/^Mon/);

  // Kept after a restart.
  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Shipments' }).click();
  await window.getByTestId('database-view').getByRole('tab', { name: 'Table' }).click();
  await expect.poll(due).toBe('2026/11/17 3:05 PM');
  dialog = await openRegion(window);
  await expect(dialog.getByLabel('Region')).toHaveValue('DE');
  await expect(dialog.getByLabel('Time format')).toHaveValue('12h');

  // Back to automatic.
  await dialog.getByLabel('Region').selectOption('');
  await dialog.getByLabel('Time format').selectOption('');
  await dialog.getByLabel('Date format').selectOption('');
  await window.keyboard.press('Escape');
  await expect.poll(due).toBe('Nov 17, 2026 3:05 PM');
});
