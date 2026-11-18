/**
 * Phase 7 M2: the main tasks with the keyboard alone, reaching each control with Tab as
 * someone without a mouse would: writing and finding pages, editing a database, and
 * sharing a page.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { cell, table } from './db';
import { editor, expect, launchApp, sidebarTitles, test } from './helpers';
import { startSyncServer } from './server';

/** Press Tab (or Shift+Tab) until `target` has the focus; fails if it never does. */
async function tabTo(window: Page, target: Locator, { back = false } = {}) {
  for (let i = 0; i < 80; i++) {
    const focused = await target
      .evaluate((el) => el === document.activeElement, null, { timeout: 1000 })
      .catch(() => false);
    if (focused) return;
    await window.keyboard.press(back ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}

const focusedRow = (window: Page) =>
  window.locator('li[role="treeitem"]:focus > [data-testid="sidebar-row"]');

test('write pages and move between them with the keyboard only', async ({ launch }) => {
  const { window } = await launch();
  await window.keyboard.press('Control+n');
  await expect(window.getByLabel('Page title')).toBeFocused();
  await window.keyboard.type('Bench notes');
  await window.keyboard.press('Enter');
  // Typed straight after Enter: it all goes to the page, none to the title.
  await window.keyboard.type('Written without a mouse.');
  await expect(window.getByLabel('Page title')).toHaveValue('Bench notes');
  await expect(editor(window)).toHaveText('Written without a mouse.');

  // The page tree has one Tab stop, the open page; the arrows move and Enter opens.
  const tree = window.getByRole('tree', { name: 'Pages' });
  await tabTo(window, tree.getByRole('treeitem', { name: /Bench notes/ }), { back: true });
  await window.keyboard.press('ArrowUp');
  await expect(focusedRow(window)).toContainText('Getting started');
  await window.keyboard.press('Enter');
  await expect(window.getByLabel('Page title')).toHaveValue('Getting started');
  await window.keyboard.press('End');
  await expect(focusedRow(window)).toContainText('Bench notes');
  await window.keyboard.press(' ');
  await expect(window.getByLabel('Page title')).toHaveValue('Bench notes');

  // A page inside it, from the row's own button (shown when it has the focus).
  const addInside = tree
    .getByRole('treeitem', { name: /Bench notes/ })
    .getByRole('button', { name: 'Add a page inside' });
  await window.keyboard.press('Tab');
  await window.keyboard.press('Tab');
  await expect(addInside).toBeFocused();
  await expect(addInside).toBeVisible();
  await window.keyboard.press('Enter');
  await expect(window.getByLabel('Page title')).toBeFocused();
  await window.keyboard.type('Motor test');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Stall current 2.1 A.');
  await expect(sidebarTitles(window)).toHaveText(['Getting started', 'Bench notes', 'Motor test']);

  // ← collapses the parent, → opens it again and goes to its first page.
  await tabTo(window, tree.getByRole('treeitem', { name: /Motor test/ }), { back: true });
  await window.keyboard.press('ArrowLeft');
  await expect(focusedRow(window)).toContainText('Bench notes');
  await window.keyboard.press('ArrowLeft');
  await expect(sidebarTitles(window)).toHaveText(['Getting started', 'Bench notes']);
  await window.keyboard.press('ArrowRight');
  await expect(sidebarTitles(window)).toHaveText(['Getting started', 'Bench notes', 'Motor test']);
  await window.keyboard.press('ArrowRight');
  await expect(focusedRow(window)).toContainText('Motor test');

  // Quick find, by keyboard too.
  await window.keyboard.press('Control+k');
  await window.keyboard.type('motor');
  await expect(window.getByRole('option').first()).toContainText('Motor test');
  await window.keyboard.press('Enter');
  await expect(window.getByLabel('Page title')).toHaveValue('Motor test');
});

test('edit a database with the keyboard only', async ({ launch }) => {
  const { window } = await launch();
  await window.keyboard.press('Control+n');
  await window.keyboard.type('Parts');
  await window.keyboard.press('Enter');
  await window.keyboard.type('/database');
  await expect(window.getByTestId('slash-menu')).toContainText('Database - Inline');
  await window.keyboard.press('Enter');
  await expect(table(window)).toBeVisible();

  // A row from the table's "New", named straight away.
  await tabTo(window, window.getByTestId('table-new-row'));
  await window.keyboard.press('Enter');
  await window.keyboard.type('Servo');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('row-title')).toHaveText(['Servo']);

  // A number property from the header's "Add a property" menu (type-ahead picks it).
  await tabTo(window, table(window).getByRole('button', { name: 'Add a property' }));
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('add-property-menu')).toBeVisible();
  await window.keyboard.type('Num');
  await window.keyboard.press('Enter');
  const name = window.getByTestId('property-menu').getByLabel('Property name');
  await expect(name).toBeFocused();
  await name.press('Control+a');
  await window.keyboard.type('Torque');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect(table(window).getByRole('columnheader', { name: /Torque/ })).toBeVisible();

  // Into the grid: the first cell is selected; the arrows move, typing edits.
  await tabTo(window, table(window));
  await expect(await cell(window, 'Servo', 'Name')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await expect(await cell(window, 'Servo', 'Torque')).toHaveAttribute('aria-selected', 'true');
  await expect(table(window)).toHaveAttribute(
    'aria-activedescendant',
    (await (await cell(window, 'Servo', 'Torque')).getAttribute('id'))!,
  );
  await window.keyboard.type('12');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'Servo', 'Torque')).toHaveText('12');

  // A tag, from the select's own list.
  await window.keyboard.press('ArrowUp');
  await window.keyboard.press('ArrowLeft');
  await expect(await cell(window, 'Servo', 'Tags')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('cell-popover')).toBeVisible();
  await window.keyboard.type('actuator');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('cell-popover')).toHaveCount(0);
  await expect(await cell(window, 'Servo', 'Tags')).toHaveText('actuator');
  // Focus is back on the grid, for the next cell.
  await expect(table(window)).toBeFocused();
});

