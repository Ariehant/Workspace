import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, popover, table, titles } from './db';
import { editor, expect, quit, test } from './helpers';

const db = (window: Page) => window.getByTestId('database-view').first();
const peek = (window: Page) => window.getByTestId('row-peek');

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

const templatesMenu = (window: Page) => window.getByTestId('templates-menu');
async function openTemplates(window: Page) {
  await db(window).getByRole('button', { name: 'Choose a template' }).click();
  await expect(templatesMenu(window)).toBeVisible();
}

test('templates: create and edit one, new pages from it, defaults, apply to an empty page', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Bugs');
  await addProperty(window, 'Select', 'Severity');
  await addRow(window, 'Existing');

  // A new template opens for editing, marked as a template.
  await openTemplates(window);
  await templatesMenu(window).getByRole('button', { name: 'New template' }).click();
  await expect(peek(window).getByTestId('template-banner')).toContainText(
    'editing a template in Bugs',
  );
  await peek(window).getByLabel('Page title').fill('Bug report');
  await peek(window).getByRole('button', { name: 'Edit Severity' }).click();
  await popover(window).getByLabel('Search for an option').fill('High');
  await window.keyboard.press('Enter');
  await expect(popover(window)).toHaveCount(0);
  await peek(window).getByTestId('page-editor').click();
  await window.keyboard.type('Steps to reproduce');
  await peek(window).getByRole('button', { name: 'Close' }).click();
  // Templates aren't rows.
  await expect(titles(window)).toHaveText(['Existing']);

  // New from the template: title, values and content are copied.
  await openTemplates(window);
  await expect(templatesMenu(window).getByTestId('template-item')).toHaveText([
    /Bug report/,
    /Empty page/,
  ]);
  await templatesMenu(window).getByRole('button', { name: 'Bug report', exact: true }).click();
  await expect(peek(window).getByLabel('Page title')).toHaveValue('Bug report');
  await expect(peek(window).getByTestId('template-banner')).toHaveCount(0);
  await expect(peek(window).getByTestId('page-editor')).toContainText('Steps to reproduce');
  await peek(window).getByLabel('Page title').fill('Gripper slips');
  await peek(window).getByRole('button', { name: 'Close' }).click();
  await expect(await cell(window, 'Gripper slips', 'Severity')).toHaveText('High');

  // Make it the default: "New" (and "+ New" rows) start from it.
  await openTemplates(window);
  await templatesMenu(window)
    .getByTestId('template-item')
    .filter({ hasText: 'Bug report' })
    .hover();
  await templatesMenu(window).getByRole('button', { name: 'Bug report options' }).click();
  await window.getByRole('menuitem', { name: 'Set as default for all views' }).click();
  await expect(templatesMenu(window).getByTestId('template-item').first()).toContainText('Default');
  await window.keyboard.press('Escape');
  await table(window).getByTestId('table-new-row').click();
  await window.keyboard.press('Control+a');
  await window.keyboard.type('Arm drifts');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'Arm drifts', 'Severity')).toHaveText('High');

  // An empty page can start from a template too.
  await openTemplates(window);
  await templatesMenu(window).getByRole('button', { name: 'Empty page', exact: true }).click();
  await peek(window).getByLabel('Page title').fill('Blank');
  await peek(window)
    .getByTestId('template-picker')
    .getByRole('button', { name: 'Bug report', exact: true })
    .click();
  await expect(peek(window).getByTestId('page-editor')).toContainText('Steps to reproduce');
  await expect(peek(window).getByLabel('Page title')).toHaveValue('Blank');
  await peek(window).getByRole('button', { name: 'Close' }).click();
  await expect(await cell(window, 'Blank', 'Severity')).toHaveText('High');

  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Bugs' }).click();
  await expect(titles(window)).toHaveText(['Existing', 'Gripper slips', 'Arm drifts', 'Blank']);
  await openTemplates(window);
  await expect(templatesMenu(window).getByTestId('template-item').first()).toContainText('Default');
});

