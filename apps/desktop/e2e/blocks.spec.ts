import type { Page } from '@playwright/test';
import { editor, expect, quit, sidebarTitles, test, waitForIndexed } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

/** Run a slash command by typing its query and pressing Enter. */
async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

const blocks = (window: Page) => editor(window).locator(':scope > *');

test('to-do list: shortcut, checking items, and persistence', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Tasks');
  await window.keyboard.type('[] Calibrate arm');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Tune PID gains');
  const items = () => editor(window).locator('ul[data-type="taskList"] > li');
  await expect(items()).toHaveCount(2);
  await items().first().getByRole('checkbox').check();
  await expect(items().first()).toHaveAttribute('data-checked', 'true');
  await waitForIndexed(window, 'PID');

  await quit(launched.app);
  ({ window } = await launch());
  await expect(items().first()).toHaveAttribute('data-checked', 'true');
  await expect(items().nth(1)).toHaveAttribute('data-checked', 'false');
});

test('toggles: "> " shortcut, collapsing, toggle headings and turn into', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Toggles');
  await window.keyboard.type('> Details');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Hidden content');
  const toggle = editor(window).locator('.ws-toggle').first();
  await expect(toggle.locator('summary')).toHaveText('Details');
  await expect(toggle.getByText('Hidden content')).toBeVisible();

  await toggle.locator(':scope > button').click();
  await expect(toggle.getByText('Hidden content')).toBeHidden();
  await toggle.locator(':scope > button').click();
  await expect(toggle.getByText('Hidden content')).toBeVisible();

  // Turn a text block into a toggle heading: its text becomes the title.
  await editor(window).click({ position: { x: 5, y: 5 } });
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Section title');
  await window.keyboard.press('Shift+Home');
  const toolbar = window.getByTestId('selection-toolbar');
  await toolbar.getByRole('button', { name: 'Turn into' }).click();
  await toolbar.getByRole('menuitem', { name: 'Toggle heading 2' }).click();
  await expect(editor(window).locator('summary[data-level="2"]')).toHaveText('Section title');
});

test('quote, callout and divider', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Basics');
  await window.keyboard.type('" Stay hungry');
  await expect(editor(window).locator('blockquote')).toHaveText('Stay hungry');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await slash(window, 'callout');
  await window.keyboard.type('Remember to save');
  const callout = editor(window).locator('.ws-callout');
  await expect(callout).toContainText('Remember to save');
  await callout.getByRole('button', { name: 'Change callout icon' }).click();
  await window.getByRole('button', { name: '⚠️' }).click();
  await expect(callout.getByRole('button', { name: 'Change callout icon' })).toHaveText('⚠️');
  await editor(window).locator('.ws-callout-content').click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await window.keyboard.type('---');
  await expect(editor(window).locator('hr')).toHaveCount(1);
});

test('code block: language picker and syntax highlighting', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Code');
  await slash(window, 'code');
  await window.keyboard.type('const answer = 42;');
  const block = editor(window).locator('.ws-code-block');
  await block.hover();
  await block.getByLabel('Code language').selectOption('javascript');
  await expect(block.locator('code')).toHaveClass(/language-javascript/);
  await expect(block.locator('.hljs-keyword')).toHaveText('const');
  await expect(block.locator('.hljs-number')).toHaveText('42');
  await block.getByRole('button', { name: 'Wrap code' }).click();
  await expect(block).toHaveAttribute('data-wrap', /.*/);
});

test('equations: block via "$$ ", inline via $…$, and editing', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Math');
  await window.keyboard.type('$$ ');
  const mathEditor = window.getByTestId('math-editor');
  await expect(mathEditor).toBeVisible();
  await mathEditor.getByLabel('TeX equation').fill('E = mc^2');
  await mathEditor.getByLabel('TeX equation').press('Control+Enter');
  const block = editor(window).locator('[data-type="block-math"]');
  await expect(block).toHaveAttribute('data-latex', 'E = mc^2');
  await expect(block.locator('.katex')).toBeVisible();

  await editor(window).locator('p').last().click();
  await window.keyboard.type('Area is $$\\pi r^2$$ ');
  const inline = editor(window).locator('[data-type="inline-math"]');
  await expect(inline).toHaveAttribute('data-latex', '\\pi r^2');

  await inline.click();
  await mathEditor.getByLabel('TeX equation').fill('2\\pi r');
  await mathEditor.getByLabel('TeX equation').press('Enter');
  await expect(inline).toHaveAttribute('data-latex', '2\\pi r');
});

