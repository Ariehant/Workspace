/**
 * Sharing a page by email, and who's online (the online check): Ada on the web app shares a
 * private page with Bob (a member, on a desktop) and Carol (no account yet, by email).
 *
 * - Bob gets the page at once; Carol's invite shows as pending, with Revoke.
 * - Ada's header shows Bob online while his desktop runs (it answers by itself).
 * - Ada's manual Ping shows Bob a toast that opens the page.
 * - Once Bob quits, the next check shows him offline.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { editor, expect, launchApp, test, type Launched } from './helpers';
import { startSyncServer, webDir, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let browser: Browser | null = null;
let A: Page;
let bob: Launched;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  root = mkdtempSync(join(tmpdir(), 'workspace-online-'));
  server = await startSyncServer(root, { web: true });
});

test.afterAll(async () => {
  await bob?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

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

test('setup: Ada on the web, Bob (member) on a desktop', async () => {
  const signup = async (email: string, name: string, invite?: string) =>
    (
      await api<{ token: string }>('POST', '/api/auth/signup', null, {
        email,
        name,
        password: PASSWORD,
        client: 'desktop',
        ...(invite ? { invite } : {}),
      })
    ).token;
  const adaToken = await signup('ada@lab.io', 'Ada');
  const workspaceId = (
    await api<{ workspace: { id: string } }>('POST', '/api/workspaces', adaToken, {
      name: 'Robotics lab',
    })
  ).workspace.id;
  await api('POST', `/api/workspaces/${workspaceId}/private`, adaToken);
  const { invites } = await api<{ invites: { link: string }[] }>(
    'POST',
    `/api/workspaces/${workspaceId}/invites`,
    adaToken,
    { emails: ['bob@lab.io'], role: 'member' },
  );
  await signup('bob@lab.io', 'Bob', invites[0]!.link.split('/invite/')[1]);

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  A = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  A.on('pageerror', (error) => console.error(`[web] ${error.stack ?? error}`));
  await A.goto(server!.base);
  await A.getByLabel('Email').fill('ada@lab.io');
  await A.getByLabel('Password').fill(PASSWORD);
  await A.getByRole('button', { name: 'Sign in' }).click();
  await A.getByTestId('workspace-picker')
    .getByRole('button', { name: /Robotics lab/ })
    .click();
  await expect(A.getByRole('button', { name: 'Add a page to Private' })).toBeVisible({
    timeout: 15_000,
  });

  // Bob's desktop: signed in, syncing the workspace (it restarts with the server's copy).
  let launched = await launchApp(join(root, 'bob'));
  const window = launched.window;
  await indicator(window).click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server!.base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-email').fill('bob@lab.io');
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-remote-Robotics lab').click();
  await dialog.getByTestId('sync-replace').check();
  const closed = launched.app.waitForEvent('close');
  await dialog.getByTestId('sync-start').click();
  await closed;
  launched = await launchApp(join(root, 'bob'));
  await expect(indicator(launched.window)).toHaveText('Synced', { timeout: 20_000 });
  bob = launched;
});

test('sharing by email: a member gets the page now, a new address a pending invite', async () => {
  await A.getByRole('button', { name: 'Add a page to Private' }).click();
  await A.getByLabel('Page title').fill('Plans');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Gearbox review on Friday.');

  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Email or group').fill('bob@lab.io, carol@else.io');
  await share.getByLabel('Role').selectOption('edit');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(share.getByTestId('access-row').filter({ hasText: 'Bob' })).toHaveCount(1, {
    timeout: 15_000,
  });
  const pending = share.getByTestId('share-pending-invite');
  await expect(pending).toHaveText([/carol@else\.io.*Can edit · pending/]);
  await expect(share.getByTestId('share-entry')).toHaveValue('');

  // A second invite to revoke.
  await share.getByLabel('Email or group').fill('dan@else.io');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(pending).toHaveCount(2);
  await pending.filter({ hasText: 'dan@else.io' }).getByRole('button', { name: 'Revoke' }).click();
  await expect(pending).toHaveText([/carol@else\.io/]);
  await A.keyboard.press('Escape');
  await expect(share).toHaveCount(0);
});

test('who’s online: Bob’s running desktop answers; a manual Ping reaches him', async () => {
  // Bob's desktop answers by itself, without the page open.
  await expect(A.getByTestId('online-indicator')).toHaveText('1 online · 0 offline', {
    timeout: 30_000,
  });
  await A.getByTestId('online-indicator').click();
  await expect(A.getByTestId('online-list').getByTestId('online-person')).toHaveText([/Bob$/]);
  await expect(A.getByTestId('online-status')).toContainText('checking every 20 s');

  // A Ping by hand (again once the last check is 10 s old): Bob sees who's asking.
  const B = bob.window;
  await expect(async () => {
    await A.getByTestId('online-ping').click({ timeout: 2_000 });
    await expect(B.getByTestId('ping-toast')).toHaveCount(1, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(B.getByTestId('ping-toast')).toContainText(
    'Ada is checking if you’re here, on Plans',
  );
  await B.getByTestId('ping-toast').getByRole('button', { name: 'Open' }).click();
  await expect(B.getByLabel('Page title')).toHaveValue('Plans', { timeout: 15_000 });
  await expect(B.getByTestId('ping-toast')).toHaveCount(0);
});

test('once Bob quits, the next check shows him offline', async () => {
  await bob.app.close();
  // A check after he's gone (by hand, once allowed): no answer within 5 s.
  await expect(async () => {
    await A.getByTestId('online-ping').click({ timeout: 2_000 });
    await expect(A.getByTestId('online-indicator')).toHaveText('0 online · 1 offline', {
      timeout: 8_000,
    });
  }).toPass({ timeout: 45_000 });
  await expect(A.getByTestId('offline-list').getByTestId('online-person')).toHaveText([/Bob$/]);
});