test('share a page with the keyboard only', async () => {
  test.setTimeout(120_000);
  const root = mkdtempSync(join(tmpdir(), 'workspace-keys-'));
  const server = await startSyncServer(root);
  const ada = await launchApp(join(root, 'ada'));
  try {
    const A = ada.window;
    await tabTo(A, A.getByTestId('sync-indicator'));
    await A.keyboard.press('Enter');
    const dialog = A.getByTestId('sync-dialog');
    await expect(dialog.getByTestId('sync-server')).toBeFocused();
    await A.keyboard.type(server.base);
    await A.keyboard.press('Enter');
    await expect(dialog.getByTestId('sync-name')).toBeVisible();
    await tabTo(A, dialog.getByTestId('sync-name'));
    await A.keyboard.type('Ada');
    await A.keyboard.press('Tab');
    await A.keyboard.type('ada@lab.io');
    await A.keyboard.press('Tab');
    await A.keyboard.type('correct horse battery');
    await A.keyboard.press('Enter');
    await expect(dialog.getByTestId('sync-workspace-name')).toBeVisible();
    await tabTo(A, dialog.getByTestId('sync-workspace-name'));
    await A.keyboard.type('Robotics lab');
    await A.keyboard.press('Enter');
    await expect(A.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

    await A.keyboard.press('Control+n');
    await A.keyboard.type('Gearbox');
    await A.keyboard.press('Enter');
    await A.keyboard.type('Planetary, three stages.');

    // Bob joins the workspace (through the server's API: not what this test is about).
    const call = async <T>(method: string, path: string, token: string | null, body?: object) => {
      const res = await fetch(`${server.base}${path}`, {
        method,
        headers: {
          'x-workspace-client': 'desktop',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.ok, `${method} ${path}`).toBe(true);
      return (await res.json()) as T;
    };
    const { token } = await call<{ token: string }>('POST', '/api/auth/login', null, {
      email: 'ada@lab.io',
      password: 'correct horse battery',
      client: 'desktop',
    });
    const { workspaces } = await call<{ workspaces: { id: string }[] }>(
      'GET',
      '/api/workspaces',
      token,
    );
    const { invites } = await call<{ invites: { link: string }[] }>(
      'POST',
      `/api/workspaces/${workspaces[0]!.id}/invites`,
      token,
      { emails: ['bob@lab.io'], role: 'member' },
    );
    await call('POST', '/api/auth/signup', null, {
      email: 'bob@lab.io',
      name: 'Bob',
      password: 'correct horse battery',
      invite: invites[0]!.link.split('/invite/')[1],
    });

    // Share the page with Bob: the person, the role, Invite.
    await expect(A.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });
    const share = A.getByRole('button', { name: 'Share', exact: true });
    await tabTo(A, share, { back: true });
    await A.keyboard.press('Enter');
    const shareDialog = A.getByTestId('share-dialog');
    const person = shareDialog.getByLabel('Person or group');
    await expect(person.locator('option', { hasText: 'Bob' })).toHaveCount(1);
    await tabTo(A, person);
    await A.keyboard.press('ArrowDown');
    await expect(person).not.toHaveValue('');
    await A.keyboard.press('Tab');
    await expect(shareDialog.getByLabel('Role')).toBeFocused();
    await A.keyboard.press('Tab');
    await expect(shareDialog.getByRole('button', { name: 'Invite' })).toBeFocused();
    await A.keyboard.press('Enter');
    await expect(shareDialog.getByRole('listitem').filter({ hasText: 'Bob' })).toHaveCount(1);

    // Escape closes it, and the focus goes back to Share (drawn anew: the page has its own
    // access now).
    await A.keyboard.press('Escape');
    await expect(shareDialog).toHaveCount(0);
    await expect(share).toBeFocused();
  } finally {
    await ada.app.close().catch(() => {});
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Notion’s shortcuts: move, duplicate, turn into, last colour, to-dos, and app keys', async ({
  launch,
}) => {
  const { window } = await launch();
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill('Shortcuts');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  for (const line of ['One', 'Two', 'Three']) {
    await window.keyboard.type(line);
    if (line !== 'Three') await window.keyboard.press('Enter');
  }
  const blocks = editor(window).locator(':scope > *');

  // Move the block up and down, duplicate it.
  await window.keyboard.press('Control+Shift+ArrowUp');
  await expect(blocks).toHaveText(['One', 'Three', 'Two']);
  await window.keyboard.press('Control+Shift+ArrowUp');
  await window.keyboard.press('Control+Shift+ArrowUp');
  await expect(blocks).toHaveText(['Three', 'One', 'Two']);
  await window.keyboard.press('Control+Shift+ArrowDown');
  await expect(blocks).toHaveText(['One', 'Three', 'Two']);
  await window.keyboard.press('Control+d');
  await expect(blocks).toHaveText(['One', 'Three', 'Three', 'Two']);

  // Turn into: a heading, a to-do (Ctrl+Enter checks it), text. (Straight after a click:
  // the shortcut reads where it put the cursor.)
  await blocks.nth(2).click();
  await window.keyboard.press('Control+Alt+2');
  await expect(blocks.nth(2)).toHaveJSProperty('tagName', 'H2');
  await window.keyboard.press('Control+Alt+4');
  const todo = editor(window).locator('ul[data-type="taskList"] > li');
  await expect(todo).toContainText('Three');
  await window.keyboard.press('Control+Enter');
  await expect(todo).toHaveAttribute('data-checked', 'true');
  await window.keyboard.press('Control+Alt+0');
  await expect(todo).toHaveCount(0);
  await expect(blocks).toHaveText(['One', 'Three', 'Three', 'Two']);

  // The colour used last, on another block.
  await window.keyboard.press('End');
  await window.keyboard.type(' /blue background');
  await window.keyboard.press('Enter');
  await expect(blocks.nth(2)).toHaveAttribute('data-color', 'blue_background');
  await blocks.first().click();
  await window.keyboard.press('Control+Shift+h');
  await expect(blocks.first()).toHaveAttribute('data-color', 'blue_background');

  // A sub-page here (Ctrl+Alt+9), up to its parent, back and forward.
  await blocks.last().click();
  await window.keyboard.press('End');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Control+Alt+9');
  await expect(window.getByLabel('Page title')).toHaveValue('');
  await window.getByLabel('Page title').fill('Child');
  await window.keyboard.press('Control+Shift+u');
  await expect(window.getByLabel('Page title')).toHaveValue('Shortcuts');
  await expect(editor(window).getByTestId('page-link')).toContainText('Child');
  await window.keyboard.press('Control+[');
  await expect(window.getByLabel('Page title')).toHaveValue('Child');
  await window.keyboard.press('Control+]');
  await expect(window.getByLabel('Page title')).toHaveValue('Shortcuts');

  // Dark mode, and the list of shortcuts.
  const theme = () => window.evaluate(() => document.documentElement.dataset.theme);
  const before = await theme();
  await window.keyboard.press('Control+Shift+l');
  await expect.poll(theme).toBe(before === 'dark' ? 'light' : 'dark');
  await window.keyboard.press('Control+Shift+l');
  await expect.poll(theme).toBe(before);
  await window.keyboard.press('Control+Shift+/');
  const dialog = window.getByTestId('shortcuts-dialog');
  await expect(dialog).toContainText('Ctrl+Shift+↑ / ↓');
  await window.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
