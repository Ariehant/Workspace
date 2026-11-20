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

/** The window's focus and selection, the page's and the editor's (for a failure's message). */
async function selectionState(window: Page): Promise<string> {
  return window.evaluate(() => {
    const el = document.querySelector('[data-testid="page-editor"]') as
      (Element & { editor?: { state: { selection: { from: number; to: number } } } }) | null;
    const pm = el?.editor?.state.selection;
    return JSON.stringify({
      windowFocused: document.hasFocus(),
      active:
        document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName,
      page: getSelection()?.toString(),
      editor: pm ? [pm.from, pm.to] : null,
    });
  });
}

/**
 * Record what touches the selection from now on: the view's updates (and whether each wrote
 * the page's selection), keys and selection changes, with ProseMirror's selection and the
 * page's after each. Read back with `selectionLog` when something goes wrong.
 */
async function recordSelection(window: Page): Promise<void> {
  await window.evaluate(() => {
    type View = Record<string, (...args: unknown[]) => unknown> & {
      state: { selection: { from: number; to: number } };
    };
    const el = document.querySelector('[data-testid="page-editor"]') as
      (Element & { editor?: { view: View } }) | null;
    const view = el?.editor?.view;
    if (!view) return;
    const log: string[] = [];
    const t0 = performance.now();
    const now = () => {
      const s = getSelection();
      const pm = view.state.selection;
      return `pm ${pm.from}-${pm.to} page ${s?.anchorOffset}/${s?.focusOffset} "${s?.toString() ?? ''}"`;
    };
    const at = (what: string) => {
      if (log.length < 200) log.push(`${Math.round(performance.now() - t0)}ms ${what}: ${now()}`);
    };
    for (const name of ['updateState', 'setProps', 'update', 'dispatch', 'focus']) {
      const original = view[name]!.bind(view);
      view[name] = (...args: unknown[]) => {
        at(`> ${name}`);
        const result = original(...args);
        at(`< ${name}`);
        return result;
      };
    }
    document.addEventListener('selectionchange', () => at('selectionchange'), true);
    document.addEventListener('keydown', (e) => at(`keydown ${e.key}`), true);
    document.addEventListener('keyup', (e) => at(`keyup ${e.key}`), true);
    (window as unknown as { __selectionLog: string[] }).__selectionLog = log;
  });
}

const selectionLog = (window: Page) =>
  window.evaluate(() =>
    ((window as unknown as { __selectionLog?: string[] }).__selectionLog ?? []).join('\n'),
  );

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

  // Turn a text block into a toggle heading: its text becomes the title. (Into the text, not
  // the page's corner: the toggle's arrow button is there, and could take the click.)
  await toggle.getByText('Hidden content').click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Section title');
  // Ctrl+End left the toggle (Enter didn't act on where the caret was before it).
  await expect(blocks(window).last()).toHaveText('Section title');
  await recordSelection(window);
  await window.keyboard.press('Shift+Home');
  const toolbar = window.getByTestId('selection-toolbar');
  // (CI's runner has, now and then, never shown the toolbar here; if so, say what the window had.)
  await expect(toolbar)
    .toBeVisible({ timeout: 10_000 })
    .catch(async (error: Error) => {
      throw new Error(
        `${error.message}\nState: ${await selectionState(window)}\nSince Shift+Home:\n${await selectionLog(window)}`,
      );
    });
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

test('a selection made with the keyboard survives a transaction from elsewhere', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window, 'Selection');
  await window.keyboard.type('Keep this selected');
  // Something else (a collaborator's cursor moving, a synced change) dispatches a transaction
  // after a key moved the selection but before the editor read the move (CI's runner ordered
  // them so, and the toolbar never showed). Here it's made to happen: first in line for the
  // selectionchange the key causes, ahead of the editor's own listener.
  await editor(window).evaluate((el) => {
    type Tr = { insert(pos: number, node: unknown): Tr };
    type View = {
      dispatch(tr: Tr): void;
      state: {
        tr: Tr;
        schema: {
          nodes: { paragraph: { create(a: null, c: unknown): unknown } };
          text(t: string): unknown;
        };
      };
    };
    const view = (el as unknown as { editor: { view: View } }).editor.view;
    document.addEventListener(
      'selectionchange',
      () => {
        // Someone else adds a paragraph at the top of the page.
        const { schema } = view.state;
        view.dispatch(
          view.state.tr.insert(0, schema.nodes.paragraph.create(null, schema.text('Elsewhere'))),
        );
      },
      { capture: true, once: true },
    );
  });
  await window.keyboard.press('Shift+Home');
  await expect(window.getByTestId('selection-toolbar')).toBeVisible();
  expect(await window.evaluate(() => getSelection()?.toString())).toBe('Keep this selected');
  // And the other change went in.
  await expect(blocks(window).first()).toHaveText('Elsewhere');
});

