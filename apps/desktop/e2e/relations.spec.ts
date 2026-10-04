import type { Page } from '@playwright/test';
import { addRow, cell, header, newDatabase, popover, rows, table, titles } from './db';
import { expect, quit, test } from './helpers';

const openDatabase = (window: Page, title: string) =>
  window.getByRole('treeitem').filter({ hasText: title }).first().click();

async function addPropertyOfType(window: Page, type: string) {
  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: type, exact: true })
    .click();
}

/** Tasks: Design (3 points) and Build (5). */
async function seedTasks(window: Page) {
  await newDatabase(window, 'Tasks');
  await addPropertyOfType(window, 'Number');
  const name = window.getByTestId('property-menu').getByLabel('Property name');
  await name.fill('Points');
  await name.press('Enter');
  for (const [title, points] of [
    ['Design', '3'],
    ['Build', '5'],
  ] as const) {
    await addRow(window, title);
    await (await cell(window, title, 'Points')).click();
    await window.keyboard.type(points);
    await window.keyboard.press('Enter');
  }
  await window.keyboard.press('Escape');
}

test('relations: two-way links, rollups, new pages from the picker, kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await seedTasks(window);
  await newDatabase(window, 'Projects');
  await addRow(window, 'Alpha');
  await addRow(window, 'Beta');

  // A relation is set up first: its database, and whether the other side shows it.
  await addPropertyOfType(window, 'Relation');
  const setup = window.getByTestId('relation-setup');
  await setup.getByLabel('Related to').selectOption({ label: 'Tasks' });
  await setup.getByLabel('Two-way relation').check();
  await setup.getByLabel('Related property name').fill('Project');
  await setup.getByRole('button', { name: 'Add relation' }).click();
  await expect(setup).toHaveCount(0);
  await expect(header(window, 'Tasks')).toBeVisible();

  // Link pages from the picker; search narrows it, and a new title creates a page.
  await (await cell(window, 'Alpha', 'Tasks')).click();
  const picker = window.getByTestId('relation-editor');
  await picker.getByRole('option', { name: 'Design' }).click();
  await picker.getByLabel('Search pages').fill('bui');
  await expect(picker.getByRole('option')).toHaveText(['Build']);
  await window.keyboard.press('Enter');
  await picker.getByLabel('Search pages').fill('Test');
  await picker.getByRole('button', { name: 'New page “Test”' }).click();
  await expect(picker.getByRole('button', { name: /^Remove / })).toHaveCount(3);
  await picker.getByRole('button', { name: 'Remove Test' }).click();
  await window.keyboard.press('Escape');
  await expect(popover(window)).toHaveCount(0);
  await expect((await cell(window, 'Alpha', 'Tasks')).getByTestId('relation-page')).toHaveText([
    'Design',
    'Build',
  ]);

  // A rollup sums the related pages' points.
  await addPropertyOfType(window, 'Rollup');
  const rollup = window.getByTestId('rollup-setup');
  await rollup.getByLabel('Relation').selectOption({ label: 'Tasks' });
  await rollup.getByLabel('Property').selectOption({ label: 'Points' });
  await rollup.getByLabel('Calculate').selectOption({ label: 'Sum' });
  await rollup.getByRole('button', { name: 'Done' }).click();
  await expect(await cell(window, 'Alpha', 'Rollup')).toHaveText('8');
  await expect(await cell(window, 'Beta', 'Rollup')).toHaveText('0');

  // The other side shows the link, and edits there flow back.
  await openDatabase(window, 'Tasks');
  await expect(titles(window)).toHaveText(['Design', 'Build', 'Test']);
  await expect((await cell(window, 'Design', 'Project')).getByTestId('relation-page')).toHaveText(
    'Alpha',
  );
  await expect(await cell(window, 'Test', 'Project')).toHaveText('');
  await (await cell(window, 'Build', 'Points')).click();
  await window.keyboard.press('Control+a');
  await window.keyboard.type('10');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await (await cell(window, 'Test', 'Project')).click();
  await window.getByTestId('relation-editor').getByRole('option', { name: 'Beta' }).click();
  await window.keyboard.press('Escape');

  await openDatabase(window, 'Projects');
  await expect(await cell(window, 'Alpha', 'Rollup')).toHaveText('13');
  await expect((await cell(window, 'Beta', 'Tasks')).getByTestId('relation-page')).toHaveText(
    'Test',
  );

  // Clicking a linked page opens it.
  await (await cell(window, 'Alpha', 'Tasks')).getByTestId('relation-page').first().click();
  const peek = window.getByTestId('row-peek');
  await expect(peek.getByLabel('Page title')).toHaveValue('Design');
  await expect(peek.getByTestId('property-row').filter({ hasText: 'Project' })).toContainText(
    'Alpha',
  );
  await peek.getByRole('button', { name: 'Close' }).click();

  await quit(first.app);
  ({ window } = await launch());
  await openDatabase(window, 'Projects');
  await expect((await cell(window, 'Alpha', 'Tasks')).getByTestId('relation-page')).toHaveText([
    'Design',
    'Build',
  ]);
  await expect(await cell(window, 'Alpha', 'Rollup')).toHaveText('13');

  // Turning two-way off leaves the other side as a one-way relation.
  await header(window, 'Tasks').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Edit relation' })
    .click();
  await window.getByTestId('relation-setup').getByLabel('Two-way relation').uncheck();
  await window.getByTestId('relation-setup').getByRole('button', { name: 'Save' }).click();
  await (await cell(window, 'Beta', 'Tasks')).click();
  await window.getByTestId('relation-editor').getByRole('button', { name: 'Remove Test' }).click();
  await window.keyboard.press('Escape');
  await openDatabase(window, 'Tasks');
  await expect((await cell(window, 'Test', 'Project')).getByTestId('relation-page')).toHaveText(
    'Beta',
  );
  // Changing a text property to a relation links pages with the same titles.
  await addPropertyOfType(window, 'Text');
  const field = window.getByTestId('property-menu').getByLabel('Property name');
  await field.fill('Lead');
  await field.press('Enter');
  await (await cell(window, 'Design', 'Lead')).click();
  await window.keyboard.type('Beta');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await header(window, 'Lead').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: /^Type/ }).click();
  await window.getByRole('menuitem', { name: 'Relation', exact: true }).press('Enter');
  await window
    .getByTestId('relation-setup')
    .getByLabel('Related to')
    .selectOption({ label: 'Projects' });
  await window.getByTestId('relation-setup').getByRole('button', { name: 'Save' }).click();
  await expect((await cell(window, 'Design', 'Lead')).getByTestId('relation-page')).toHaveText(
    'Beta',
  );
});

