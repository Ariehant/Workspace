/**
 * Phase 8 #19: the Dashboard view. "Parts" (Stage, Points) gets a Board and a Dashboard; the
 * dashboard starts with a page count and a chart by Stage, gets a sum of Points and the Board
 * as widgets, follows its own filter, rearranges, survives a restart, and passes axe.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, popover, table } from './db';
import { expect, quit, test } from './helpers';

const db = (window: Page) => window.getByTestId('database-view');
const dashboard = (window: Page) => window.getByTestId('dashboard-view');
const widgets = (window: Page) => dashboard(window).getByTestId('dashboard-widget');
const widget = (window: Page, title: string) =>
  widgets(window).filter({ has: window.getByRole('heading', { name: title, exact: true }) });

async function addView(window: Page, type: string) {
  await db(window).getByRole('button', { name: 'Add a view' }).click();
  await window
    .getByTestId('add-view-menu')
    .getByRole('menuitem', { name: type, exact: true })
    .click();
}

/** A menu item that opens a sub-menu (named with its "›"). */
const subMenu = (window: Page, name: string) =>
  window.getByRole('menuitem', { name: new RegExp(`^${name} ›$`) });

async function addWidget(window: Page, kind: string, view?: string) {
  await dashboard(window).getByRole('button', { name: 'Add a widget' }).click();
  if (!view) return window.getByRole('menuitem', { name: kind, exact: true }).click();
  // By keyboard: the menu sits at the window's right edge, so its sub-menu opens over it to
  // the left, and a pointer jumping straight there crosses the parent's items.
  await subMenu(window, kind).press('ArrowRight');
  await window.getByRole('menuitem', { name: view, exact: true }).press('Enter');
}

/** A widget's "…" menu, then a path of items through its sub-menus. */
async function widgetMenu(window: Page, of: Locator, ...path: string[]) {
  await of.getByRole('button', { name: /^Widget options/ }).click();
  const last = path.at(-1)!;
  // By keyboard, as in addWidget (a wide widget's menu is at the window's edge too).
  for (const name of path.slice(0, -1)) await subMenu(window, name).press('ArrowRight');
  const role = path.length > 1 ? 'menuitemradio' : 'menuitem';
  await window.getByRole(role, { name: last, exact: true }).press('Enter');
}

test('dashboard: starter widgets, a sum, a view widget, its filter, rearranged, kept after restart', async ({
  launch,
}) => {
  test.setTimeout(120_000);
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Select', 'Stage');
  await addProperty(window, 'Number', 'Points');
  for (const [title, stage, points] of [
    ['Alpha', 'Doing', '10'],
    ['Beta', 'Done', '5'],
    ['Gamma', 'Doing', '3'],
  ] as const) {
    await addRow(window, title);
    await (await cell(window, title, 'Stage')).click();
    await popover(window).getByLabel('Search for an option').fill(stage);
    await window.keyboard.press('Enter');
    await expect(popover(window)).toHaveCount(0);
    await (await cell(window, title, 'Points')).click();
    await window.keyboard.type(points);
    await window.keyboard.press('Enter');
  }
  await window.keyboard.press('Escape');
  await addView(window, 'Board');
  await expect(window.getByTestId('board-view')).toBeVisible();

  // A new dashboard: how many pages, and a chart by Stage.
  await addView(window, 'Dashboard');
  await expect(widgets(window)).toHaveCount(2);
  await expect(widget(window, 'Pages').getByTestId('widget-number')).toHaveText('3');
  const chart = widget(window, 'By Stage');
  await expect(
    chart.locator('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value'),
  ).toHaveText(['No Stage', 'Doing', 'Done']);

  // A number: the sum of Points, in the property's format.
  await addWidget(window, 'Number');
  await expect(widgets(window)).toHaveCount(3);
  await widgetMenu(window, widgets(window).last(), 'Property', 'Points');
  await expect(widget(window, 'Count all · Points')).toBeVisible();
  await widgetMenu(window, widget(window, 'Count all · Points'), 'Calculate', 'Sum');
  await expect(widget(window, 'Sum · Points').getByTestId('widget-number')).toHaveText('18');
  // Named by hand.
  await widget(window, 'Sum · Points')
    .getByRole('button', { name: 'Sum · Points', exact: true })
    .click();
  const name = widgets(window).getByLabel('Widget title');
  await name.fill('Total points');
  await name.press('Enter');
  await expect(widget(window, 'Total points').getByTestId('widget-number')).toHaveText('18');

  // A view: the Board, over the dashboard's rows; "Open" goes to its tab.
  await addWidget(window, 'View', 'Board');
  const boardWidget = widget(window, 'Board');
  await expect(boardWidget.getByTestId('widget-view')).toHaveAttribute('data-view-type', 'board');
  await expect(boardWidget.getByTestId('card-title')).toHaveText(['Alpha', 'Gamma', 'Beta']);

  // The dashboard's filter applies to every widget: Points > 4.
  await db(window).getByRole('button', { name: 'Filter', exact: true }).click();
  await window.getByTestId('property-picker').getByRole('button', { name: 'Points' }).click();
  const filter = window.getByTestId('filter-popover');
  await filter.getByLabel('Condition').selectOption('gt');
  await filter.getByLabel('Filter value').fill('4');
  await window.keyboard.press('Escape');
  await expect(widget(window, 'Pages').getByTestId('widget-number')).toHaveText('2');
  await expect(widget(window, 'Total points').getByTestId('widget-number')).toHaveText('15');
  await expect(boardWidget.getByTestId('card-title')).toHaveText(['Alpha', 'Beta']);

  // Rearranged: the board first and full width; the chart removed.
  await expect(boardWidget).toHaveClass(/md:col-span-3/);
  await widgetMenu(window, boardWidget, 'Width', 'A third');
  await expect(boardWidget).toHaveClass(/md:col-span-1/);
  for (let i = 0; i < 3; i++) await widgetMenu(window, boardWidget, 'Move earlier');
  await widgetMenu(window, chart, 'Remove widget');
  await expect(widgets(window).getByRole('heading')).toHaveText(['Board', 'Pages', 'Total points']);

  // No axe violations on the dashboard (both themes are covered for the app in a11y.spec).
  const result = await new AxeBuilder({ page: window })
    .setLegacyMode()
    .include('[data-testid="dashboard-view"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .disableRules(['region'])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await boardWidget.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(
    db(window).getByRole('tab', { name: 'Board', exact: true, selected: true }),
  ).toBeVisible();
  await expect(window.getByTestId('board-view')).toBeVisible();

  // Kept after a restart.
  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await db(window).getByRole('tab', { name: 'Dashboard' }).click();
  await expect(widgets(window).getByRole('heading')).toHaveText(['Board', 'Pages', 'Total points']);
  await expect(widget(window, 'Total points').getByTestId('widget-number')).toHaveText('15');
  await expect(table(window)).toHaveCount(0);
});