test('a selection made with the keyboard survives a redraw that is not a transaction', async ({
  launch,
}) => {
  const { window } = await launch();
  await newPage(window, 'Redraw');
  await window.keyboard.type('Keep this selected');
  // A plugin registered in that same moment (collaborators' cursors arriving, say) redraws the
  // page without a transaction; ProseMirror then wrote its old caret back (CI's toggles test:
  // the editor's selection and the page's both collapsed, the toolbar never shown). Here the
  // plugin's node view for paragraphs forces the redraw, first in line for the selectionchange.
  await editor(window).evaluate((el) => {
    type Editor = {
      registerPlugin(plugin: unknown): void;
      view: { state: { plugins: { constructor: new (spec: object) => unknown }[] } };
    };
    const ed = (el as unknown as { editor: Editor }).editor;
    const Plugin = ed.view.state.plugins[0]!.constructor;
    document.addEventListener(
      'selectionchange',
      () => {
        ed.registerPlugin(
          new Plugin({
            props: {
              nodeViews: {
                paragraph: () => {
                  const dom = document.createElement('p');
                  return { dom, contentDOM: dom };
                },
              },
            },
          }),
        );
      },
      { capture: true, once: true },
    );
  });
  await window.keyboard.press('Shift+Home');
  await expect(window.getByTestId('selection-toolbar')).toBeVisible();
  expect(await window.evaluate(() => getSelection()?.toString())).toBe('Keep this selected');
});

for (const call of ['focus', 'update'] as const) {
  test(`a selection made with the keyboard survives the view's ${call}() before it reads the move`, async ({
    launch,
  }) => {
    const { window } = await launch();
    await newPage(window, `Then ${call}`);
    await window.keyboard.type('Keep this selected');
    // The other two ways ProseMirror writes its selection to the page: focusing the editor
    // (a menu or panel closing, say) and updating its props directly. Made to happen first in
    // line for the selectionchange, as above.
    await editor(window).evaluate((el, method) => {
      type View = { focus(): void; update(props: unknown): void; props: unknown };
      const view = (el as unknown as { editor: { view: View } }).editor.view;
      document.addEventListener(
        'selectionchange',
        () => (method === 'focus' ? view.focus() : view.update(view.props)),
        { capture: true, once: true },
      );
    }, call);
    await window.keyboard.press('Shift+Home');
    await expect(window.getByTestId('selection-toolbar')).toBeVisible();
    expect(await window.evaluate(() => getSelection()?.toString())).toBe('Keep this selected');
  });
}

test('table: insert, add rows and columns, header row, row and column colours', async ({
  launch,
}) => {
  const launched = await launch();
  let { window } = launched;
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

  // Colour the header row, then the first column; the colours stay after a reload.
  await menu.getByRole('button', { name: 'Row color' }).click();
  await menu.getByRole('menuitem', { name: 'Gray background' }).click();
  await expect(table.locator('th[data-color="gray_background"]')).toHaveCount(4);
  await table.locator('td').first().click();
  await menu.getByRole('button', { name: 'Column color' }).click();
  await menu.getByRole('menuitem', { name: 'Blue text' }).click();
  await expect(table.locator('td[data-color="blue"]')).toHaveCount(3);
  await expect(table.locator('th').first()).toHaveAttribute('data-color', 'blue');
  await waitForIndexed(window, 'Joint');
  await quit(launched.app);
  ({ window } = await launch());
  await expect(editor(window).locator('th').nth(1)).toHaveAttribute(
    'data-color',
    'gray_background',
  );
  await expect(editor(window).locator('td[data-color="blue"]')).toHaveCount(3);
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