test('table: insert, add rows and columns, header row', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Table');
  await slash(window, 'table');
  const table = editor(window).locator('table');
  await expect(table.locator('tr')).toHaveCount(3);
  await window.keyboard.type('Joint');
  const menu = window.getByTestId('table-menu');
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: 'Add row below' }).click();
  await menu.getByRole('button', { name: 'Add column right' }).click();
  await expect(table.locator('tr')).toHaveCount(4);
  await expect(table.locator('tr').first().locator('td, th')).toHaveCount(4);
  await menu.getByRole('button', { name: 'Header row' }).click();
  await expect(table.locator('th').first()).toHaveText('Joint');
});

test('columns: from the slash menu and by dropping a block beside another', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Layout');
  await slash(window, '2 col');
  await expect(editor(window).locator('.ws-columns > .ws-column')).toHaveCount(2);
  await window.keyboard.type('Left');
  await editor(window).locator('.ws-column').nth(1).click();
  await window.keyboard.type('Right');
  await expect(editor(window).locator('.ws-column')).toHaveText(['Left', 'Right']);

  // Drag a block onto the right edge of another to put them side by side.
  await window.keyboard.press('Control+End');
  await editor(window).locator('p').last().click();
  await window.keyboard.type('First');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Second');
  const second = blocks(window).filter({ hasText: 'Second' });
  await second.hover({ position: { x: 10, y: 8 } });
  const grip = window.getByRole('button', { name: 'Drag to move, click to open menu' });
  const first = blocks(window).filter({ hasText: 'First' });
  const box = (await first.boundingBox())!;
  await grip.dragTo(first, { targetPosition: { x: box.width - 10, y: box.height / 2 } });
  const pair = editor(window).locator('.ws-columns').last();
  await expect(pair.locator('.ws-column')).toHaveText(['First', 'Second']);
});

test('link to page and sub-pages', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Target page');
  await newPage(window, 'Hub');

  await slash(window, 'link to');
  const picker = window.getByTestId('page-picker');
  await picker.getByLabel('Search pages').fill('Targ');
  await picker.getByLabel('Search pages').press('Enter');
  const link = editor(window).getByTestId('page-link');
  await expect(link).toHaveText('Target page');

  // "/page" creates a sub-page, links it here and opens it.
  await editor(window).locator('p').last().click();
  await slash(window, 'page');
  await expect(window.getByLabel('Page title')).toBeFocused();
  await window.getByLabel('Page title').fill('Child');
  await expect(sidebarTitles(window)).toContainText(['Hub', 'Child']);

  await window.getByRole('tree').getByText('Hub').click();
  await expect(editor(window).getByTestId('page-link')).toHaveText(['Target page', 'Child']);
  await editor(window).getByTestId('page-link').first().click();
  await expect(window.getByLabel('Page title')).toHaveValue('Target page');
});

test('table of contents and breadcrumb follow the page', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Parent');
  await slash(window, 'page');
  await window.getByLabel('Page title').fill('Report');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();

  await slash(window, 'breadcrumb');
  await slash(window, 'table of');
  await window.keyboard.type('# Intro');
  await window.keyboard.press('Enter');
  await window.keyboard.type('## Method');
  const toc = editor(window).getByRole('navigation', { name: 'Table of contents' });
  await expect(toc.getByRole('button')).toHaveText(['Intro', 'Method']);
  const crumbs = editor(window).getByRole('navigation', { name: 'Page path' });
  await expect(crumbs.getByRole('button')).toHaveText(['Parent', 'Report']);

  await window.getByLabel('Page title').fill('Final report');
  await expect(crumbs.getByRole('button')).toHaveText(['Parent', 'Final report']);
});

test('every block type survives a restart', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Everything');
  await window.keyboard.type('[] task');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await window.keyboard.type('> toggle');
  await window.keyboard.press('Enter');
  await window.keyboard.type('inside');
  await editor(window).locator('p').last().click();
  await slash(window, 'callout');
  await window.keyboard.type('note');
  await editor(window).locator('p').last().click();
  await slash(window, 'code');
  await window.keyboard.type('print(1)');
  await editor(window).locator('p').last().click();
  await slash(window, 'table');
  await editor(window).locator(':scope > p').last().click();
  await slash(window, '3 col');
  await editor(window).locator(':scope > p').last().click();
  await window.keyboard.type('$$ ');
  await window.getByTestId('math-editor').getByLabel('TeX equation').fill('a^2+b^2');
  await window.getByTestId('math-editor').getByLabel('TeX equation').press('Control+Enter');
  await waitForIndexed(window, 'print');

  const shape = () =>
    editor(window)
      .locator(':scope > *')
      .evaluateAll((els) =>
        els.map(
          (el) =>
            el.getAttribute('data-type') ??
            el.firstElementChild?.getAttribute('data-type') ??
            el.tagName,
        ),
      );
  const before = await shape();
  expect(before.length).toBeGreaterThan(6);

  await quit(launched.app);
  ({ window } = await launch());
  await expect(editor(window).locator('[data-type="block-math"]')).toHaveAttribute(
    'data-latex',
    'a^2+b^2',
  );
  expect(await shape()).toEqual(before);
  await expect(editor(window).locator('.ws-columns > .ws-column')).toHaveCount(3);
  await expect(editor(window).locator('table tr')).toHaveCount(3);
});

