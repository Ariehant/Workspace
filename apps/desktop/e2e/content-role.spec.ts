/**
 * Phase 6 M1: "can edit content". Ada (owner, a desktop) shares her database "Tasks" with
 * Bob (member, another desktop) as "Can edit content":
 *
 * - Bob adds and edits rows, and Ada sees them live.
 * - He can't add a property or a view, nor create a select option.
 * - His filters are his own ("Only you see these"); Ada's view is unchanged.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addRow, cell, newDatabase, popover, table, titles } from './db';
import { expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let bob: Launched;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-content-'));
  server = await startSyncServer(root);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await bob?.app.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function launch(dir: string): Promise<Launched> {
  const launched = await launchApp(join(root, dir));
  await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
  );
  return launched;
}

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
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

async function signIn(launched: Launched, email: string, name?: string) {
  const window = launched.window;
  await window.getByTestId('sync-indicator').click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server!.base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  if (name) await dialog.getByTestId('sync-name').fill(name);
  await dialog.getByTestId('sync-email').fill(email);
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  return dialog;
}

test('Ada shares her database with Bob as "Can edit content"', async () => {
  ada = await launch('ada');
  const A = ada.window;
  const start = await signIn(ada, 'ada@lab.io', 'Ada');
  await start.getByTestId('sync-workspace-name').fill('Robotics lab');
  await start.getByTestId('sync-start').click();
  await synced(A);
  await newDatabase(A, 'Tasks');
  await addRow(A, 'Grease the gears');
  await addRow(A, 'Tighten the bolts');
  await synced(A);

  // Bob joins the workspace (invited), on his own desktop.
  const { token } = await api<{ token: string }>('POST', '/api/auth/login', null, {
    email: 'ada@lab.io',
    password: PASSWORD,
    client: 'desktop',
  });
  const { workspaces } = await api<{ workspaces: { id: string; name: string }[] }>(
    'GET',
    '/api/workspaces',
    token,
  );
  const workspaceId = workspaces.find((w) => w.name === 'Robotics lab')!.id;
  const { invites } = await api<{ invites: { link: string }[] }>(
    'POST',
    `/api/workspaces/${workspaceId}/invites`,
    token,
    { emails: ['bob@lab.io'], role: 'member' },
  );
  await api('POST', '/api/auth/signup', null, {
    email: 'bob@lab.io',
    name: 'Bob',
    password: PASSWORD,
    invite: invites[0]!.link.split('/invite/')[1],
  });
  bob = await launch('bob');
  const join = await signIn(bob, 'bob@lab.io');
  await join.getByTestId('sync-remote-Robotics lab').click();
  await join.getByTestId('sync-replace').check();
  const closed = bob.app.waitForEvent('close');
  await join.getByTestId('sync-start').click();
  await closed;
  bob = await launch('bob');
  await synced(bob.window);

  // Ada shares "Tasks" (a database, so "Can edit content" is offered).
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Person or group').selectOption({ label: 'Bob (bob@lab.io)' });
  await share.getByLabel('Role').selectOption('content');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(share.getByLabel('Access for Bob')).toHaveValue('content', { timeout: 10_000 });
  await shot(A, 'content-1-share');
  await A.keyboard.press('Escape');
});

test('Bob edits rows, not the database; his filters are his own', async () => {
  const B = bob.window;
  await expect(sidebarTitles(B).filter({ hasText: /^Tasks$/ })).toHaveCount(1, {
    timeout: 15_000,
  });
  await sidebarTitles(B)
    .filter({ hasText: /^Tasks$/ })
    .click();
  await expect(titles(B)).toHaveText(['Grease the gears', 'Tighten the bolts']);
  await expect(B.getByTestId('access-badge')).toHaveText('Can edit content');
  // The database itself is as if locked for him.
  await expect(table(B).getByRole('button', { name: 'Add a property' })).toHaveCount(0);
  await expect(B.getByRole('button', { name: 'Add a view' })).toHaveCount(0);
  await expect(B.getByRole('button', { name: 'Database options' })).toHaveCount(0);

  // Rows: he adds one; Ada sees it live.
  await addRow(B, 'Check the bearings');
  await synced(B);
  await expect(titles(ada.window).getByText('Check the bearings', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  // Existing select options only.
  await (await cell(B, 'Check the bearings', 'Tags')).click();
  await B.keyboard.press('Enter');
  await B.keyboard.type('urgent');
  await expect(popover(B)).toBeVisible();
  await expect(popover(B).getByText('Create', { exact: true })).toHaveCount(0);
  await B.keyboard.press('Escape');

  // A filter of his own.
  await B.getByRole('button', { name: 'Filter' }).click();
  await B.getByTestId('property-picker').getByRole('button', { name: 'Name' }).click();
  await expect(B.getByTestId('own-view')).toBeVisible();
  await B.keyboard.press('Escape');
  await shot(B, 'content-2-bob');
  await synced(B);
  // Not saved: Ada's view has no filter, and nothing of his was refused.
  await expect(ada.window.getByTestId('filter-bar')).toHaveCount(0);
  await expect(titles(ada.window)).toHaveCount(3);
  await B.getByTestId('own-view').getByRole('button', { name: 'Reset' }).click();
  await expect(B.getByTestId('filter-bar')).toHaveCount(0);
});
