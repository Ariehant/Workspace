/**
 * Phase 5 M4: presence. Ada (a desktop) and Bob (the web app) on the same teamspace page
 * see each other: avatars in the page header, a named cursor in the editor, a dot in the
 * sidebar on the page the other is viewing, and an avatar on the database row the other
 * has open. When one leaves, the other sees them go.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { addRow, titles } from './db';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, webDir, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let browser: Browser | null = null;
let bob: Page;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  root = mkdtempSync(join(tmpdir(), 'workspace-presence-'));
  server = await startSyncServer(root, { web: true });
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(300);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  token: string | null,
  body?: object,
): Promise<T> {
  const res = await fetch(`${server!.base}${path}`, {
    method,
    headers: {
      'x-workspace-client': 'desktop',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T;
  expect(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(json)}`).toBe(true);
  return json;
}

const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });
const inSection = (window: Page, name: string, title: string) =>
  window
    .getByRole('tree', { name, exact: true })
    .getByTestId('sidebar-page-title')
    .filter({ hasText: new RegExp(`^${title}$`) });

async function openPage(window: Page, title: string) {
  await sidebarTitles(window)
    .filter({ hasText: new RegExp(`^${title}$`) })
    .first()
    .click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

async function addPage(window: Page, section: string, title: string, text: string) {
  await window.getByRole('button', { name: `Add a page to ${section}` }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type(text);
}

/** Put the caret at the end of the page's text. */
async function caretAtEnd(window: Page) {
  await editor(window).click();
  await window.keyboard.press('Control+End');
}

test('setup: Ada’s desktop and Bob on the web, in a teamspace they both edit', async () => {
  ada = await launchApp(join(root, 'ada'));
  await ada.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
  );
  const A = ada.window;
  await A.getByTestId('sync-indicator').click();
  const dialog = A.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server!.base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-name').fill('Ada');
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await dialog.getByTestId('sync-start').click();
  await synced(A);

  const token = (
    await api<{ token: string }>('POST', '/api/auth/login', null, {
      email: 'ada@lab.io',
      password: PASSWORD,
      client: 'desktop',
    })
  ).token;
  const { workspaces } = await api<{ workspaces: { id: string; name: string }[] }>(
    'GET',
    '/api/workspaces',
    token,
  );
  const ws = workspaces[0]!.id;
  await api('POST', `/api/workspaces/${ws}/teamspaces`, token, {
    name: 'Engineering',
    everyone: 'edit',
  });
  const { invites } = await api<{ invites: { link: string }[] }>(
    'POST',
    `/api/workspaces/${ws}/invites`,
    token,
    { emails: ['bob@lab.io'], role: 'member' },
  );
  await api('POST', '/api/auth/signup', null, {
    email: 'bob@lab.io',
    name: 'Bob',
    password: PASSWORD,
    invite: invites[0]!.link.split('/invite/')[1],
  });

  await expect(A.getByRole('tree', { name: 'Engineering', exact: true })).toHaveCount(1, {
    timeout: 15_000,
  });
  await addPage(A, 'Engineering', 'Gearbox', 'Planetary, three stages.');
  await addPage(A, 'Engineering', 'Notes', 'Bearing loads to check.');
  // A database in the teamspace.
  await A.getByRole('button', { name: 'Add a page to Engineering' }).click();
  await A.getByLabel('Page title').fill('Parts');
  await A.getByTestId('get-started').getByRole('button', { name: 'Database' }).click();
  await expect(A.getByTestId('table-view')).toBeVisible();
  await addRow(A, 'Sun gear');
  await synced(A);

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  bob = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  bob.on('pageerror', (error) => console.error(`[web] ${error.stack ?? error}`));
  await bob.goto(server!.base);
  await bob.getByLabel('Email').fill('bob@lab.io');
  await bob.getByLabel('Password').fill(PASSWORD);
  await bob.getByRole('button', { name: 'Sign in' }).click();
  await bob
    .getByTestId('workspace-picker')
    .getByRole('button', { name: /Robotics lab/ })
    .click();
  await expect(inSection(bob, 'Engineering', 'Gearbox')).toHaveCount(1, { timeout: 15_000 });
});

test('on the same page: each other’s avatar, and a named cursor', async () => {
  const A = ada.window;
  await openPage(A, 'Gearbox');
  await caretAtEnd(A);
  await openPage(bob, 'Gearbox');
  await caretAtEnd(bob);

  await expect(A.getByRole('button', { name: 'Bob is here' })).toBeVisible({ timeout: 15_000 });
  await expect(bob.getByRole('button', { name: 'Ada is here' })).toBeVisible({ timeout: 15_000 });
  const bobsCursor = editor(A).locator('.ws-cursor', { hasText: 'Bob' });
  await expect(bobsCursor).toHaveCount(1, { timeout: 15_000 });
  await expect(editor(bob).locator('.ws-cursor', { hasText: 'Ada' })).toHaveCount(1, {
    timeout: 15_000,
  });

  // Bob types: his cursor moves with his text on Ada's screen.
  await bob.keyboard.type(' Ratio 64:1.');
  await expect(editor(A)).toContainText('Ratio 64:1.', { timeout: 10_000 });
  await expect(bobsCursor).toHaveCount(1);
  await shot(A, 'presence-1-ada-sees-bob');
  await shot(bob, 'presence-2-bob-sees-ada');
});

test('the sidebar shows which page the other is viewing', async () => {
  await openPage(bob, 'Notes');
  const dot = inSection(ada.window, 'Engineering', 'Notes')
    .locator('xpath=..')
    .getByTestId('page-viewers');
  await expect(dot).toHaveCount(1, { timeout: 15_000 });
  await expect(dot).toHaveAttribute('title', 'Bob viewing');
  // And the Gearbox header no longer shows him.
  await expect(ada.window.getByRole('button', { name: 'Bob is here' })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('a database row someone has open shows their avatar', async () => {
  const A = ada.window;
  await openPage(A, 'Parts');
  await openPage(bob, 'Parts');
  await titles(bob).getByText('Sun gear', { exact: true }).hover();
  await bob
    .getByTestId('table-row')
    .filter({ hasText: 'Sun gear' })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  const viewers = A.getByTestId('table-row')
    .filter({ hasText: 'Sun gear' })
    .getByTestId('row-viewers');
  await expect(viewers).toHaveCount(1, { timeout: 15_000 });
  await shot(A, 'presence-3-row-viewers');

  // Bob closes the browser: he's gone from Ada's screen.
  await bob.close();
  await expect(viewers).toHaveCount(0, { timeout: 15_000 });
});
