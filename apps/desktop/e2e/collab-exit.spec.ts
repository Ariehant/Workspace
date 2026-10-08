/**
 * Phase 5 exit check: several people co-edit, with the right permission checks. Three
 * accounts on one server: Ada (the owner) on the web app, Bob (a member) on a desktop that
 * reaches the server through a proxy (so the test can take him offline), and Gus (a guest)
 * on another desktop.
 *
 * - Ada's private pages never reach Bob's or Gus's desktop: their databases hold no trace.
 * - Ada and Bob co-edit a teamspace page live, with cursors and avatars.
 * - A page shared with Gus as "can comment": he comments and suggests; Ada accepts.
 * - A mention and a comment reply reach the right inboxes and desktop notifications.
 * - Bob edits offline; Ada makes the teamspace view-only; his edit is refused, kept in
 *   his history, and the page matches the server.
 * - Taking Gus's access away removes the page from his desktop.
 * - A published page reads signed out; its unpublished sub-page and other files don't.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { Proxy, startSyncServer, webDir, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
const proxy = new Proxy();
let browser: Browser | null = null;
let A: Page;
let bob: Launched;
let gus: Launched;
let workspaceId = '';
let teamspaceId = '';
let adaToken = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  root = mkdtempSync(join(tmpdir(), 'workspace-collab-exit-'));
  server = await startSyncServer(root, { web: true });
  await proxy.start(server.port);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await bob?.app.close().catch(() => {});
  await gus?.app.close().catch(() => {});
  await browser?.close().catch(() => {});
  await proxy.close().catch(() => {});
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

const indicator = (window: Page) => window.getByTestId('sync-indicator');
const synced = (window: Page) =>
  expect(indicator(window)).toHaveText('Synced', { timeout: 20_000 });
const titleIn = (window: Page, section: string, title: string) =>
  window
    .getByRole('tree', { name: section, exact: true })
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

/** A desktop on `dir`, signed in, joining the workspace (it restarts with the server's copy). */
async function joinOnDesktop(dir: string, email: string, server: string): Promise<Launched> {
  const size = (l: Launched) =>
    l.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1280, 800));
  let launched = await launchApp(join(root, dir));
  const window = launched.window;
  await indicator(window).click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(server);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-email').fill(email);
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-remote-Robotics lab').click();
  await dialog.getByTestId('sync-replace').check();
  const closed = launched.app.waitForEvent('close');
  await dialog.getByTestId('sync-start').click();
  await closed;
  launched = await launchApp(join(root, dir));
  await size(launched);
  await synced(launched.window);
  return launched;
}

/** Everything a desktop has stored (its database and write-ahead log), as text. */
function stored(dir: string): string {
  return ['workspace.db', 'workspace.db-wal']
    .map((f) => join(root, dir, f))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f).toString('latin1'))
    .join('\n');
}

/** Select the first occurrence of `text` in the page (the editor takes the DOM selection). */
async function selectText(window: Page, text: string) {
  await editor(window).focus();
  await editor(window).evaluate((el, text) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(text) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`No "${text}" in the page`);
  }, text);
  await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe(text);
}

type Shown = { title: string; body: string; kind?: string };
const systemNotifications = (who: Launched) =>
  who.app.evaluate(() => (globalThis as { __notifications?: Shown[] }).__notifications ?? []);

test('setup: Ada on the web, Bob (member) and Gus (guest) on desktops', async () => {
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
  adaToken = await signup('ada@lab.io', 'Ada');
  workspaceId = (
    await api<{ workspace: { id: string } }>('POST', '/api/workspaces', adaToken, {
      name: 'Robotics lab',
    })
  ).workspace.id;
  const scopes = await api<{ defaultScopeId: string }>(
    'GET',
    `/api/workspaces/${workspaceId}/scopes`,
    adaToken,
  );
  teamspaceId = scopes.defaultScopeId;
  await api('POST', `/api/workspaces/${workspaceId}/private`, adaToken);
  for (const [email, name, role] of [
    ['bob@lab.io', 'Bob', 'member'],
    ['gus@lab.io', 'Gus', 'guest'],
  ] as const) {
    const { invites } = await api<{ invites: { link: string }[] }>(
      'POST',
      `/api/workspaces/${workspaceId}/invites`,
      adaToken,
      { emails: [email], role },
    );
    await signup(email, name, invites[0]!.link.split('/invite/')[1]);
  }

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

  bob = await joinOnDesktop('bob', 'bob@lab.io', `http://127.0.0.1:${proxy.port}`);
  gus = await joinOnDesktop('gus', 'gus@lab.io', server!.base);
});

