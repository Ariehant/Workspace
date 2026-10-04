import type { Locator, Page } from '@playwright/test';
import { expect } from './helpers';

/** A new full-page database named `title` (via "Get started with: Database"). */
export async function newDatabase(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByTestId('get-started').getByRole('button', { name: 'Database' }).click();
  await expect(table(window)).toBeVisible();
}

export const table = (window: Page) => window.getByTestId('table-view');
export const rows = (window: Page) => table(window).getByTestId('table-row');
export const titles = (window: Page) => table(window).getByTestId('row-title');
export const header = (window: Page, name: string) =>
  table(window).getByTestId('column-header').filter({ hasText: name });

/** The cell of row `rowTitle` under column `column`. */
export async function cell(window: Page, rowTitle: string, column: string): Promise<Locator> {
  const headers = await table(window).getByTestId('column-header').allInnerTexts();
  const index = headers.findIndex((h) => h.trim() === column);
  expect(index, `column ${column}`).toBeGreaterThanOrEqual(0);
  return rows(window)
    .filter({ has: window.getByTestId('row-title').getByText(rowTitle, { exact: true }) })
    .getByTestId('table-cell')
    .nth(index);
}

export async function addRow(window: Page, title: string) {
  await table(window).getByTestId('table-new-row').last().click();
  await window.keyboard.type(title);
  await window.keyboard.press('Enter');
  await expect(titles(window).getByText(title, { exact: true })).toBeVisible();
}

export async function addProperty(window: Page, type: string, name: string) {
  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: type, exact: true })
    .click();
  const input = window.getByTestId('property-menu').getByLabel('Property name');
  await input.fill(name);
  await input.press('Enter');
  await expect(header(window, name)).toBeVisible();
}

export const popover = (window: Page) => window.getByTestId('cell-popover');
