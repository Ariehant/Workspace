/**
 * Phase 7 M2: axe-core on every main screen and dialog, in both themes, with no violations
 * allowed (WCAG 2.1 A and AA, and axe's best practices). The second test does the screens a
 * server workspace adds: sharing, members, the inbox and comments.
 */
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addProperty, addRow, newDatabase } from './db';
import { editor, expect, launchApp, test } from './helpers';
import { startSyncServer } from './server';

const THEMES = ['Light', 'Dark'] as const;

/**
 * No axe violations on what the window shows now. `modal`: a menu or dialog is open, and it
 * hides the rest of the app from assistive technology (`aria-hidden` on the app, focus kept
 * in the menu), which axe reads as hidden-but-focusable content and a page without its
 * main landmark or heading; those rules are for the page underneath, checked without it.
 */
async function expectAccessible(
  window: Page,
  screen: string,
  { modal = false, allow = [] as string[] } = {},
) {
  await window.waitForTimeout(250); // menus and dialogs finish opening
  const result = await new AxeBuilder({ page: window })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    // Menus and popovers render outside the app's landmarks, at the end of <body>.
    .disableRules([
      'region',
      ...(modal ? ['aria-hidden-focus', 'landmark-one-main', 'page-has-heading-one'] : []),
      ...allow,
    ])
    .analyze();
  const found = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes
        .slice(0, 4)
        .map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.replace(/\n/g, ' ')}`)
        .join('\n'),
  );
  expect(found, `axe on ${screen}`).toEqual([]);
}

async function setTheme(window: Page, theme: (typeof THEMES)[number]) {
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitemradio', { name: theme }).click();
  await window.keyboard.press('Escape');
  await expect(window.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
}

/** Open a menu or dialog with `open`, check it, and close it with Escape. */
async function checkOpen(
  window: Page,
  screen: string,
  open: () => Promise<void>,
  allow: string[] = [],
) {
  await open();
  await expectAccessible(window, screen, { modal: true, allow });
  await window.keyboard.press('Escape');
}

for (const theme of THEMES) {
  test(`the main screens and dialogs, ${theme.toLowerCase()} theme`, async ({ launch }) => {
    test.setTimeout(180_000);
    const { window } = await launch();
    await setTheme(window, theme);
    const s = (name: string) => `${name} (${theme})`;
    const sidebarButton = (name: string) => window.getByRole('button', { name, exact: true });

    await expectAccessible(window, s('a page'));
    await checkOpen(window, s('the appearance menu'), () => sidebarButton('Appearance').click());
    await checkOpen(window, s('the workspace menu'), () =>
      window.getByRole('button', { name: /workspace menu/i }).click(),
    );
    await checkOpen(window, s('the page menu'), () =>
      window.getByRole('button', { name: 'Page options' }).click(),
    );
    await checkOpen(window, s('quick find'), () => window.keyboard.press('Control+k'));
    await checkOpen(window, s('templates'), () => sidebarButton('Templates').click());
    await checkOpen(window, s('the trash'), () => sidebarButton('Trash').click());
    await checkOpen(window, s('sync settings'), () => window.getByTestId('sync-indicator').click());

    await checkOpen(window, s('language and region'), async () => {
      await window.getByRole('button', { name: /workspace menu/i }).click();
      await window.getByRole('menuitem', { name: 'Language and region…' }).click();
      await expect(window.getByTestId('region-dialog')).toBeVisible();
    });

    // A page of its own: the slash menu, page history and export.
    await window.getByRole('button', { name: 'New page' }).click();
    await window.getByLabel('Page title').fill('Checked');
    await window.getByLabel('Page title').press('Enter');
    await window.keyboard.type('Some text, then ');
    await window.keyboard.type('/');
    await expect(window.getByTestId('slash-menu')).toBeVisible();
    await expectAccessible(window, s('the slash menu'));
    await window.keyboard.press('Escape');
    await checkOpen(window, s('page history'), async () => {
      await window.getByRole('button', { name: 'Page options' }).click();
      await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Page history' }).click();
      await expect(window.getByTestId('history-dialog')).toBeVisible();
    });
    await checkOpen(window, s('export'), async () => {
      await window.getByRole('button', { name: 'Page options' }).click();
      await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Export…' }).click();
      await expect(window.getByTestId('export-dialog')).toBeVisible();
    });

    // A database in every layout, and its toolbar's panels.
    await newDatabase(window, 'Tasks');
    await addProperty(window, 'Select', 'Status');
    await addProperty(window, 'Date', 'When');
    await addRow(window, 'One');
    await addRow(window, 'Two');
    await window.keyboard.press('Escape');
    const database = window.getByTestId('database-view');
    await expectAccessible(window, s('a table'));
    for (const layout of ['Board', 'List', 'Gallery', 'Calendar', 'Timeline', 'Chart', 'Form']) {
      await database.getByRole('button', { name: 'Add a view' }).click();
      await window.getByTestId('add-view-menu').getByRole('menuitem', { name: layout }).click();
      await expect(database.getByRole('tab', { name: layout, selected: true })).toBeVisible();
      await expectAccessible(window, s(`a ${layout.toLowerCase()}`));
    }
    await database.getByRole('tab', { name: 'Table' }).click();
    for (const panel of ['Filter', 'Sort', 'Group']) {
      await checkOpen(window, s(`the ${panel.toLowerCase()} panel`), () =>
        database.getByRole('button', { name: panel, exact: true }).click(),
      );
    }
    // Known exception: the property and view menus start with a name field, as Notion's do,
    // and a menu may only hold items (docs/PHASE7.md, M2).
    await checkOpen(
      window,
      s('a property menu'),
      () =>
        window
          .getByTestId('table-view')
          .getByRole('columnheader', { name: /Status/ })
          .click(),
      ['aria-required-children'],
    );
    await checkOpen(window, s('a select cell'), async () => {
      await window.getByTestId('table-row').first().getByRole('gridcell').nth(1).click();
      await expect(window.getByTestId('cell-popover')).toBeVisible();
    });
    // A row opened as a page.
    await window.getByTestId('row-title').first().hover();
    await window
      .getByTestId('table-row')
      .first()
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await expect(window.getByTestId('row-peek')).toBeVisible();
    await expectAccessible(window, s('a row page'), { modal: true });
  });
}

test('the screens of a server workspace: sharing, members, the inbox and comments', async () => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'workspace-a11y-'));
  const server = await startSyncServer(root);
  const ada = await launchApp(join(root, 'ada'));
  try {
    const A = ada.window;
    await A.getByTestId('sync-indicator').click();
    const dialog = A.getByTestId('sync-dialog');
    await dialog.getByTestId('sync-server').fill(server.base);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expectAccessible(A, 'signing up', { modal: true });
    await dialog.getByTestId('sync-name').fill('Ada');
    await dialog.getByTestId('sync-email').fill('ada@lab.io');
    await dialog.getByTestId('sync-password').fill('correct horse battery');
    await dialog.getByTestId('sync-sign-in').click();
    await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
    await expectAccessible(A, 'choosing a workspace', { modal: true });
    await dialog.getByTestId('sync-start').click();
    await expect(A.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

    await A.getByRole('button', { name: 'New page' }).click();
    await A.getByLabel('Page title').fill('Gearbox');
    await A.getByLabel('Page title').press('Enter');
    await expect(editor(A)).toBeFocused();
    await A.keyboard.type('Planetary, three stages.');

    for (const theme of THEMES) {
      await setTheme(A, theme);
      const s = (name: string) => `${name} (${theme}, server)`;
      await expectAccessible(A, s('a page'));
      await checkOpen(A, s('the share menu'), () =>
        A.getByRole('button', { name: 'Share', exact: true }).click(),
      );
      await checkOpen(A, s('members'), async () => {
        await A.getByRole('button', { name: 'Members', exact: true }).click();
        await expect(A.getByTestId('members-dialog')).toBeVisible();
      });
      await checkOpen(A, s('the inbox'), () => A.getByTestId('inbox-button').click());
      await A.getByRole('button', { name: 'Comments' }).first().click();
      await expect(A.getByTestId('comments-panel')).toBeVisible();
      await expectAccessible(A, s('comments'));
      await A.getByRole('button', { name: 'Comments' }).first().click();
    }
  } finally {
    await ada.app.close().catch(() => {});
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