test('the owner’s private pages never reach the member’s or the guest’s desktop', async () => {
  await addPage(A, 'Private', 'Salaries', 'Confidential: the 2027 budget.');
  await addPage(A, 'Robotics lab', 'Gearbox', 'Planetary, three stages.');
  // Bob gets the teamspace page (so sync has run), and nothing else; Gus gets nothing.
  await expect(titleIn(bob.window, 'Robotics lab', 'Gearbox')).toHaveCount(1, { timeout: 15_000 });
  await openPage(bob.window, 'Gearbox');
  await expect(editor(bob.window)).toContainText('Planetary, three stages.', { timeout: 15_000 });
  await synced(gus.window);
  await expect(sidebarTitles(bob.window).filter({ hasText: 'Salaries' })).toHaveCount(0);
  await expect(sidebarTitles(gus.window)).toHaveCount(0);
  // Not a byte of it in their databases: not the page's id, not its title. (Typed text is
  // stored in pieces, so ids and titles, stored whole, are what to look for.) Bob's has the
  // teamspace page's.
  const idOf = async (title: string) => {
    await expect
      .poll(async () => {
        const r = await api<{ results: { id: string; title: string }[] }>(
          'GET',
          `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(title)}`,
          adaToken,
        );
        return r.results.find((h) => h.title === title)?.id ?? '';
      })
      .not.toBe('');
    const r = await api<{ results: { id: string; title: string }[] }>(
      'GET',
      `/api/workspaces/${workspaceId}/search?q=${encodeURIComponent(title)}`,
      adaToken,
    );
    return r.results.find((h) => h.title === title)!.id;
  };
  const salaries = await idOf('Salaries');
  const gearbox = await idOf('Gearbox');
  for (const dir of ['bob', 'gus']) {
    const db = stored(dir);
    expect(db.length).toBeGreaterThan(0);
    expect(db).not.toContain(salaries);
    expect(db).not.toContain('Salaries');
  }
  expect(stored('bob')).toContain(gearbox);
  expect(stored('bob')).toContain('Gearbox');
  expect(stored('gus')).not.toContain(gearbox);
});

test('a teamspace page co-edited live by the owner and the member, with cursors and avatars', async () => {
  const B = bob.window;
  await editor(A).click();
  await A.keyboard.press('Control+End');
  await editor(B).click();
  await B.keyboard.press('Control+End');
  await expect(A.getByRole('button', { name: 'Bob is here' })).toBeVisible({ timeout: 15_000 });
  await expect(B.getByRole('button', { name: 'Ada is here' })).toBeVisible({ timeout: 15_000 });

  await B.keyboard.type(' Ratio 64:1.');
  await expect(editor(A)).toContainText('Ratio 64:1.', { timeout: 10_000 });
  await expect(editor(A).locator('.ws-cursor', { hasText: 'Bob' })).toHaveCount(1, {
    timeout: 10_000,
  });
  await A.keyboard.press('Control+End');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Ada: helical gears next.');
  await expect(editor(B)).toContainText('Ada: helical gears next.', { timeout: 10_000 });
  await expect(editor(B).locator('.ws-cursor', { hasText: 'Ada' })).toHaveCount(1, {
    timeout: 10_000,
  });
  await shot(A, 'p5-exit-1-ada-web-coedit');
  await shot(B, 'p5-exit-2-bob-desktop-coedit');
});