test('sub-items nest rows under their parent; dependencies add Blocked by / Blocking', async ({
  launch,
}) => {
  const { window } = await launch();
  await newDatabase(window, 'Work');
  await addRow(window, 'Robot arm');
  await addRow(window, 'Gripper');

  await window.getByRole('tab', { name: 'Table' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Sub-items/ })
    .click();
  await expect(header(window, 'Parent item')).toBeVisible();
  await expect(header(window, 'Sub-items')).toBeVisible();

  const grip = (title: string) =>
    rows(window)
      .filter({ hasText: title })
      .getByRole('button', { name: 'Drag to move, click to open menu' });
  await rows(window).filter({ hasText: 'Robot arm' }).first().hover();
  await grip('Robot arm').first().click();
  await window.getByTestId('row-menu').getByRole('menuitem', { name: 'Add sub-item' }).click();
  await window.keyboard.type('Base joint');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect(titles(window)).toHaveText(['Robot arm', 'Base joint', 'Gripper']);
  await expect(
    (await cell(window, 'Base joint', 'Parent item')).getByTestId('relation-page'),
  ).toHaveText('Robot arm');

  // Gripper becomes a sub-item too, from its Parent item cell.
  await (await cell(window, 'Gripper', 'Parent item')).click();
  await window.getByTestId('relation-editor').getByRole('option', { name: 'Robot arm' }).click();
  await window.keyboard.press('Escape');
  await expect(titles(window)).toHaveText(['Robot arm', 'Base joint', 'Gripper']);
  await expect(
    rows(window).filter({ hasText: 'Robot arm' }).first().getByTestId('sub-item-count'),
  ).toHaveText('2');

  await table(window).getByRole('button', { name: 'Collapse sub-items' }).click();
  await expect(titles(window)).toHaveText(['Robot arm']);
  await table(window).getByRole('button', { name: 'Expand sub-items' }).first().click();
  await expect(titles(window)).toHaveText(['Robot arm', 'Base joint', 'Gripper']);

  await window.getByRole('tab', { name: 'Table' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Dependencies/ })
    .click();
  await expect(header(window, 'Blocked by')).toBeVisible();
  await (await cell(window, 'Gripper', 'Blocked by')).click();
  await window.getByTestId('relation-editor').getByRole('option', { name: 'Base joint' }).click();
  await window.keyboard.press('Escape');
  await expect(
    (await cell(window, 'Base joint', 'Blocking')).getByTestId('relation-page'),
  ).toHaveText('Gripper');

  // Turning sub-items off (keeping the properties) shows a flat table again.
  await window.getByRole('tab', { name: 'Table' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Sub-items/ })
    .click();
  await window.getByRole('menuitem', { name: 'Turn off, keep properties' }).click();
  await expect(table(window).getByRole('button', { name: /sub-items/ })).toHaveCount(0);
  await expect(header(window, 'Parent item')).toBeVisible();
});
