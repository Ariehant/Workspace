/**
 * Phase 8 N4: requests for access, with two desktops (Ada and Bob) on one server.
 *
 * - Ada mentions her private page on a teamspace page. Bob clicks the mention: he can't open
 *   it, so he's shown the no-access screen, and asks to edit it, with a message.
 * - Ada's inbox has his request; she shares the page from there. Bob's screen turns into
 *   the page, and his inbox says it was shared.
 * - Bob opens a link to another private page and asks again; Ada declines from the share
 *   dialog, and Bob sees that when he looks again.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { editor, expect, launchApp, test, type Launched } from './helpers';
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
  root = mkdtempSync(join(tmpdir(), 'workspace-requests-'));
  server = await startSyncServer(root);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await bob?.app.close().catch(() => {});
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

const unread = (window: Page) => window.getByTestId('inbox-unread');
const inboxItems = (window: Page) => window.getByTestId('inbox').getByTestId('inbox-item');

async function signIn(window: Page, email: string, name?: string) {
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

test('setup: Ada and Bob, each on a desktop, in a teamspace', async () => {
  ada = await launchApp(join(root, 'ada'));
  const dialog = await signIn(ada.window, 'ada@lab.io', 'Ada');
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await dialog.getByTestId('sync-start').click();
  await synced(ada.window);

  const token = (
    await api<{ token: string }>('POST', '/api/auth/login', null, {
      email: 'ada@lab.io',
      password: PASSWORD,
      client: 'desktop',
    })
  ).token;
  const { workspaces } = await api<{ workspaces: { id: string }[] }>(
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

  bob = await launchApp(join(root, 'bob'));
  const joining = await signIn(bob.window, 'bob@lab.io');
  await joining.getByTestId('sync-remote-Robotics lab').click();
  await joining.getByTestId('sync-replace').check();
  const closed = bob.app.waitForEvent('close');
  await joining.getByTestId('sync-start').click();
  await closed;
  bob = await launchApp(join(root, 'bob'));
  await synced(bob.window);
  for (const who of [ada, bob]) {
    await who.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
    );
    await expect(who.window.getByTestId('inbox-button')).toBeVisible({ timeout: 15_000 });
    await expect(who.window.getByRole('tree', { name: 'Engineering', exact: true })).toHaveCount(
      1,
      { timeout: 15_000 },
    );
  }
});

const roadmapAndBudget = async () => {
  const A = ada.window;
  await A.getByRole('button', { name: 'Add a page to Private' }).click();
  await A.getByLabel('Page title').fill('Budget plan');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Q3: two new arms.');
  await A.getByRole('button', { name: 'Add a page to Engineering' }).click();
  await A.getByLabel('Page title').fill('Roadmap');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Costs: @Budget');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Budget plan/);
  await A.keyboard.press('Enter');
  await synced(A);
};

test('Bob asks for Ada’s private page from a mention; she shares it from her inbox', async () => {
  const A = ada.window;
  const B = bob.window;
  await roadmapAndBudget();

  await B.getByRole('tree', { name: 'Engineering', exact: true })
    .getByText('Roadmap')
    .click({ timeout: 20_000 });
  const mention = editor(B).getByTestId('mention');
  await expect(mention).toHaveText('No access', { timeout: 20_000 });
  await mention.getByRole('link').click();
  const screen = B.getByTestId('no-access');
  await expect(screen.getByRole('heading')).toHaveText('You don’t have access to this page');
  // Nothing about the page itself.
  await expect(screen).not.toContainText('Budget');
  await screen.getByLabel('Access to ask for').selectOption({ label: 'Can edit' });
  await screen.getByLabel('Message (optional)').fill('For the Q3 review');
  await shot(B, 'requests-1-bob-asks');
  await screen.getByTestId('request-access').click();
  await expect(screen.getByTestId('access-requested')).toContainText('Access requested on');

  await expect(unread(A)).toHaveText('1', { timeout: 20_000 });
  await A.getByTestId('inbox-button').click();
  const item = A.getByTestId('inbox').locator('[data-testid="inbox-item"][data-kind="request"]');
  await expect(item.getByTestId('inbox-headline')).toContainText(
    'Bob requested access to Budget plan',
  );
  await expect(item.getByTestId('inbox-text')).toHaveText('For the Q3 review');
  const actions = item.getByTestId('request-actions');
  await expect(actions.getByLabel('Access to give')).toHaveValue('edit');
  await shot(A, 'requests-2-ada-inbox');
  await actions.getByRole('button', { name: 'Share' }).click();
  await expect(item.getByTestId('request-answer')).toHaveText('Shared by Ada');
  await A.keyboard.press('Escape');

  // Bob's screen becomes the page, which he can edit; his inbox says so.
  await expect(B.getByLabel('Page title')).toHaveValue('Budget plan', { timeout: 20_000 });
  await expect(editor(B)).toContainText('Q3: two new arms.');
  await expect(editor(B)).toHaveAttribute('contenteditable', 'true');
  await expect(unread(B)).toHaveText('1', { timeout: 20_000 });
  await B.getByTestId('inbox-button').click();
  await expect(inboxItems(B).getByTestId('inbox-headline')).toContainText(
    'Ada shared Budget plan with you',
  );
  await B.keyboard.press('Escape');
});

test('a link to a page he can’t open; Ada declines from the share dialog', async () => {
  const A = ada.window;
  const B = bob.window;
  await A.getByRole('button', { name: 'Add a page to Private' }).click();
  await A.getByLabel('Page title').fill('Salaries');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Confidential.');
  await synced(A);
  await ada.app.evaluate(({ clipboard }) => clipboard.clear());
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect
    .poll(() => ada.app.evaluate(({ clipboard }) => clipboard.readText()))
    .toMatch(/^workspace:\/\/page\//);
  const link = await ada.app.evaluate(({ clipboard }) => clipboard.readText());

  const screen = B.getByTestId('no-access');
  await expect
    .poll(
      async () => {
        await B.evaluate((url) => globalThis.open(url), link);
        return screen
          .getByRole('heading')
          .textContent()
          .catch(() => null);
      },
      { timeout: 20_000 },
    )
    .toBe('You don’t have access to this page');
  await screen.getByTestId('request-access').click();
  await expect(screen.getByTestId('access-requested')).toBeVisible();

  await A.getByRole('button', { name: 'Share' }).click();
  const share = A.getByTestId('share-dialog');
  const request = share.getByTestId('share-request');
  await expect(request).toContainText('Bob asks to view', { timeout: 20_000 });
  await shot(A, 'requests-3-share-dialog');
  await request.getByRole('button', { name: 'Decline' }).click();
  await expect(share.getByTestId('share-requests')).toHaveCount(0);
  await A.keyboard.press('Escape');

  // Bob looks again: declined, and he may ask again.
  await B.getByRole('tree', { name: 'Engineering', exact: true }).getByText('Roadmap').click();
  await B.evaluate((url) => globalThis.open(url), link);
  await expect(screen).toContainText('Your last request was declined');
  await expect(screen.getByTestId('request-access')).toBeVisible();
});