test('a page shared with the guest to comment: he comments and suggests, the owner accepts', async () => {
  await addPage(A, 'Robotics lab', 'Spec sheet', 'Payload 5 kg.');
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Person or group').selectOption({ label: 'Gus (gus@lab.io) · guest' });
  await share.getByLabel('Role').selectOption('comment');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(share.getByTestId('access-row').filter({ hasText: 'Gus' })).toHaveCount(1, {
    timeout: 10_000,
  });
  await A.keyboard.press('Escape');

  const G = gus.window;
  await expect(titleIn(G, 'Shared', 'Spec sheet')).toHaveCount(1, { timeout: 15_000 });
  await openPage(G, 'Spec sheet');
  await expect(G.getByTestId('access-badge')).toHaveText(/Can comment/);
  await expect(G.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await expect(editor(G)).toContainText('Payload 5 kg.', { timeout: 15_000 });
  // A comment on "5 kg" (selected directly: arrow keys would also step over Ada's cursor).
  await selectText(G, '5 kg');
  await G.getByTestId('selection-toolbar')
    .getByRole('button', { name: /^Comment/ })
    .click();
  const input = G.getByTestId('comments-panel').getByTestId('comment-input');
  await input.fill('Is that with the gripper?');
  await input.press('Enter');
  // And a suggested edit.
  await editor(G).click();
  await G.keyboard.press('Control+End');
  await G.keyboard.type(' Reach 900 mm.');
  await expect(editor(G).getByTestId('suggestion-insert')).toHaveText(' Reach 900 mm.');

  await A.getByTestId('comments-button').click();
  const panel = A.getByTestId('comments-panel');
  await expect(panel.getByTestId('comment-thread')).toHaveCount(2, { timeout: 15_000 });
  await shot(A, 'p5-exit-3-ada-suggestion');
  await panel
    .getByTestId('comment-thread')
    .filter({ has: A.getByTestId('suggestion-summary') })
    .getByRole('button', { name: 'Accept' })
    .click();
  await expect(editor(A)).toContainText('Payload 5 kg. Reach 900 mm.');
  await expect(editor(G)).toContainText('Payload 5 kg. Reach 900 mm.', { timeout: 15_000 });
  await expect(editor(G).getByTestId('suggestion-insert')).toHaveCount(0);
});

test('a mention and a comment reply reach the right inboxes and desktop notifications', async () => {
  for (const who of [bob, gus]) {
    await who.app.evaluate(() => void ((globalThis as { __e2eAway?: boolean }).__e2eAway = true));
  }
  // Ada replies to Gus's thread on the spec sheet.
  const thread = A.getByTestId('comments-panel')
    .getByTestId('comment-thread')
    .filter({ hasText: 'Is that with the gripper?' });
  await thread.getByTestId('comment-input').fill('Yes, gripper included.');
  await thread.getByTestId('comment-input').press('Enter');
  // And mentions Bob on the gearbox page.
  await openPage(A, 'Gearbox');
  await editor(A).click();
  await A.keyboard.press('Control+End');
  await A.keyboard.press('Enter');
  await A.keyboard.type('Review: @Bo');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Bob/);
  await A.keyboard.press('Enter');

  // Gus: the page shared with him, and the reply.
  await expect(gus.window.getByTestId('inbox-unread')).toHaveText('2', { timeout: 20_000 });
  await expect(bob.window.getByTestId('inbox-unread')).toHaveText('1', { timeout: 20_000 });
  await expect
    .poll(() => systemNotifications(gus), { timeout: 10_000 })
    .toContainEqual(
      expect.objectContaining({
        title: 'Ada replied in Spec sheet',
        body: 'Yes, gripper included.',
      }),
    );
  await expect
    .poll(() => systemNotifications(bob), { timeout: 10_000 })
    .toContainEqual(expect.objectContaining({ title: 'Ada mentioned you in Gearbox' }));
  await gus.window.getByTestId('inbox-button').click();
  await expect(gus.window.getByTestId('inbox').getByTestId('inbox-headline').first()).toContainText(
    'Ada replied in Spec sheet',
  );
  await gus.window.keyboard.press('Escape');
});

