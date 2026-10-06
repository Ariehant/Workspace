import type { Page } from '@playwright/test';
import { editor, expect, quit, settle, test, waitForIndexed } from './helpers';

/** Create a page and leave the cursor in its (empty) body. */
async function newPage(window: Page, title = 'Editor test') {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

const slashMenu = (window: Page) => window.getByTestId('slash-menu');
const blocks = (window: Page) => editor(window).locator(':scope > *');

async function hoverBlock(window: Page, text: string) {
  await editor(window)
    .locator(':scope > *', { hasText: text })
    .first()
    .hover({ position: { x: 20, y: 8 } });
  await expect(window.getByTestId('block-handle')).toBeVisible();
}

test('slash menu filters blocks and turns an empty block into the choice', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window);

  await window.keyboard.type('/');
  await expect(slashMenu(window).getByRole('option').first()).toHaveText(/Text/);
  await window.keyboard.type('h2');
  await expect(slashMenu(window).getByRole('option')).toHaveText([
    /^Heading 2/,
    /^Toggle heading 2/,
  ]);
  await window.keyboard.press('Enter');
  await window.keyboard.type('Section');
  await expect(editor(window).locator('h2')).toHaveText('Section');

  await window.keyboard.press('Enter');
  await window.keyboard.type('/bul');
  await window.keyboard.press('Enter');
  await window.keyboard.type('first item');
  await expect(editor(window).locator('ul li')).toHaveText('first item');

  // Arrow keys move the highlight; Escape dismisses and keeps the typed text.
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await window.keyboard.type('/');
  await window.keyboard.press('ArrowDown');
  await expect(slashMenu(window).getByRole('option', { selected: true })).toHaveText(/^Page/);
  await window.keyboard.type('zzz');
  await expect(slashMenu(window)).toContainText('No results');
  await window.keyboard.press('Escape');
  await expect(slashMenu(window)).toHaveCount(0);
  await expect(editor(window).getByText('/zzz')).toBeVisible();
});

test('slash menu in a non-empty block inserts the new block below', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window);
  await window.keyboard.type('Hello /quote');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Quoted');
  await expect(blocks(window).nth(0)).toHaveText('Hello');
  await expect(editor(window).locator('blockquote')).toHaveText('Quoted');
});

test('markdown shortcuts and block placeholders', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window);
  await window.keyboard.type('## ');
  await expect(editor(window).locator('h2.is-empty')).toHaveAttribute(
    'data-placeholder',
    'Heading 2',
  );
  await window.keyboard.type('Title');
  await window.keyboard.press('Enter');
  await window.keyboard.type('1. one');
  await window.keyboard.press('Enter');
  await window.keyboard.type('two');
  await expect(editor(window).locator('ol li')).toHaveText(['one', 'two']);
});

test('block handle: duplicate, turn into, delete and add below', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window);
  await window.keyboard.type('Alpha');

  await hoverBlock(window, 'Alpha');
  await window.getByRole('button', { name: 'Drag to move, click to open menu' }).click();
  await window.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(blocks(window)).toHaveText(['Alpha', 'Alpha']);
  const ids = await blocks(window).evaluateAll((els) =>
    els.map((el) => el.getAttribute('data-id')),
  );
  expect(ids[0]).toBeTruthy();
  expect(ids[1]).toBeTruthy();
  expect(ids[0]).not.toBe(ids[1]);

  await hoverBlock(window, 'Alpha');
  await window.getByRole('button', { name: 'Drag to move, click to open menu' }).click();
  await window.getByRole('menuitem', { name: /^Turn into ›/ }).click();
  await window.getByRole('menuitem', { name: 'Heading 1', exact: true }).click();
  await expect(editor(window).locator('h1')).toHaveText('Alpha');

  await hoverBlock(window, 'Alpha');
  await window.getByRole('button', { name: 'Drag to move, click to open menu' }).click();
  await window.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(blocks(window)).toHaveCount(1);

  await hoverBlock(window, 'Alpha');
  await window.getByRole('button', { name: 'Add block below' }).click();
  await expect(slashMenu(window)).toBeVisible();
  await window.keyboard.type('divider');
  await window.keyboard.press('Enter');
  await expect(editor(window).locator('hr')).toHaveCount(1);
});

test('selection toolbar formats text, links it and turns the block into a heading', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window);
  await window.keyboard.type('Make this bold');
  await editor(window).getByText('Make this bold').dblclick();

  const toolbar = window.getByTestId('selection-toolbar');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: /^Bold/ }).click();
  await expect(editor(window).locator('strong')).toHaveText('bold');

  await toolbar.getByRole('button', { name: 'Link' }).click();
  await toolbar.getByLabel('Link URL').fill('example.com');
  await toolbar.getByLabel('Link URL').press('Enter');
  await expect(editor(window).locator('a')).toHaveAttribute('href', 'https://example.com');

  // Other test workers' windows can take the OS focus, which blurs the editor and
  // (rightly) hides the toolbar; take it back first.
  await window.bringToFront();
  await expect(editor(window)).toBeFocused();
  await settle(window);
  await window.keyboard.press('End');
  await expect(toolbar).toBeHidden();
  await window.keyboard.press('Shift+Home');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: 'Turn into' }).click();
  await toolbar.getByRole('menuitem', { name: 'Heading 3', exact: true }).click();
  await expect(editor(window).locator('h3')).toHaveText('Make this bold');
});

test('dragging the handle reorders blocks', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window);
  for (const text of ['One', 'Two', 'Three']) {
    await window.keyboard.type(text);
    await window.keyboard.press('Enter');
  }
  await window.keyboard.press('Backspace');
  await expect(blocks(window)).toHaveText(['One', 'Two', 'Three']);

  await hoverBlock(window, 'Three');
  const grip = window.getByRole('button', { name: 'Drag to move, click to open menu' });
  // Drop with the pointer left of the text, where it stays while dragging the handle.
  const gripBox = (await grip.boundingBox())!;
  const target = (await blocks(window).nth(0).boundingBox())!;
  await window.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await window.mouse.down();
  await window.mouse.move(target.x - 8, target.y + 2, { steps: 8 });
  await window.mouse.up();
  await expect(blocks(window)).toHaveText(['Three', 'One', 'Two']);
});

test('block ids are stable across restarts', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Stable ids');
  await window.keyboard.type('Keep my id');
  await waitForIndexed(window, 'Keep my id');
  const before = await blocks(window).first().getAttribute('data-id');
  expect(before).toBeTruthy();

  await quit(launched.app);
  ({ window } = await launch());
  await expect(blocks(window).first()).toHaveText('Keep my id');
  expect(await blocks(window).first().getAttribute('data-id')).toBe(before);
});