test('linked views: their own views and filters over the source rows', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Parts');
  for (const t of ['Servo', 'Gearbox', 'Sensor']) await addRow(window, t);

  await newPage(window, 'Build log');
  await slash(window, 'linked view');
  await window.getByTestId('page-picker').getByRole('option', { name: /Parts/ }).click();
  const linked = window.getByTestId('linked-database-block');
  await expect(linked.getByTestId('linked-badge')).toBeVisible();
  await expect(linked.getByTestId('row-title')).toHaveText(['Servo', 'Gearbox', 'Sensor']);

  // Sort the linked view; the source's view stays as it was.
  await linked.getByTestId('column-header').filter({ hasText: 'Name' }).click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Sort ascending' })
    .click();
  await expect(linked.getByTestId('row-title')).toHaveText(['Gearbox', 'Sensor', 'Servo']);
  // Rows added here are the source's rows.
  await linked.getByTestId('table-new-row').click();
  await window.keyboard.type('Motor');
  await window.keyboard.press('Enter');
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await expect(titles(window)).toHaveText(['Servo', 'Gearbox', 'Sensor', 'Motor']);
});

test('simple tables turn into databases and back', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Inventory');
  await slash(window, 'table');
  const simple = editor(window).locator('table');
  for (const text of ['Part', 'Qty', '', 'Servo', '4', '', 'Gearbox', '1']) {
    if (text) await window.keyboard.type(text);
    await window.keyboard.press('Tab');
  }
  await window.getByTestId('table-menu').getByRole('button', { name: 'Header row' }).click();
  await expect(simple.locator('th').first()).toHaveText('Part');

  await simple.hover();
  const grip = window
    .getByTestId('block-handle')
    .getByRole('button', { name: 'Drag to move, click to open menu' });
  await grip.click();
  await window.getByRole('menuitem', { name: 'Turn into database' }).click();
  const inline = window.getByTestId('inline-database');
  await expect(inline.getByTestId('row-title')).toHaveText(['Servo', 'Gearbox']);
  await expect(inline.getByTestId('column-header')).toHaveText(['Part', 'Qty', 'Column 3']);
  await expect(editor(window).locator('table')).toHaveCount(0);

  await inline.getByTestId('inline-database-title').hover();
  await grip.click();
  await window.getByRole('menuitem', { name: 'Turn into simple table' }).click();
  await expect(window.getByTestId('inline-database')).toHaveCount(0);
  await expect(editor(window).locator('table tr')).toHaveCount(3);
  await expect(editor(window).locator('table th')).toHaveText(['Part', 'Qty', 'Column 3']);
  await expect(editor(window).locator('table tr').nth(1).locator('td').first()).toHaveText('Servo');
});

test('lock views and properties; a description under the title', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Parts');
  await addRow(window, 'Servo');
  const options = async () => {
    await db(window).getByRole('button', { name: 'Database options' }).click();
    return window.getByTestId('database-options');
  };

  await (await options()).getByRole('menuitem', { name: 'Add description' }).click();
  await db(window).getByLabel('Database description').fill('Parts for the arm');
  await db(window).getByLabel('Database description').press('Enter');
  await expect(db(window).getByLabel('Database description')).toHaveValue('Parts for the arm');

  await (await options()).getByRole('menuitem', { name: /Lock properties/ }).click();
  await window.keyboard.press('Escape');
  await expect(table(window).getByRole('button', { name: 'Add a property' })).toHaveCount(0);
  await table(window).getByTestId('column-header').filter({ hasText: 'Tags' }).click();
  await expect(
    window.getByTestId('property-menu').getByRole('menuitem', { name: 'Delete property' }),
  ).toHaveCount(0);
  await expect(window.getByTestId('property-menu').getByLabel('Property name')).toHaveAttribute(
    'readonly',
  );
  await window.keyboard.press('Escape');

  await (await options()).getByRole('menuitem', { name: /Lock views/ }).click();
  await window.keyboard.press('Escape');
  await expect(db(window).getByRole('button', { name: 'Add a view' })).toHaveCount(0);
  // Filters still work, for this window only (Phase 6 M1): the view isn't changed.
  await db(window).getByRole('button', { name: 'Filter', exact: true }).click();
  await window.getByTestId('property-picker').getByRole('button', { name: 'Name' }).click();
  await expect(db(window).getByTestId('own-view')).toBeVisible();
  await window.keyboard.press('Escape');
  await db(window).getByTestId('own-view').getByRole('button', { name: 'Reset' }).click();
  await expect(db(window).getByTestId('filter-bar')).toHaveCount(0);
  // Data stays editable.
  await addRow(window, 'Gearbox');
  await expect(titles(window)).toHaveText(['Servo', 'Gearbox']);

  await (await options()).getByRole('menuitem', { name: /Lock views/ }).click();
  await window.keyboard.press('Escape');
  await expect(db(window).getByRole('button', { name: 'Add a view' })).toBeVisible();
});
