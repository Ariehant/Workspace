/**
 * The README's screenshots: a workspace made from the built-in templates and a page of
 * rich content, in the light and dark themes. Skipped unless asked for:
 *
 *   README_SHOTS=../../docs/images xvfb-run -a npx playwright test e2e/readme-shots.spec.ts
 */
import { resolve } from 'node:path';
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

  // The slash menu, at the end of the page.
  await editor(window).first().locator('p').last().click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
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

  // The dark theme.
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitemradio', { name: 'Dark' }).click();
  await window.keyboard.press('Escape');
  await open(window, 'Rover arm');
  await shot(window, 'dark');
});
