import type { Page } from '@playwright/test';
import { editor, expect, quit, settle, test } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

const openPage = (window: Page, title: string) =>
  window.getByRole('treeitem').filter({ hasText: title }).first().click();
const codeText = (window: Page) =>
  editor(window)
    .locator('.ws-code-block code')
    .first()
    .evaluate((el) => {
      // The text without line-number widgets.
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.ws-line-number').forEach((n) => n.remove());
      return clone.textContent;
    });

test('mermaid: renders the diagram, code/preview/split, errors, kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Arch');
  await slash(window, 'mermaid');
  const block = editor(window).locator('.ws-code-block');
  await expect(block.locator('code')).toHaveClass(/language-mermaid/);
  await expect(block.locator('code')).toContainText('A[Start] --> B[Finish]');
  const diagram = block.getByTestId('mermaid-diagram');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  await expect(diagram).toHaveAttribute('src', /^data:image\/svg\+xml/);
  // The source is highlighted too.
  await expect(block.locator('.hljs-keyword').first()).toHaveText('graph');

  // Editing re-renders; a syntax error shows under the code.
  // The cursor is still at the end of the inserted source.
  await window.keyboard.type('\n  B --> C[Robot');
  await expect(block.getByTestId('mermaid-error')).toBeVisible({ timeout: 10_000 });
  await window.keyboard.type(']');
  await expect(block.getByTestId('mermaid-error')).toHaveCount(0, { timeout: 10_000 });
  await expect(diagram).toBeVisible();
  const src = (await diagram.getAttribute('src')) ?? '';
  expect(decodeURIComponent(src)).toContain('Robot');

  await block.hover();
  await block.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(block.locator('pre').first()).toBeHidden();
  await expect(diagram).toBeVisible();
  await block.hover();
  await block.getByRole('button', { name: 'Code', exact: true }).click();
  await expect(block.getByTestId('mermaid')).toHaveCount(0);
  await expect(block.locator('pre').first()).toBeVisible();
  await block.hover();
  await block.getByRole('button', { name: 'Preview', exact: true }).click();

  await quit(first.app);
  ({ window } = await launch());
  await openPage(window, 'Arch');
  const again = editor(window).locator('.ws-code-block');
  await expect(again).toHaveAttribute('data-mermaid-view', 'preview');
  await expect(again.getByTestId('mermaid-diagram')).toBeVisible({ timeout: 15_000 });
});

test('code blocks: indent selected lines, line numbers, caption, lazy languages', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Build');
  await slash(window, 'code');
  await window.keyboard.type('add_executable(robot main.cpp)');
  await window.keyboard.press('Enter');
  await window.keyboard.type('b()');
  await window.keyboard.press('Enter');
  await window.keyboard.type('c()');

  // Select the last two lines, indent them, outdent again.
  await settle(window);
  await window.keyboard.press('Shift+ArrowUp');
  await window.keyboard.press('Tab');
  await expect
    .poll(() => codeText(window))
    .toBe('add_executable(robot main.cpp)\n    b()\n    c()');
  await window.keyboard.press('Shift+Tab');
  const code = 'add_executable(robot main.cpp)\nb()\nc()';
  await expect.poll(() => codeText(window)).toBe(code);

  const block = editor(window).locator('.ws-code-block');
  await block.hover();
  await block.getByRole('button', { name: 'Line numbers' }).click();
  await expect(block.locator('.ws-line-number')).toHaveText(['1', '2', '3']);
  await block.getByRole('button', { name: 'Caption' }).click();
  await block.getByLabel('Code caption').fill('Startup sequence');

  // Copy keeps the plain text (no line numbers).
  await first.app.evaluate(({ clipboard }) => clipboard.clear());
  await block.hover();
  await block.getByRole('button', { name: 'Copy code' }).click();
  await expect.poll(() => first.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(code);

  // A language outside the common set loads when picked.
  await block.getByLabel('Code language').selectOption('cmake');
  await expect(block.locator('code')).toHaveClass(/language-cmake/);
  await expect(block.locator('.hljs-built_in, .hljs-keyword').first()).toBeVisible();

  await quit(first.app);
  ({ window } = await launch());
  await openPage(window, 'Build');
  const again = editor(window).locator('.ws-code-block');
  await expect(again.getByLabel('Code caption')).toHaveValue('Startup sequence');
  await expect(again.locator('.ws-line-number')).toHaveCount(3);
  // Highlighted again once the grammar loads.
  await expect(again.locator('.hljs-built_in, .hljs-keyword').first()).toBeVisible();
});

test('equations: live preview and errors, workspace macros, copy LaTeX', async ({ launch }) => {
  const { app, window } = await launch();
  await newPage(window, 'Kinematics');
  await window.keyboard.type('$$ ');
  const mathEditor = window.getByTestId('math-editor');
  const tex = mathEditor.getByLabel('TeX equation');
  await tex.fill('\\frac{1}{');
  await expect(mathEditor.getByTestId('math-error')).toBeVisible();
  await tex.fill('T \\in \\SE(3)');
  // \SE isn't defined yet.
  await expect(mathEditor.getByTestId('math-error')).toContainText('\\SE');

  await mathEditor.getByRole('button', { name: 'Macros' }).click();
  await mathEditor.getByLabel('Equation macros').fill('\\SE \\mathrm{SE}\nnot a macro');
  await expect(mathEditor.getByTestId('math-macros')).toContainText("Line 2 isn't a macro");
  await mathEditor.getByLabel('Equation macros').fill('\\SE \\mathrm{SE}');
  await mathEditor.getByRole('button', { name: 'Save macros' }).click();
  await expect(mathEditor.getByTestId('math-error')).toHaveCount(0);
  await expect(mathEditor.getByTestId('math-preview').locator('.katex')).toBeVisible();

  await app.evaluate(({ clipboard }) => clipboard.clear());
  await mathEditor.getByRole('button', { name: 'Copy LaTeX' }).click();
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toBe('T \\in \\SE(3)');
  await tex.press('Control+Enter');
  const block = editor(window).locator('[data-type="block-math"]');
  await expect(block.locator('.katex')).toBeVisible();
  await expect(block.locator('.katex-error')).toHaveCount(0);
  await expect(block.locator('.katex')).toContainText('SE(3)');

  // Macros belong to the workspace: other pages use them too.
  await settle(window);
  await newPage(window, 'Dynamics');
  await window.keyboard.type('Pose $$T \\in \\SE(3)$$ ');
  const inline = editor(window).locator('[data-type="inline-math"]');
  await expect(inline.locator('.katex')).toContainText('SE(3)');
  await expect(inline.locator('.katex-error')).toHaveCount(0);
});