test('an offline edit after losing edit access is refused, kept in history; the page matches', async () => {
  const B = bob.window;
  await openPage(B, 'Gearbox');
  await synced(B);
  proxy.cut();
  await expect(indicator(B)).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
  await editor(B).click();
  await B.keyboard.press('Control+End');
  await B.keyboard.press('Enter');
  await B.keyboard.type('Offline: bigger bearings.');
  await expect(indicator(B)).toContainText(/Offline · \d+ changes? to sync/);
  await B.waitForTimeout(1500);

  // Meanwhile Ada makes the teamspace view-only for everyone.
  await api('PUT', `/api/workspaces/${workspaceId}/scopes/${teamspaceId}/access`, adaToken, {
    principal: 'workspace',
    role: 'view',
  });

  proxy.restore();
  await bob.app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  const R = bob.window;
  await expect(editor(R)).not.toContainText('Offline: bigger bearings.', { timeout: 20_000 });
  await synced(R);
  await openPage(R, 'Gearbox');
  await expect(editor(R)).toContainText('Ada: helical gears next.');
  await expect(editor(R)).not.toContainText('Offline: bigger bearings.');
  await expect(editor(A)).not.toContainText('Offline: bigger bearings.');
  await R.getByRole('button', { name: 'Page options' }).click();
  await R.getByTestId('page-menu').getByRole('menuitem', { name: 'Page history' }).click();
  const history = R.getByTestId('history-dialog');
  const notSaved = history
    .getByTestId('history-version')
    .filter({ hasText: 'Not saved: your access changed' });
  await expect(notSaved).toHaveCount(1);
  await notSaved.click();
  await expect(history.getByTestId('history-preview')).toContainText('Offline: bigger bearings.');
  await shot(R, 'p5-exit-4-bob-not-saved');
  await R.keyboard.press('Escape');
});

test('taking the guest’s access away removes the page from his desktop', async () => {
  await openPage(A, 'Spec sheet');
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByRole('button', { name: 'Remove Gus' }).click();
  await expect(share.getByTestId('access-row').filter({ hasText: 'Gus' })).toHaveCount(0, {
    timeout: 10_000,
  });
  await A.keyboard.press('Escape');
  await expect(sidebarTitles(gus.window)).toHaveCount(0, { timeout: 15_000 });
});

test('a published page reads signed out; its unpublished sub-page and other files don’t', async () => {
  // A sub-page under Gearbox, kept off the web.
  const gearbox = sidebarTitles(A)
    .filter({ hasText: /^Gearbox$/ })
    .locator('xpath=..');
  await gearbox.hover();
  await gearbox.getByRole('button', { name: 'Add a page inside' }).click();
  await A.getByLabel('Page title').fill('Supplier prices');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Bearings: 4 EUR each.');
  await openPage(A, 'Gearbox');
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const publish = A.getByTestId('share-dialog').getByTestId('publish-section');
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await publish.getByLabel('Include sub-pages').uncheck();
  await publish.getByRole('button', { name: 'Save' }).click();
  await expect(publish.getByLabel('Include sub-pages')).not.toBeChecked();
  const url = (await publish.getByTestId('publish-url').getAttribute('href'))!;
  await A.keyboard.press('Escape');

  const visitor = await browser!.newPage();
  const page = await visitor.goto(url);
  expect(page?.status()).toBe(200);
  await expect(visitor.locator('h1')).toHaveText('Gearbox');
  await expect(visitor.locator('article')).toContainText('Ada: helical gears next.');
  await expect(visitor.locator('article')).not.toContainText('Supplier prices');
  await shot(visitor, 'p5-exit-5-published');
  const base = visitor.url().slice(0, visitor.url().lastIndexOf('/') + 1);
  for (const path of ['Supplier prices.html', `${'0'.repeat(64)}.png`, 'Salaries.html']) {
    const res = await visitor.request.get(base + encodeURIComponent(path));
    expect(res.status(), path).toBe(404);
  }
  await visitor.close();
});
