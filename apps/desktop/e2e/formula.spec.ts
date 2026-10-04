import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, header, newDatabase, table, titles } from './db';
import { expect, quit, test } from './helpers';

const editor = (window: Page) => window.getByTestId('formula-editor');
const input = (window: Page) => editor(window).getByLabel('Formula');

/** Parts with Price × Qty: A = 2 × 3, B = 10 × 1. */
async function seed(window: Page) {
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Number', 'Price');
  await addProperty(window, 'Number', 'Qty');
  for (const [title, price, qty] of [
    ['A', '2', '3'],
    ['B', '10', '1'],
  ] as const) {
    await addRow(window, title);
    await (await cell(window, title, 'Price')).click();
    await window.keyboard.type(price);
    await window.keyboard.press('Tab');
    await window.keyboard.press('Enter');
    await window.keyboard.type(qty);
    await window.keyboard.press('Enter');
  }
  await window.keyboard.press('Escape');
}

async function addFormula(window: Page, name: string, expression: string) {
  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: 'Formula', exact: true })
    .click();
  await expect(editor(window)).toBeVisible();
  await input(window).fill(expression);
  await editor(window).getByRole('button', { name: 'Done' }).click();
  await expect(editor(window)).toHaveCount(0);
  if (name !== 'Formula') {
    await header(window, 'Formula').click();
    const field = window.getByTestId('property-menu').getByLabel('Property name');
    await field.fill(name);
    await field.press('Enter');
  }
}

test('formula editor: autocomplete, live preview, errors; values sort, filter and survive a restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seed(window);

  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: 'Formula', exact: true })
    .click();
  await expect(editor(window)).toBeVisible();

  // Property names complete inside prop("…"), properties and functions from a word.
  await input(window).pressSequentially('prop("Pri');
  await expect(
    editor(window).getByTestId('formula-suggestions').getByRole('option').first(),
  ).toHaveText('Price');
  await window.keyboard.press('Tab');
  await expect(input(window)).toHaveValue('prop("Price")');
  await input(window).pressSequentially(' * qt');
  await window.keyboard.press('Enter');
  await expect(input(window)).toHaveValue('prop("Price") * prop("Qty")');
  await expect(editor(window).getByTestId('formula-preview-value')).toHaveText('6');
  await expect(editor(window).getByTestId('formula-type')).toHaveText('number');

  // Function docs while typing; errors point at the problem and block saving.
  await input(window).pressSequentially(' + roun');
  await expect(editor(window).getByTestId('formula-docs-signature')).toHaveText(
    /^round\(number, number\?\)/,
  );
  await window.keyboard.press('Enter');
  await expect(input(window)).toHaveValue('prop("Price") * prop("Qty") + round()');
  await expect(editor(window).getByTestId('formula-error')).toContainText(
    'round() takes 1 to 2 arguments',
  );
  await expect(editor(window).getByRole('button', { name: 'Done' })).toBeDisabled();
  await input(window).fill('prop("Price") * prop("Qty")');
  await window.keyboard.press('Control+Enter');
  await expect(editor(window)).toHaveCount(0);

  await expect(await cell(window, 'A', 'Formula')).toHaveText('6');
  await expect(await cell(window, 'B', 'Formula')).toHaveText('10');

  // Values follow edits, and formulas follow renamed properties.
  await (await cell(window, 'A', 'Qty')).click();
  await window.keyboard.press('Control+a');
  await window.keyboard.type('5');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'A', 'Formula')).toHaveText('10');
  await header(window, 'Price').click();
  const name = window.getByTestId('property-menu').getByLabel('Property name');
  await name.fill('Unit price');
  await name.press('Enter');
  await expect(await cell(window, 'B', 'Formula')).toHaveText('10');

  // Sorting and filtering use the number result.
  await (await cell(window, 'A', 'Qty')).click();
  await window.keyboard.press('Control+a');
  await window.keyboard.type('4');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await header(window, 'Formula').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Sort descending' })
    .click();
  await expect(titles(window)).toHaveText(['B', 'A']);
  await header(window, 'Formula').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: 'Filter' }).click();
  const filter = window.getByTestId('filter-popover');
  await filter.getByLabel('Condition').selectOption('lt');
  await filter.getByLabel('Filter value').fill('9');
  await expect(titles(window)).toHaveText(['A']);
  await window.keyboard.press('Escape');

  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await expect(titles(window)).toHaveText(['A']);
  await expect(await cell(window, 'A', 'Formula')).toHaveText('8');
  await header(window, 'Formula').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: 'Edit formula' }).click();
  await expect(input(window)).toHaveValue('prop("Unit price") * prop("Qty")');
});

test('formula results: checkboxes, dates with formats, text, row pages, broken references', async ({
  launch,
}) => {
  const { window } = await launch();
  await seed(window);

  await addFormula(window, 'Bulk', 'prop("Qty") > 2');
  await expect((await cell(window, 'A', 'Bulk')).getByRole('checkbox')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect((await cell(window, 'B', 'Bulk')).getByRole('checkbox')).toHaveAttribute(
    'aria-checked',
    'false',
  );

  await addFormula(window, 'Ship', 'dateAdd(parseDate("2026-01-01"), prop("Qty"), "days")');
  await expect(await cell(window, 'A', 'Ship')).toHaveText('Jan 4, 2026');
  await header(window, 'Ship').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: /Date format/ })
    .click();
  await window.getByRole('menuitemradio', { name: 'Year/Month/Day' }).press('Enter');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'A', 'Ship')).toHaveText('2026/01/04');

  await addFormula(window, 'Label', 'prop("Name") + " × " + format(prop("Qty"))');
  await expect(await cell(window, 'B', 'Label')).toHaveText('B × 1');

  // On a row page, clicking a formula opens its editor with this row's preview.
  await (await cell(window, 'B', 'Name')).hover();
  await table(window).getByRole('button', { name: 'Open', exact: true }).click();
  const peek = window.getByTestId('row-peek');
  await expect(peek.getByTestId('property-row').filter({ hasText: 'Label' })).toContainText(
    'B × 1',
  );
  await peek.getByRole('button', { name: 'Edit Label' }).click();
  await expect(editor(window).getByTestId('formula-preview-value')).toHaveText('B × 1');
  await editor(window).getByRole('button', { name: 'Cancel' }).click();
  await peek.getByRole('button', { name: 'Close' }).click();

  // Deleting a property a formula uses flags the formula.
  await header(window, 'Qty').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Delete property' })
    .click();
  await expect(header(window, 'Label').getByLabel('Formula error')).toBeVisible();
  await expect(await cell(window, 'B', 'Label')).toHaveText('');
});
