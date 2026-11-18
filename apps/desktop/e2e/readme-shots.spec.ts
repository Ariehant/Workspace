/**
 * The README's screenshots: a workspace made from the built-in templates and a page of
 * rich content, in the light and dark themes. Skipped unless asked for:
 *
 *   README_SHOTS=../../docs/images xvfb-run -a npx playwright test e2e/readme-shots.spec.ts
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { editor, expect, test } from './helpers';

const out = process.env.README_SHOTS ? resolve(process.env.README_SHOTS) : null;

const ROVER = `## Goals

Pick up parts from a **moving conveyor** at 30 per minute, with a reach of *60 cm* and a payload of 2 kg. See the [calibration notes](https://example.com/calibration).

- [x] Inverse kinematics solver
- [x] Gripper force control
- [ ] Vision-guided picking

## Architecture

\`\`\`mermaid
flowchart LR
  camera[Camera] --> vision[Vision]
  vision --> planner[Planner]
  planner --> ik[IK solver]
  ik --> servos[Servos]
\`\`\`

## Joint limits

| Joint | Range | Max speed |
| --- | --- | --- |
| Shoulder | ±170° | 180°/s |
| Elbow | ±135° | 225°/s |
| Wrist | ±360° | 360°/s |

\`\`\`python
def reach(l1: float, l2: float, theta: float) -> float:
    return (l1**2 + l2**2 + 2 * l1 * l2 * cos(theta)) ** 0.5
\`\`\`
`;

test.skip(!out, 'Only when making the README screenshots (README_SHOTS=<dir>)');

async function shot(window: Page, name: string) {
  await window.waitForTimeout(600);
  await window.screenshot({ path: `${out}/${name}.png` });
}

const open = (window: Page, title: string) =>
  window
    .getByTestId('sidebar-page-title')
    .filter({ hasText: new RegExp(`^${title}$`) })
    .click();

test('README screenshots', async ({ launch }) => {
  test.setTimeout(180_000);
  const { app, window } = await launch();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));

  // A workspace from the templates gallery.
  for (const [category, name] of [
    ['Robotics lab', 'Experiment log'],
    ['Personal', 'Habit tracker'],
    ['Personal', 'Reading list'],
    ['Projects', 'Content calendar'],
    ['Projects', 'Tasks and projects'],
  ] as const) {
    await window.getByRole('button', { name: 'Templates', exact: true }).click();
    const gallery = window.getByTestId('templates-dialog');
    await gallery.getByRole('tab', { name: category }).click();
    await gallery.getByTestId('template-item').filter({ hasText: name }).click();
    await gallery.getByRole('button', { name: 'Use template' }).click();
    await expect(gallery).toHaveCount(0);
  }

  // A page of rich content, pasted as Markdown.
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill('Rover arm');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window).first()).toBeFocused();
  await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), ROVER);
  await window.keyboard.press('Control+V');
  await expect(window.getByTestId('mermaid-diagram')).toBeVisible({ timeout: 15_000 });
  await window
    .getByRole('group', { name: 'Diagram view' })
    .getByRole('button', { name: 'Preview' })
    .click();
  await window.getByLabel('Page title').hover();
  await window.getByRole('button', { name: 'Add icon' }).click();
  const icon = window.getByRole('button', { name: 'Change page icon' });
  await icon.click();
  await window.getByTestId('icon-picker').getByLabel('Search emoji').fill('robot');
  await window
    .getByTestId('icon-picker')
    .getByRole('button', { name: 'robot', exact: true })
    .click();
  await window.mouse.click(1300, 860);
  await shot(window, 'editor');

  // The slash menu, in the empty paragraph that ends the page (after the code block: Ctrl+End
  // would put the cursor in the code).
  await editor(window).first().locator('> p:last-child').click();
  await window.keyboard.type('/');
  await expect(window.getByTestId('slash-menu')).toBeVisible();
  await shot(window, 'slash-menu');
  await window.keyboard.press('Escape');
  await window.keyboard.press('Backspace');

  // Database views.
  const views: [string, string, string][] = [
    ['Reading list', 'By status', 'board'],
    ['Tasks and projects', 'Timeline', 'timeline'],
    ['Habit tracker', 'Calendar', 'calendar'],
  ];
  for (const [page, view, name] of views) {
    await open(window, page);
    await window.getByRole('tab', { name: view }).first().click();
    if (name === 'timeline') {
      await window.locator('select').filter({ hasText: 'Week' }).first().selectOption('month');
    }
    await shot(window, name);
  }

  // Phase 8: tabs, quick find's filters, bulk edit, a row page's layout, a Word document.
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill('Gripper test plan');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window).first()).toBeFocused();
  await window.keyboard.type('Each finger material is tested the same way.');
  await window.keyboard.press('Enter');
  await window.keyboard.type('/tabs');
  await window.keyboard.press('Enter');
  const tabs = editor(window).first().locator('.ws-tabs');
  await window.keyboard.type('Load cell under the fingertip, 10 grasps per material.');
  await window.keyboard.press('Enter');
  await window.keyboard.type('[] Calibrate the load cell');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Clamp the sample');
  // Clicking the open tab renames it.
  const rename = async (i: number, name: string) => {
    await tabs.getByRole('tab').nth(i).click();
    await tabs.getByLabel('Tab name').fill(name);
    await tabs.getByLabel('Tab name').press('Enter');
  };
  await rename(0, 'Setup');
  await tabs.getByRole('tab').nth(1).click();
  await window.keyboard.type('Silicone held 4.2 N before slipping.');
  await rename(1, 'Results');
  await tabs.getByRole('button', { name: 'Add tab' }).click();
  await window.keyboard.type('Try a softer silicone next.');
  await rename(2, 'Notes');
  await tabs.getByRole('tab', { name: 'Setup' }).click();
  await window.mouse.click(1300, 860);
  await shot(window, 'tabs');

  await window.keyboard.press('Control+k');
  const find = window.getByTestId('quick-find');
  await find.getByLabel('Search pages').fill('grip');
  await find.getByRole('button', { name: 'Edited: Any time' }).click();
  await window.getByRole('menuitemradio', { name: 'Past 7 days' }).click();
  await find.getByRole('button', { name: 'Sort: Best match' }).click();
  await window.getByRole('menuitemradio', { name: 'Last edited' }).click();
  await expect(find.getByTestId('quick-find-result').first()).toBeVisible({ timeout: 15_000 });
  await shot(window, 'quick-find');
  await window.keyboard.press('Escape');

  await window.keyboard.press('Control+k');
  await find.getByLabel('Search pages').fill('Tasks');
  await find
    .getByTestId('quick-find-result')
    .filter({ has: window.getByText('Tasks', { exact: true }) })
    .first()
    .click();
  const grid = window.getByTestId('table-view').first();
  for (const [i, shift] of [
    [0, false],
    [2, true],
  ] as const) {
    const taskRow = grid.getByTestId('table-row').nth(i);
    await taskRow.hover();
    await taskRow.getByTestId('row-check').click({ modifiers: shift ? ['Shift'] : [] });
  }
  await expect(window.getByTestId('bulk-count')).toHaveText('3 selected');
  await shot(window, 'bulk-edit');
  await window.keyboard.press('Escape');

  await window.keyboard.press('Control+k');
  await find.getByLabel('Search pages').fill('Gripper v2');
  await find
    .getByTestId('quick-find-result')
    .filter({ has: window.getByText('Gripper v2', { exact: true }) })
    .first()
    .click();
  const row = window.getByTestId('row-page');
  await row.getByRole('button', { name: 'Customize layout' }).click();
  const layout = window.getByTestId('layout-dialog');
  for (const name of ['Status', 'Start', 'End']) {
    await layout
      .getByRole('group', { name: /Pinned under the title/ })
      .getByLabel(name)
      .check();
  }
  await layout
    .getByRole('group', { name: 'Relations as sections of the page' })
    .getByLabel('Tasks')
    .check();
  await layout.getByTestId('layout-save').click();
  await expect(row.getByTestId('relation-section-page')).toHaveCount(3);
  await window.mouse.click(1300, 860);
  await shot(window, 'row-layout');

  const docx = fileURLToPath(
    new URL('../../../packages/importers/fixtures/docx/libreoffice.docx', import.meta.url),
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as never;
  }, docx);
  await window.getByRole('button', { name: 'Import', exact: true }).click();
  await window.getByTestId('import-report').getByRole('button', { name: 'Done' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Gripper design review');
  await window.mouse.click(1300, 860);
  await shot(window, 'word-import');

  // The dark theme.
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitemradio', { name: 'Dark' }).click();
  await window.keyboard.press('Escape');
  await open(window, 'Rover arm');
  await shot(window, 'dark');
});