test('quick commands in the / menu: colour, turn into, duplicate, delete, date, emoji, comment', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window, 'Quick commands');
  // (A `/` opens the menu at the start of a line or after a space.)
  await window.keyboard.type('Torque limit ');

  // Colour and turn into act on the block the cursor is in; what was typed goes.
  await slash(window, 'red');
  const first = blocks(window).first();
  await expect(first).toHaveAttribute('data-color', 'red');
  await expect(first).toHaveText('Torque limit');
  await slash(window, 'turn into h2');
  await expect(editor(window).locator('h2')).toHaveText('Torque limit');
  await slash(window, 'duplicate');
  await expect(editor(window).locator('h2')).toHaveText(['Torque limit', 'Torque limit']);
  await slash(window, 'delete');
  await expect(editor(window).locator('h2')).toHaveText(['Torque limit']);

  // Comment on the block's text.
  await editor(window).locator('h2').click();
  await window.keyboard.press('End');
  await slash(window, 'comment');
  const input = window.getByTestId('comments-panel').getByTestId('comment-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('Check at 64:1');
  await input.press('Enter');
  await expect(editor(window).locator('.ws-comment')).toHaveText('Torque limit');

  // Today's date, an emoji, and the mention menu, on a new line.
  await editor(window).locator('h2').click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Due ');
  await slash(window, 'today');
  await expect(editor(window).getByTestId('mention')).toHaveText('@Today');
  await slash(window, 'emoji');
  const emoji = window.getByTestId('emoji-menu');
  await expect(emoji.getByRole('option').first()).toBeVisible();
  await window.keyboard.type('rocket');
  await window.keyboard.press('Enter');
  await expect(blocks(window).nth(1)).toContainText('Due @Today 🚀');
  await window.keyboard.type(' ');
  await slash(window, 'mention a page');
  await expect(window.getByTestId('mention-menu')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(editor(window)).not.toContainText('/');
});

test('tabs: switch, rename, add and delete tabs, kept after a restart', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Arm');
  await slash(window, 'tabs');
  const tabs = editor(window).locator('.ws-tabs');
  const tabButtons = tabs.getByRole('tab');
  await expect(tabButtons).toHaveText(['Tab 1', 'Tab 2']);
  await window.keyboard.type('Torque limit 2 Nm');

  // The second tab: the first one's content hides, the cursor goes in.
  await tabButtons.nth(1).click();
  await expect(tabButtons.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByText('Torque limit 2 Nm')).toBeHidden();
  await window.keyboard.type('Bench run passed');
  await expect(tabs.getByText('Bench run passed')).toBeVisible();

  // Rename the open tab by clicking it.
  await tabButtons.nth(1).click();
  await tabs.getByLabel('Tab name').fill('Tests');
  await tabs.getByLabel('Tab name').press('Enter');
  await expect(tabButtons).toHaveText(['Tab 1', 'Tests']);

  // Add a tab (an image in it shows), then delete it.
  await tabs.getByRole('button', { name: 'Add tab' }).click();
  await expect(tabButtons).toHaveText(['Tab 1', 'Tests', 'Tab 3']);
  await window.keyboard.type('Scratch');
  await window.keyboard.press('Enter');
  await slash(window, 'image');
  await editor(window)
    .getByTestId('media-placeholder')
    .getByLabel('Upload file')
    .setInputFiles({
      name: 'dot.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842AAAAAElFTkSuQmCC',
        'base64',
      ),
    });
  await expect(tabs.locator('.ws-image img')).toBeVisible();
  await tabs.getByRole('button', { name: 'Delete tab Tab 3' }).click();
  await expect(tabButtons).toHaveText(['Tab 1', 'Tests']);

  // Arrow keys move between tabs.
  await tabButtons.nth(1).focus();
  await window.keyboard.press('ArrowLeft');
  await expect(tabButtons.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByText('Torque limit 2 Nm')).toBeVisible();
  await waitForIndexed(window, 'Bench');

  await quit(launched.app);
  ({ window } = await launch());
  const after = editor(window).locator('.ws-tabs');
  await expect(after.getByRole('tab')).toHaveText(['Tab 1', 'Tests']);
  await after.getByRole('tab', { name: 'Tests' }).click();
  await expect(after.getByText('Bench run passed')).toBeVisible();
  await expect(after.getByText('Torque limit 2 Nm')).toBeHidden();
});
