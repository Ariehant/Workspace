/**
 * Phase 8 N8 (#22): "can create pages". Ada (owner, a desktop) shares her database "Tasks"
 * with Bob (member, another desktop) as "Can create pages":
 *
 * - Bob adds a page with New and writes in it; Ada sees it live.
 * - Ada's pages are read-only for him, and the views can't be edited.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addRow, newDatabase, titles } from './db';
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
  root = mkdtempSync(join(tmpdir(), 'workspace-create-'));
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

test('Ada shares her request tracker with Bob as "Can create pages"', async () => {
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

  // Ada shares "Tasks" (a database, so "Can create pages" is offered).
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Person or group').selectOption({ label: 'Bob (bob@lab.io)' });
  await share.getByLabel('Role').selectOption('create');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(share.getByLabel('Access for Bob')).toHaveValue('create', { timeout: 10_000 });
  await shot(A, 'create-1-share');
  await A.keyboard.press('Escape');
});

test('Bob adds his own page and edits it; Ada’s stay hers', async () => {
  const B = bob.window;
  await expect(sidebarTitles(B).filter({ hasText: /^Tasks$/ })).toHaveCount(1, {
    timeout: 15_000,
  });
  await sidebarTitles(B)
    .filter({ hasText: /^Tasks$/ })
    .click();
  await expect(titles(B)).toHaveText(['Grease the gears', 'Tighten the bolts']);
  await expect(B.getByTestId('access-badge')).toHaveText('Can create pages');
  await expect(B.getByRole('button', { name: 'Add a view' })).toHaveCount(0);

  // New: a page of his, opened to write in.
  await B.getByRole('button', { name: 'New', exact: true }).click();
  const peek = B.getByTestId('row-peek');
  await expect(peek).toBeVisible();
  await peek.getByLabel('Page title').fill('Request: a soft gripper');
  await peek.getByLabel('Page title').press('Enter');
  await B.keyboard.type('Two fingers, silicone.');
  await expect(peek.getByTestId('page-editor')).toContainText('Two fingers, silicone.');
  await peek.getByRole('button', { name: 'Close' }).click();
  await synced(B);
  await expect(
    titles(ada.window).getByText('Request: a soft gripper', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await shot(B, 'create-2-bob');

  // Ada's page: open to read, not to change.
  await titles(B).getByText('Grease the gears', { exact: true }).hover();
  await B.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(peek.getByLabel('Page title')).toHaveValue('Grease the gears');
  await expect(peek.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await peek.getByRole('button', { name: 'Close' }).click();

  // His own, again: still his to edit.
  await titles(B).getByText('Request: a soft gripper', { exact: true }).hover();
  await B.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(peek.getByLabel('Page title')).not.toHaveAttribute('readonly', '');
  await expect(peek.getByTestId('page-editor')).toContainText('Two fingers, silicone.');
  await peek.getByRole('button', { name: 'Close' }).click();
  // Nothing he did was refused: Ada reads his page.
  await synced(B);
  await expect(titles(ada.window)).toHaveCount(3);
  const A = ada.window;
  await titles(A).getByText('Request: a soft gripper', { exact: true }).hover();
  await A.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(A.getByTestId('row-peek').getByTestId('page-editor')).toContainText(
    'Two fingers, silicone.',
    { timeout: 15_000 },
  );
  await A.getByTestId('row-peek').getByRole('button', { name: 'Close' }).click();
});
