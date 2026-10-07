import type { Page } from '@playwright/test';
import { editor, expect, quit, settle, test, waitForIndexed } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

const mentionMenu = (window: Page) => window.getByTestId('mention-menu');

async function paste(window: Page, text: string, html?: string) {
  await editor(window).evaluate(
    (el, { text, html }) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      if (html) data.setData('text/html', html);
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { text, html },
  );
}

test('@ mentions pages with live titles and opens them', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Gear ratios');
  await newPage(window, 'Drivetrain');
  await window.keyboard.type('See @gear');
  await expect(mentionMenu(window).getByRole('option').first()).toHaveText(/Gear ratios/);
  await window.keyboard.press('Enter');
  await window.keyboard.type('for details');
  const mention = editor(window).getByTestId('mention');
  await expect(mention).toHaveText('Gear ratios');
  await expect(editor(window).locator('p').first()).toHaveText('See Gear ratios for details');

  // Renaming the target updates the mention.
  await window.getByRole('tree').getByText('Gear ratios').click();
  await window.getByLabel('Page title').fill('Gear ratio table');
  await window.getByRole('tree').getByText('Drivetrain').click();
  await expect(mention).toHaveText('Gear ratio table');

  await mention.click();
  await expect(window.getByLabel('Page title')).toHaveValue('Gear ratio table');
});

test('@ dates understand natural language', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Schedule');
  await window.keyboard.type('Review @tomorrow');
  await expect(mentionMenu(window).getByRole('option').first()).toHaveText('Tomorrow');
  await window.keyboard.press('Enter');
  await window.keyboard.type('and demo @in 2 weeks');
  await expect(mentionMenu(window).getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
  const mentions = editor(window).getByTestId('mention');
  await expect(mentions.first()).toHaveText('@Tomorrow');
  await expect(mentions.nth(1)).toHaveText(/^@[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
});

test('@remind creates a reminder that notifies and opens its page', async ({ launch }) => {
  const { app, window } = await launch();
  await newPage(window, 'Purchasing');
  // A reminder for yesterday is overdue, so it fires as soon as the page is indexed.
  await window.keyboard.type('Order servos @remind yesterday');
  await expect(mentionMenu(window).getByRole('option').first()).toHaveText(/Remind me/);
  await window.keyboard.press('Enter');
  const reminder = editor(window).getByTestId('mention');
  await expect(reminder).toHaveText('@Yesterday');
  await expect(reminder.getByLabel('Reminder')).toBeVisible();
  await expect(reminder.locator('.ws-mention-date')).toHaveClass(/text-danger/);

  const notifications = () =>
    app.evaluate(
      () =>
        (globalThis as { __notifications?: { title: string; body: string; pageId: string }[] })
          .__notifications ?? [],
    );
  await expect.poll(notifications, { timeout: 10_000 }).toHaveLength(1);
  const [fired] = await notifications();
  expect(fired).toMatchObject({ title: 'Purchasing', body: 'Order servos' });

  // Clicking a notification asks the window to open the page.
  await newPage(window, 'Elsewhere');
  await app.evaluate(({ BrowserWindow }, pageId) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('app:navigate', pageId);
  }, fired!.pageId);
  await expect(window.getByLabel('Page title')).toHaveValue('Purchasing');

  // Editing the page again doesn't notify twice.
  await editor(window).click();
  await window.keyboard.press('End');
  await window.keyboard.type(' (urgent)');
  await waitForIndexed(window, 'urgent');
  expect(await notifications()).toHaveLength(1);
});

test(':emoji autocomplete inserts the character', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Emoji');
  await window.keyboard.type('Launch day :rocke');
  const menu = window.getByTestId('emoji-menu');
  await expect(menu.getByRole('option').first()).toContainText('🚀');
  await window.keyboard.press('Enter');
  await expect(editor(window).locator('p').first()).toHaveText('Launch day 🚀');
});

