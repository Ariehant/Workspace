/**
 * Phase 5 M2: the server decides who sees what. Ada uploads her workspace (its pages
 * start in her private scope) and invites Bob: his desktop joins and shows nothing.
 * When Ada opens her pages to the workspace, they arrive on Bob's desktop live. Then
 * Bob edits a page offline while Ada makes it view-only: on reconnecting, the server
 * refuses his edit, his page goes back to the server's copy, and the edit is kept in
 * the page's history ("Not saved").
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { Proxy, startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let a: Launched;
let b: Launched;
const dirA = () => join(root, 'ada');
const dirB = () => join(root, 'bob');
/** Bob reaches the server through this (so the test can take him offline). */
const proxy = new Proxy();
let workspaceId: string;
let scopeId: string;
let adaToken: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-access-'));
  server = await startSyncServer(root);
  await proxy.start(server.port);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  await proxy.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function launch(dir: string): Promise<Launched> {
  const launched = await launchApp(dir);
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

/** Who may do what in Ada's pages (her first scope): `workspace` is every member. */
const setWorkspaceRole = (role: 'edit' | 'view' | null) =>
  api('PUT', `/api/workspaces/${workspaceId}/scopes/${scopeId}/access`, adaToken, {
    principal: 'workspace',
    role,
  });

const indicator = (window: Page) => window.getByTestId('sync-indicator');
const synced = (window: Page) =>
  expect(indicator(window)).toHaveText('Synced', { timeout: 20_000 });

const pageTitle = (window: Page, title: string) =>
  sidebarTitles(window).filter({ hasText: new RegExp(`^${title}$`) });

async function openPage(window: Page, title: string) {
  await pageTitle(window, title).first().click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

async function signIn(window: Page, server: string, email: string, name?: string) {
  await indicator(window).click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  if (name) await dialog.getByTestId('sync-name').fill(name);
  await dialog.getByTestId('sync-email').fill(email);
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  return dialog;
}

test('a member sees nothing of private pages, then gets them live when shared', async () => {
  // Ada: an account, a page, and her workspace uploaded (its pages start private).
  a = await launch(dirA());
  await a.window.getByRole('button', { name: 'New page' }).click();
  await a.window.getByLabel('Page title').fill('Gripper');
  await a.window.getByLabel('Page title').press('Enter');
  await a.window.keyboard.type('Two-finger gripper, 140 mm stroke.');
  const dialog = await signIn(a.window, server!.base, 'ada@lab.io', 'Ada');
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await dialog.getByTestId('sync-start').click();
  await synced(a.window);

  // Ada invites Bob (over the API: the members screen is M1's, tested there).
  adaToken = (
    await api<{ token: string }>('POST', '/api/auth/login', null, {
      email: 'ada@lab.io',
      password: PASSWORD,
      client: 'desktop',
    })
  ).token;
  const { workspaces } = await api<{ workspaces: { id: string; name: string }[] }>(
    'GET',
    '/api/workspaces',
    adaToken,
  );
  workspaceId = workspaces.find((w) => w.name === 'Robotics lab')!.id;
  const { invites } = await api<{ invites: { link: string }[] }>(
    'POST',
    `/api/workspaces/${workspaceId}/invites`,
    adaToken,
    { emails: ['bob@lab.io'], role: 'member' },
  );
  await api('POST', '/api/auth/signup', null, {
    email: 'bob@lab.io',
    name: 'Bob',
    password: PASSWORD,
    invite: invites[0]!.link.split('/invite/')[1],
  });
  const scopes = await api<{ defaultScopeId: string; scopes: { id: string; kind: string }[] }>(
    'GET',
    `/api/workspaces/${workspaceId}/scopes`,
    adaToken,
  );
  scopeId = scopes.defaultScopeId;
  expect(scopes.scopes.find((s) => s.id === scopeId)?.kind).toBe('private');

  // Bob's desktop takes the workspace: nothing of it is his to see.
  b = await launch(dirB());
  const bob = await signIn(b.window, `http://127.0.0.1:${proxy.port}`, 'bob@lab.io');
  await bob.getByTestId('sync-remote-Robotics lab').click();
  await bob.getByTestId('sync-replace').check();
  const closed = b.app.waitForEvent('close');
  await bob.getByTestId('sync-start').click();
  await closed;
  b = await launch(dirB());
  await synced(b.window);
  await expect(sidebarTitles(b.window)).toHaveCount(0);
  await shot(b.window, 'access-1-bob-before');

  // Ada opens her pages to everyone in the workspace: they arrive on Bob's desktop.
  await setWorkspaceRole('edit');
  await expect(pageTitle(b.window, 'Gripper')).toHaveCount(1, { timeout: 15_000 });
  await openPage(b.window, 'Gripper');
  await expect(editor(b.window)).toContainText('Two-finger gripper, 140 mm stroke.');
  await shot(b.window, 'access-2-bob-shared');

  // Bob can edit: it reaches Ada.
  await editor(b.window).click();
  await b.window.keyboard.press('Control+End');
  await b.window.keyboard.press('Enter');
  await b.window.keyboard.type('Bob: fingertips in TPU.');
  await openPage(a.window, 'Gripper');
  await expect(editor(a.window)).toContainText('Bob: fingertips in TPU.', { timeout: 15_000 });
});

test('an edit made offline after losing edit access is refused and kept in history', async () => {
  const B = b.window;
  await synced(B);
  proxy.cut();
  await expect(indicator(B)).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
  await openPage(B, 'Gripper');
  await editor(B).click();
  await B.keyboard.press('Control+End');
  await B.keyboard.press('Enter');
  await B.keyboard.type('Offline: switch to a parallel jaw.');
  await expect(indicator(B)).toContainText(/Offline · \d+ changes? to sync/);
  // The edit also marks the page "last edited" in the page tree (indexed shortly after).
  await B.waitForTimeout(1500);

  // Meanwhile Ada makes her pages view-only for the workspace.
  await setWorkspaceRole('view');

  proxy.restore();
  // The server refuses both changes and sends its copies back: the window loads again.
  await b.app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  const R = b.window;
  await expect(editor(R)).not.toContainText('Offline: switch to a parallel jaw.', {
    timeout: 20_000,
  });
  await synced(R);
  await openPage(R, 'Gripper');
  await expect(editor(R)).toContainText('Bob: fingertips in TPU.');
  await expect(editor(R)).not.toContainText('Offline: switch to a parallel jaw.');
  await expect(editor(a.window)).not.toContainText('Offline: switch to a parallel jaw.');

  // His edit isn't lost: it's in the page's history.
  await R.getByRole('button', { name: 'Page options' }).click();
  await R.getByTestId('page-menu').getByRole('menuitem', { name: 'Page history' }).click();
  const history = R.getByTestId('history-dialog');
  const notSaved = history
    .getByTestId('history-version')
    .filter({ hasText: 'Not saved: your access changed' });
  await expect(notSaved).toHaveCount(1);
  await notSaved.click();
  await expect(history.getByTestId('history-preview')).toContainText(
    'Offline: switch to a parallel jaw.',
  );
  await shot(R, 'access-3-bob-not-saved');
});
