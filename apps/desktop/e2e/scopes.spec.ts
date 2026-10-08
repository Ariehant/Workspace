/**
 * Phase 5 M3: teamspaces, private pages and sharing in the app, with three people on a
 * real server: Ada (owner, a desktop), Bob (member, the web app) and Gus (guest, a
 * desktop).
 *
 * - Ada's pages start private; she makes the teamspace "Engineering" (everyone may view)
 *   and adds a page to it.
 * - Bob sees Engineering, view only (he can't type), and none of Ada's private pages.
 * - Ada shares one private page with Gus: it shows under his "Shared", and nothing else.
 * - Ada drags a private page into Engineering (confirmed): Bob sees it there, live.
 * - Ada takes Gus's access away: the page leaves his desktop.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, webDir, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let gus: Launched;
let browser: Browser | null = null;
let bob: Page;
let adaToken: string;
let workspaceId: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  root = mkdtempSync(join(tmpdir(), 'workspace-scopes-'));
  server = await startSyncServer(root, { web: true });
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await gus?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
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

const indicator = (window: Page) => window.getByTestId('sync-indicator');
const synced = (window: Page) =>
  expect(indicator(window)).toHaveText('Synced', { timeout: 20_000 });
/** A section's pages (its tree is named after it). */
const section = (window: Page, name: string) => window.getByRole('tree', { name, exact: true });
const titleIn = (window: Page, name: string, title: string) =>
  section(window, name)
    .getByTestId('sidebar-page-title')
    .filter({ hasText: new RegExp(`^${title}$`) });