test('text and block colors, kept after a restart', async ({ launch }) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Colors');
  await window.keyboard.type('Warning: high voltage');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Highlighted block');

  // Select "voltage" at the end of the first paragraph.
  await editor(window).locator(':scope > p').first().click();
  await window.keyboard.press('End');
  for (let i = 0; i < 'voltage'.length; i++) await window.keyboard.press('Shift+ArrowLeft');
  const toolbar = window.getByTestId('selection-toolbar');
  await toolbar.getByRole('button', { name: 'Text color' }).click();
  await toolbar.getByRole('menuitem', { name: 'Red text' }).click();
  await expect(editor(window).locator('span[data-color="red"]')).toHaveText('voltage');

  const block = editor(window).locator(':scope > p', { hasText: 'Highlighted block' });
  await block.hover({ position: { x: 20, y: 8 } });
  await window.getByRole('button', { name: 'Drag to move, click to open menu' }).click();
  await window.getByRole('menuitem', { name: 'Color' }).click();
  await window.getByRole('menuitem', { name: 'Blue background' }).click();
  await expect(block).toHaveAttribute('data-color', 'blue_background');
  await expect(block).toHaveCSS('background-color', 'rgb(231, 243, 248)');
  await waitForIndexed(window, 'Highlighted');

  await quit(launched.app);
  ({ window } = await launch());
  await expect(editor(window).locator('span[data-color="red"]')).toHaveText('voltage');
  await expect(editor(window).locator('p[data-color="blue_background"]')).toHaveText(
    'Highlighted block',
  );
});

/**
 * Put the caret in the page's last top-level paragraph, and check it's there: right
 * after a paste, the editor can still move the selection (a paste's focus lands a frame
 * or two later), so click again until it stays.
 */
async function caretInLastParagraph(window: Page) {
  await expect
    .poll(async () => {
      await settle(window);
      await editor(window).locator(':scope > p').last().click();
      await window.keyboard.press('Control+End');
      await settle(window);
      return window.evaluate(() => {
        const node = getSelection()?.anchorNode;
        const element =
          node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement;
        const block = element?.closest('[data-testid="page-editor"] > *');
        return block === block?.parentElement?.lastElementChild ? block?.tagName : 'elsewhere';
      });
    })
    .toBe('P');
}

test('pasting Markdown makes blocks; copying gives Markdown', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Readme');
  await paste(window, '# Setup\n\n- clone the repo\n- run **make**\n\n```\nmake flash\n```\n');
  await expect(editor(window).locator('h1')).toHaveText('Setup');
  await expect(editor(window).locator('ul > li')).toHaveText(['clone the repo', 'run make']);
  await expect(editor(window).locator('strong')).toHaveText('make');
  await expect(editor(window).locator('pre code')).toHaveText('make flash');

  // Styled lines from a code editor are treated as Markdown too...
  await caretInLastParagraph(window);
  await paste(window, '## Notes', '<div style="color:#ccc"><span>## Notes</span></div>');
  await expect(editor(window).locator('h2')).toHaveText('Notes');
  await settle(window);
  // ...but plain prose stays prose.
  await caretInLastParagraph(window);
  await paste(window, 'Just a sentence.');
  await expect(editor(window).locator(':scope > p', { hasText: 'Just a sentence.' })).toHaveCount(
    1,
  );

  // Select everything through the editor, then copy (as Ctrl+C would).
  await editor(window).click();
  await window.keyboard.press('Control+a');
  const copied = await editor(window).evaluate((el) => {
    const data = new DataTransfer();
    el.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    return data.getData('text/plain');
  });
  expect(copied).toContain('# Setup');
  expect(copied).toMatch(/- run \*\*make\*\*/);
  expect(copied).toContain('```');
});

test('find and replace in a page', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Find');
  await window.keyboard.type('Servo one. Servo two. Another servo here.');
  await window.keyboard.press('Control+f');
  const bar = window.getByTestId('find-bar');
  await expect(bar.getByLabel('Find', { exact: true })).toBeFocused();
  await bar.getByLabel('Find', { exact: true }).fill('servo');
  await expect(bar.getByTestId('find-count')).toHaveText('0/3');
  await expect(editor(window).locator('.ProseMirror-search-match')).toHaveCount(3);
  await bar.getByLabel('Find', { exact: true }).press('Enter');
  await expect(bar.getByTestId('find-count')).toHaveText('1/3');

  await bar.getByRole('button', { name: 'Match case' }).click();
  await expect(bar.getByTestId('find-count')).toHaveText(/\/1$/);
  await bar.getByRole('button', { name: 'Match case' }).click();

  await bar.getByRole('button', { name: 'Toggle replace' }).click();
  await bar.getByLabel('Replace', { exact: true }).fill('motor');
  await bar.getByRole('button', { name: 'All' }).click();
  await expect(editor(window).locator('p').first()).toHaveText(
    'motor one. motor two. Another motor here.',
  );
  await expect(bar.getByTestId('find-count')).toHaveText('0/0');

  await bar.getByLabel('Replace', { exact: true }).press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(editor(window).locator('.ProseMirror-search-match')).toHaveCount(0);
});
