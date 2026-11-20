/**
 * Phase 8 #31: moving a page to another workspace. Ada syncs "Lab" from her desktop and also
 * has "Home" on the server. She moves "Gripper" (with its sub-page) to Home from the Move
 * dialog: it's in the trash in Lab, and in her private pages in Home, as her other desktop
 * (joined to Home) shows.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

const PASSWORD = 'correct horse battery';

let server: SyncServer;
let root: string;
const opened: Launched[] = [];

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-move-'));
  server = await startSyncServer(root);
});

test.afterAll(async () => {
  for (const launched of opened) await launched.app.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function launch(dir: string): Promise<Launched> {
  const launched = await launchApp(join(root, dir));
  opened.push(launched);
  return launched;
}

const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

async function signIn(window: Page, name?: string) {
  await window.getByTestId('sync-indicator').click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server.base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  if (name) await dialog.getByTestId('sync-name').fill(name);
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  return dialog;
}

async function rest<T>(method: string, path: string, token: string | null, body?: object) {
  const res = await fetch(`${server.base}${path}`, {
    method,
    headers: {
      'x-workspace-client': 'desktop',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
  return (await res.json()) as T;
}

test('a page moves to another workspace, with its sub-pages; the original goes to the trash', async () => {
  test.setTimeout(180_000);
  // Lab, synced from this desktop, with "Gripper" and its sub-page "Notes".
  const lab = await launch('lab');
  const L = lab.window;
  const start = await signIn(L, 'Ada');
  await start.getByTestId('sync-workspace-name').fill('Lab');
  await start.getByTestId('sync-start').click();
  await synced(L);
  await L.getByRole('button', { name: 'New page', exact: true }).click();
  await L.getByLabel('Page title').fill('Gripper');
  await L.getByLabel('Page title').press('Enter');
  await expect(editor(L)).toBeFocused();
  await L.keyboard.type('Two fingers, one servo.');
  await L.keyboard.press('Enter');
  await L.keyboard.type('/page');
  await expect(L.getByTestId('slash-menu').getByRole('option').first()).toHaveText(/^Page/);
  await L.keyboard.press('Enter');
  await L.getByLabel('Page title').fill('Notes');
  await L.getByLabel('Page title').press('Enter');
  await synced(L);
  await sidebarTitles(L)
    .filter({ hasText: /^Gripper$/ })
    .click();

  // Home: her other workspace on the server.
  const { token } = await rest<{ token: string }>('POST', '/api/auth/login', null, {
    email: 'ada@lab.io',
    password: PASSWORD,
    client: 'desktop',
  });
  await rest('POST', '/api/workspaces', token, { name: 'Home' });

  // Move to → another workspace → Home.
  await L.getByRole('button', { name: 'Page options' }).click();
  await L.getByRole('menuitem', { name: 'Move to', exact: true }).click();
  const workspaces = L.getByTestId('move-dialog').getByTestId('move-workspaces');
  await workspaces.getByRole('button', { name: 'Home' }).click();
  const confirm = L.getByTestId('move-workspace-dialog');
  await expect(confirm).toContainText('“Gripper”, its sub-pages, databases and files');
  await confirm.getByRole('button', { name: 'Move', exact: true }).click();
  await expect(confirm.getByRole('status')).toHaveText(
    '“Gripper” is in your private pages in Home. Here, it’s in the trash.',
    { timeout: 20_000 },
  );
  await confirm.getByRole('button', { name: 'Done' }).click();
  // Here: in the trash (restorable).
  await expect(L.getByText('This page is in Trash.')).toBeVisible({ timeout: 20_000 });
  await expect(sidebarTitles(L).filter({ hasText: /^Gripper$/ })).toHaveCount(0);

  // Her desktop on Home: the page and its sub-page, with its text.
  const home = await launch('home');
  const join = await signIn(home.window);
  await join.getByTestId('sync-remote-Home').click();
  await join.getByTestId('sync-replace').check();
  const closed = home.app.waitForEvent('close');
  await join.getByTestId('sync-start').click();
  await closed;
  const again = await launch('home');
  const H = again.window;
  await synced(H);
  await sidebarTitles(H)
    .filter({ hasText: /^Gripper$/ })
    .click();
  await expect(editor(H)).toContainText('Two fingers, one servo.');
  // Its link to the sub-page leads to the copy (the original isn't in Home).
  const link = editor(H).getByTestId('page-link');
  await expect(link).toHaveText('Notes');
  await link.click();
  await expect(H.getByLabel('Page title')).toHaveValue('Notes');
});
