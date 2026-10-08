/**
 * Phase 5 M6: the inbox and notifications, with two desktops (Ada and Bob) on one server.
 *
 * - Ada mentions Bob on a teamspace page: Bob's inbox counts it, and (his window away) the
 *   system shows it. Clicking it in the inbox opens the page.
 * - Bob comments on the page: Ada follows it (she wrote it), so she's told; the inbox
 *   opens the comment's thread.
 * - Bob turns mentions off as desktop notifications: the next one only reaches the inbox.
 * - Ada's own reminder shows once, though both her desktop and the server fire it.
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
  root = mkdtempSync(join(tmpdir(), 'workspace-inbox-'));
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

type Shown = { title: string; body: string; pageId: string | null; kind?: string };
const systemNotifications = (who: Launched) =>
  who.app.evaluate(() => (globalThis as { __notifications?: Shown[] }).__notifications ?? []);
/** Windows under Xvfb keep focus: say this app's are away (system notifications show). */
const away = (who: Launched) =>
  who.app.evaluate(() => void ((globalThis as { __e2eAway?: boolean }).__e2eAway = true));

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

test('a mention: Bob’s inbox counts it, the system shows it, and it opens the page', async () => {
  const A = ada.window;
  const B = bob.window;
  await away(bob);
  await A.getByRole('button', { name: 'Add a page to Engineering' }).click();
  await A.getByLabel('Page title').fill('Gearbox');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Planetary, three stages.');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Torque check by @Bo');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Bob/);
  await A.keyboard.press('Enter');
  await A.keyboard.type('please');
  await synced(A);

  await expect(unread(B)).toHaveText('1', { timeout: 20_000 });
  await expect
    .poll(() => systemNotifications(bob), { timeout: 10_000 })
    .toEqual([
      expect.objectContaining({
        title: 'Ada mentioned you in Gearbox',
        body: 'Torque check by please',
        kind: 'mention',
      }),
    ]);

  await B.getByTestId('inbox-button').click();
  await expect(inboxItems(B)).toHaveCount(1);
  await expect(inboxItems(B).getByTestId('inbox-headline')).toContainText(
    'Ada mentioned you in Gearbox',
  );
  await shot(B, 'inbox-1-bob-mentioned');
  await inboxItems(B)
    .getByRole('button', { name: /^Open: mention/ })
    .click();
  await expect(B.getByLabel('Page title')).toHaveValue('Gearbox');
  await expect(editor(B).getByTestId('mention')).toHaveText('@Bob');
  await expect(unread(B)).toHaveCount(0);
});

test('a comment reaches Ada, who follows the page; the inbox opens its thread', async () => {
  const A = ada.window;
  const B = bob.window;
  await A.getByRole('button', { name: 'Page options' }).click();
  const follow = A.getByTestId('page-menu').getByRole('menuitem', { name: 'Follow page' });
  await expect(follow).toBeVisible();
  await A.keyboard.press('Escape');
  // Ada goes elsewhere.
  await A.getByRole('button', { name: 'Add a page to Engineering' }).click();
  await A.getByLabel('Page title').fill('Notes');

  await B.getByLabel('Page title').hover();
  await B.getByRole('button', { name: 'Add comment' }).click();
  await B.getByTestId('page-comments').getByTestId('comment-input').fill('Done: 64:1 is fine.');
  await B.getByTestId('page-comments').getByTestId('comment-input').press('Enter');

  await expect(unread(A)).toHaveText('1', { timeout: 20_000 });
  await A.getByTestId('inbox-button').click();
  await expect(inboxItems(A).getByTestId('inbox-headline')).toContainText(
    'Bob commented in Gearbox',
  );
  await expect(inboxItems(A).getByTestId('inbox-text')).toHaveText('Done: 64:1 is fine.');
  await shot(A, 'inbox-2-ada-comment');
  await inboxItems(A)
    .getByRole('button', { name: /^Open: comment/ })
    .click();
  await expect(A.getByLabel('Page title')).toHaveValue('Gearbox');
  const thread = A.getByTestId('comments-panel').getByTestId('comment-thread');
  await expect(thread).toHaveAttribute('data-active', 'true');
  await expect(thread.getByTestId('comment-body')).toHaveText('Done: 64:1 is fine.');
});

test('mentions off as desktop notifications: the next one only reaches the inbox', async () => {
  const A = ada.window;
  const B = bob.window;
  await B.getByTestId('inbox-button').click();
  await B.getByRole('button', { name: 'Desktop notifications' }).click();
  await B.getByRole('menuitemcheckbox', { name: 'Mentions' }).click();
  await expect(B.getByRole('menuitemcheckbox', { name: 'Mentions' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await B.keyboard.press('Escape');
  await B.keyboard.press('Escape');

  await editor(A).click();
  await A.keyboard.press('Control+End');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Gear cutting: @Bo');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Bob/);
  await A.keyboard.press('Enter');
  await synced(A);
  await expect(unread(B)).toHaveText('1', { timeout: 20_000 });
  expect(await systemNotifications(bob)).toHaveLength(1);
});

test('a reminder Ada set shows once, from her desktop or the server', async () => {
  const A = ada.window;
  await away(ada);
  const before = (await systemNotifications(ada)).length;
  await editor(A).click();
  await A.keyboard.press('Control+End');
  await A.keyboard.press('Enter');
  // Overdue: the desktop fires it as soon as the page is indexed, the server soon after.
  await A.keyboard.type('Order bearings @remind yesterday');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Remind me/);
  await A.keyboard.press('Enter');
  await synced(A);
  await expect.poll(async () => (await systemNotifications(ada)).length).toBe(before + 1);
  // The server's copy arrives in the inbox, and isn't shown again.
  await expect(unread(A)).toHaveText('1', { timeout: 20_000 });
  await A.getByTestId('inbox-button').click();
  await expect(inboxItems(A).first()).toHaveAttribute('data-kind', 'reminder');
  await expect(inboxItems(A).first().getByTestId('inbox-headline')).toContainText(
    'Reminder in Gearbox',
  );
  // Whichever came first, the other stays quiet (the desktop indexes pages within a second).
  await A.waitForTimeout(2000);
  expect(await systemNotifications(ada)).toHaveLength(before + 1);
  await shot(A, 'inbox-3-reminder');
  // Bob isn't reminded of Ada's reminder.
  expect((await systemNotifications(bob)).filter((n) => n.title.startsWith('⏰'))).toEqual([]);
});
