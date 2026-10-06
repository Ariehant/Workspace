import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, table } from './db';
import { expect, quit, settle, test } from './helpers';

/** The page's own editor (synced blocks nest editors inside it). */
const page = (window: Page) => window.getByTestId('page-editor').first();
const synced = (window: Page) => window.getByTestId('synced-block');

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(page(window)).toBeFocused();
}

async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

async function blockMenu(window: Page, block: ReturnType<Page['locator']>) {
  await block.hover({ position: { x: 60, y: 3 } });
  await window
    .getByTestId('block-handle')
    .getByRole('button', { name: 'Drag to move, click to open menu' })
    .click();
}

async function pasteHtml(window: Page, html: string) {
  await page(window).evaluate((el, h) => {
    const data = new DataTransfer();
    data.setData('text/html', h);
    data.setData('text/plain', '');
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, html);
}

const openPage = (window: Page, title: string) =>
  window.getByRole('treeitem').filter({ hasText: title }).first().click();

test('synced blocks: edit in one place, see it everywhere; unsync; kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  const { app } = first;
  let { window } = first;
  await newPage(window, 'Arm spec');
  await window.keyboard.type('Intro');
  await window.keyboard.press('Enter');
  await slash(window, 'synced block');
  const inner = synced(window).getByTestId('page-editor');
  await expect(inner).toBeVisible();
  await inner.click();
  await window.keyboard.type('Torque limit: 2 Nm');
  await expect(inner).toHaveText('Torque limit: 2 Nm');

  // Copy and sync, then paste into another page.
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await blockMenu(window, synced(window));
  await window.getByRole('menuitem', { name: 'Copy and sync' }).click();
  // Read what "Copy and sync" put on the clipboard, as a paste would.
  const readHtml = () =>
    window.evaluate(async () => {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) return (await item.getType('text/html')).text();
      }
      return '';
    });
  await expect.poll(readHtml).toContain('synced-block');
  const html = await readHtml();

  await newPage(window, 'Base spec');
  await pasteHtml(window, html);
  await expect(synced(window).getByTestId('page-editor')).toHaveText('Torque limit: 2 Nm');
  await synced(window).hover();
  await expect(synced(window).getByTestId('synced-label')).toHaveText('Synced from Arm spec');

  // Editing the copy edits the original.
  await synced(window).getByTestId('page-editor').click();
  await window.keyboard.press('End');
  await window.keyboard.type(' max');
  await openPage(window, 'Arm spec');
  await expect(synced(window).getByTestId('page-editor')).toHaveText('Torque limit: 2 Nm max');
  // The original counts the places it's shown in (from the index).
  await expect(async () => {
    await page(window).click({ position: { x: 5, y: 5 } });
    await synced(window).hover();
    await expect(synced(window).getByTestId('synced-label')).toHaveText('Editing in 2 places', {
      timeout: 500,
    });
  }).toPass();

  // Unsync the copy: it becomes ordinary blocks and stops following.
  await openPage(window, 'Base spec');
  await blockMenu(window, synced(window));
  await window.getByRole('menuitem', { name: 'Unsync' }).click();
  await expect(synced(window)).toHaveCount(0);
  await expect(page(window).locator('p').filter({ hasText: 'Torque limit' })).toHaveText(
    'Torque limit: 2 Nm max',
  );

  // A paragraph turned into a synced block keeps its text.
  await openPage(window, 'Arm spec');
  await blockMenu(window, page(window).locator(':scope > p').filter({ hasText: 'Intro' }));
  await window.getByRole('menuitem', { name: 'Turn into synced block' }).click();
  await expect(synced(window)).toHaveCount(2);
  await expect(synced(window).first().getByTestId('page-editor')).toHaveText('Intro');

  await quit(app);
  ({ window } = await launch());
  await openPage(window, 'Arm spec');
  await expect(synced(window).getByTestId('page-editor')).toHaveText([
    'Intro',
    'Torque limit: 2 Nm max',
  ]);
});

test('buttons: insert template blocks and add a database page; a button property per row', async ({
  launch,
}) => {
  const { window } = await launch();
  await newDatabase(window, 'Tasks');
  await addProperty(window, 'Date', 'Due');
  await addProperty(window, 'Checkbox', 'Done');
  await addRow(window, 'Calibrate');

  await newPage(window, 'Daily');
  await slash(window, 'button');
  const dialog = window.getByTestId('button-editor');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Button label').fill('Start standup');
  await dialog.getByRole('button', { name: 'Add a step' }).click();
  await window
    .getByTestId('add-step-menu')
    .getByRole('menuitem', { name: 'Insert blocks' })
    .click();
  await dialog.getByTestId('button-template').getByTestId('page-editor').click();
  await window.keyboard.type('Standup notes');
  await settle(window);
  await dialog.getByRole('button', { name: 'Add a step' }).click();
  await window.getByTestId('add-step-menu').getByRole('menuitem', { name: 'Add page to…' }).click();
  await dialog.getByLabel('Database').selectOption({ label: 'Tasks' });
  await dialog.getByLabel('Page title').fill('Standup');
  await dialog.getByLabel('Set a property').selectOption({ label: 'Due' });
  await dialog.getByLabel('Value of Due').fill('@today');
  await dialog.getByLabel('Value of Due').blur();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const button = window.getByTestId('button-block').getByRole('button', { name: 'Start standup' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page(window).locator('p').filter({ hasText: 'Standup notes' })).toHaveCount(1);

  await openPage(window, 'Tasks');
  const today = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  await expect(await cell(window, 'Standup', 'Due')).toHaveText(today);

  // A button property: "edit this page" for the row it's in.
  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: 'Button', exact: true })
    .click();
  await dialog.getByLabel('Button label').fill('Finish');
  await dialog.getByRole('button', { name: 'Add a step' }).click();
  await window
    .getByTestId('add-step-menu')
    .getByRole('menuitem', { name: 'Edit this page' })
    .click();
  await dialog.getByLabel('Set a property').selectOption({ label: 'Done' });
  await dialog.getByLabel('Value of Done').fill('true');
  await dialog.getByLabel('Value of Done').blur();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await (await cell(window, 'Calibrate', 'Button')).getByRole('button', { name: 'Finish' }).click();
  await expect((await cell(window, 'Calibrate', 'Done')).getByRole('checkbox')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect((await cell(window, 'Standup', 'Done')).getByRole('checkbox')).toHaveAttribute(
    'aria-checked',
    'false',
  );
});