async function openPage(window: Page, title: string) {
  await sidebarTitles(window)
    .filter({ hasText: new RegExp(`^${title}$`) })
    .first()
    .click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

/** Name the page just made, and type its first paragraph. */
async function fillPage(window: Page, title: string, text: string) {
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type(text);
}

async function joinOnDesktop(dir: string, email: string, name?: string): Promise<Launched> {
  const launched = await launch(dir);
  const window = launched.window;
  await indicator(window).click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server!.base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  if (name) await dialog.getByTestId('sync-name').fill(name);
  await dialog.getByTestId('sync-email').fill(email);
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  return launched;
}

test('the owner: private pages, and a teamspace everyone may view', async () => {
  ada = await joinOnDesktop('ada', 'ada@lab.io', 'Ada');
  const A = ada.window;
  const dialog = A.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await dialog.getByTestId('sync-start').click();
  await synced(A);
  // Her pages are her private pages.
  await expect(section(A, 'Private')).toHaveCount(1, { timeout: 15_000 });

  await A.getByRole('button', { name: 'Add a page to Private' }).click();
  await fillPage(A, 'Diary', 'Dear diary, the gripper slipped again.');
  await A.getByRole('button', { name: 'Add a page to Private' }).click();
  await fillPage(A, 'Specs', 'Payload 5 kg, reach 900 mm.');

  // A teamspace everyone in the workspace may view.
  await A.getByRole('button', { name: 'New teamspace' }).click();
  const make = A.getByTestId('new-teamspace-dialog');
  await make.getByLabel('Teamspace icon').fill('⚙️');
  await make.getByLabel('Teamspace name').fill('Engineering');
  await make.getByLabel('Everyone in the workspace').selectOption('view');
  await make.getByRole('button', { name: 'Create teamspace' }).click();
  await expect(section(A, 'Engineering')).toHaveCount(1, { timeout: 15_000 });
  await A.getByRole('button', { name: 'Add a page to Engineering' }).click();
  await fillPage(A, 'Gear plan', 'Twelve teeth, module 1.');
  await expect(titleIn(A, 'Engineering', 'Gear plan')).toHaveCount(1);
  await synced(A);
  await shot(A, 'scopes-1-ada-sections');

  // Bob (member) and Gus (guest) join.
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
  for (const [name, role] of [
    ['bob', 'member'],
    ['gus', 'guest'],
  ] as const) {
    const { invites } = await api<{ invites: { link: string }[] }>(
      'POST',
      `/api/workspaces/${workspaceId}/invites`,
      adaToken,
      { emails: [`${name}@lab.io`], role },
    );
    await api('POST', '/api/auth/signup', null, {
      email: `${name}@lab.io`,
      name: name === 'bob' ? 'Bob' : 'Gus',
      password: PASSWORD,
      invite: invites[0]!.link.split('/invite/')[1],
    });
  }
});

test('a member sees the teamspace, view only, and none of the private pages', async () => {
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

  await expect(titleIn(bob, 'Engineering', 'Gear plan')).toHaveCount(1, { timeout: 15_000 });
  await expect(section(bob, 'Private')).toHaveCount(1);
  await expect(sidebarTitles(bob).filter({ hasText: /Diary|Specs/ })).toHaveCount(0);

  await openPage(bob, 'Gear plan');
  await expect(editor(bob)).toContainText('Twelve teeth, module 1.');
  await expect(bob.getByTestId('access-badge')).toHaveText('View only');
  await expect(editor(bob)).toHaveAttribute('contenteditable', 'false');
  await expect(bob.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await shot(bob, 'scopes-2-bob-view-only');
});

test('sharing a private page with a guest shows it under their Shared, and only it', async () => {
  gus = await joinOnDesktop('gus', 'gus@lab.io');
  let dialog = gus.window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-remote-Robotics lab').click();
  await dialog.getByTestId('sync-replace').check();
  const closed = gus.app.waitForEvent('close');
  await dialog.getByTestId('sync-start').click();
  await closed;
  gus = await launch('gus');
  const G = gus.window;
  await synced(G);
  await expect(sidebarTitles(G)).toHaveCount(0);

  const A = ada.window;
  await openPage(A, 'Diary');
  await A.getByRole('button', { name: 'Share' }).click();
  dialog = A.getByTestId('share-dialog');
  await dialog.getByLabel('Person or group').selectOption({ label: 'Gus (gus@lab.io) · guest' });
  await dialog.getByLabel('Role').selectOption('view');
  await dialog.getByRole('button', { name: 'Invite' }).click();
  await expect(dialog.getByTestId('access-row').filter({ hasText: 'Gus' })).toHaveCount(1, {
    timeout: 10_000,
  });
  await shot(A, 'scopes-3-ada-share');
  await A.keyboard.press('Escape');
  // Still in Ada's private pages, where it was.
  await expect(titleIn(A, 'Private', 'Diary')).toHaveCount(1);

  await expect(titleIn(G, 'Shared', 'Diary')).toHaveCount(1, { timeout: 15_000 });
  await expect(sidebarTitles(G)).toHaveCount(1);
  await openPage(G, 'Diary');
  await expect(editor(G)).toContainText('Dear diary, the gripper slipped again.');
  await shot(G, 'scopes-4-gus-shared');
});

test('dragging a private page into the teamspace moves it there for everyone', async () => {
  const A = ada.window;
  A.once('dialog', (d) => void d.accept());
  const target = A.getByTestId('sidebar-section-teamspace').locator(
    '[data-testid^="sidebar-drop-end-"]',
  );
  await titleIn(A, 'Private', 'Specs').dragTo(target);
  await expect(titleIn(A, 'Engineering', 'Specs')).toHaveCount(1, { timeout: 15_000 });
  await expect(titleIn(A, 'Private', 'Specs')).toHaveCount(0);
  await expect(titleIn(bob, 'Engineering', 'Specs')).toHaveCount(1, { timeout: 15_000 });
  await openPage(bob, 'Specs');
  await expect(editor(bob)).toContainText('Payload 5 kg, reach 900 mm.');
});

test('taking the guest’s access away removes the page from their desktop', async () => {
  const A = ada.window;
  await openPage(A, 'Diary');
  await A.getByRole('button', { name: 'Share' }).click();
  const dialog = A.getByTestId('share-dialog');
  await dialog.getByRole('button', { name: 'Remove Gus' }).click();
  await expect(dialog.getByTestId('access-row')).toHaveCount(0, { timeout: 10_000 });
  await A.keyboard.press('Escape');

  const G = gus.window;
  await expect(sidebarTitles(G)).toHaveCount(0, { timeout: 15_000 });
  await expect(section(G, 'Shared')).toHaveCount(0);
});
