/**
 * Phase 5 M5: comments and suggested edits. Ada (a desktop) owns a teamspace where
 * everyone may comment; Bob (the web app) may only comment there. Ada comments on some
 * text and mentions Bob; Bob replies and reacts, then suggests an edit (he can't change
 * the page itself); Ada accepts it and resolves the thread. Page comments sit under the
 * title.
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
let browser: Browser | null = null;
let bob: Page;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!existsSync(join(webDir, 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @workspace/web build');
  }
  root = mkdtempSync(join(tmpdir(), 'workspace-comments-'));
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

const panel = (window: Page) => window.getByTestId('comments-panel');
const threads = (window: Page) => panel(window).getByTestId('comment-thread');
const insertion = (window: Page) => editor(window).getByTestId('suggestion-insert');
/** The page's text: without suggested text (not in the page yet) or others' cursors. */
const pageText = (window: Page) =>
  editor(window).evaluate((el) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy
      .querySelectorAll('[data-testid="suggestion-insert"], .ws-cursor')
      .forEach((n) => n.remove());
    return copy.textContent;
  });

test('setup: Ada’s desktop, and Bob on the web who may only comment', async () => {
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
  const { workspaces } = await api<{ workspaces: { id: string }[] }>(
    'GET',
    '/api/workspaces',
    token,
  );
  const ws = workspaces[0]!.id;
  await api('POST', `/api/workspaces/${ws}/teamspaces`, token, {
    name: 'Design review',
    everyone: 'comment',
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

  await expect(A.getByRole('tree', { name: 'Design review', exact: true })).toHaveCount(1, {
    timeout: 15_000,
  });
  await A.getByRole('button', { name: 'Add a page to Design review' }).click();
  await A.getByLabel('Page title').fill('Gearbox');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Planetary, three stages.');
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
  await expect(inSection(bob, 'Design review', 'Gearbox')).toHaveCount(1, { timeout: 15_000 });
});

test('Ada comments on some text and mentions Bob', async () => {
  const A = ada.window;
  // Select "three stages".
  await editor(A).click();
  await A.keyboard.press('Control+End');
  await A.keyboard.press('ArrowLeft');
  for (let i = 0; i < 'three stages'.length; i++) await A.keyboard.press('Shift+ArrowLeft');
  await A.getByTestId('selection-toolbar')
    .getByRole('button', { name: /^Comment/ })
    .click();

  const input = panel(A).getByTestId('comment-input');
  await expect(input).toBeFocused();
  await input.pressSequentially('Torque check, @Bo');
  await A.getByRole('option', { name: 'Bob' }).click();
  await input.pressSequentially('please?');
  await input.press('Enter');

  await expect(threads(A)).toHaveCount(1);
  await expect(threads(A).getByTestId('comment-quote')).toHaveText('three stages');
  await expect(threads(A).getByTestId('comment-mention')).toHaveText('@Bob');
  await expect(editor(A).locator('.ws-comment')).toHaveText('three stages');
  await expect(A.getByTestId('comments-count')).toHaveText('1');
  await shot(A, 'comments-1-ada-comments');
});

test('Bob sees it, replies and reacts; he may comment but not edit', async () => {
  await openPage(bob, 'Gearbox');
  await expect(bob.getByTestId('access-badge')).toHaveText(/Can comment/);
  await expect(bob.getByLabel('Page title')).toHaveAttribute('readonly', '');
  const highlight = editor(bob).locator('.ws-comment');
  await expect(highlight).toHaveText('three stages', { timeout: 15_000 });
  await highlight.click();
  await expect(threads(bob)).toHaveCount(1);
  await expect(threads(bob).getByTestId('comment-body').first()).toHaveText(
    'Torque check, @Bob please?',
  );
  await threads(bob).getByTestId('comment-input').fill('Yes, at 64:1.');
  await threads(bob).getByTestId('comment-input').press('Enter');
  await threads(bob).getByTestId('comment').first().hover();
  await threads(bob).getByRole('button', { name: 'Add reaction' }).first().click();
  await threads(bob).getByRole('button', { name: 'React 👍' }).click();

  const A = ada.window;
  await expect(threads(A).getByTestId('comment')).toHaveCount(2, { timeout: 15_000 });
  await expect(threads(A).getByTestId('comment-body').nth(1)).toHaveText('Yes, at 64:1.');
  await expect(threads(A).getByTestId('reaction')).toHaveText('👍 1');
});

test('Bob suggests an edit; Ada accepts it into the page', async () => {
  const B = bob;
  // Typing at the end makes a suggestion, not a change.
  await editor(B).click();
  await B.keyboard.press('Control+End');
  await B.keyboard.type(' Helical');
  await expect(insertion(B)).toHaveText(' Helical');
  // Backspace takes back suggested text first.
  await B.keyboard.press('Backspace');
  await B.keyboard.type('l gears.');
  await expect(insertion(B)).toHaveText(' Helical gears.');
  await expect(B.getByTestId('comments-count')).toHaveText('2');

  const A = ada.window;
  await expect(insertion(A)).toHaveText(' Helical gears.', { timeout: 15_000 });
  // The page itself is unchanged until it's accepted.
  expect(await pageText(A)).toBe('Planetary, three stages.');
  const suggestion = threads(A).filter({ has: A.getByTestId('suggestion-summary') });
  await expect(suggestion.getByTestId('suggestion-summary')).toHaveText(/Add\s+Helical gears\./);
  await shot(A, 'comments-2-suggestion');
  await suggestion.getByRole('button', { name: 'Accept' }).click();

  await expect(insertion(A)).toHaveCount(0);
  expect(await pageText(A)).toBe('Planetary, three stages. Helical gears.');
  await expect
    .poll(() => pageText(B), { timeout: 15_000 })
    .toBe('Planetary, three stages. Helical gears.');
  await expect(insertion(B)).toHaveCount(0);
});

test('Ada resolves the thread; page comments sit under the title', async () => {
  const A = ada.window;
  await threads(A).getByRole('button', { name: 'Resolve' }).click();
  await expect(editor(A).locator('.ws-comment')).toHaveCount(0);
  await expect(threads(A)).toHaveCount(0);
  await panel(A).getByRole('button', { name: 'resolved', exact: true }).click();
  await expect(threads(A)).toHaveCount(2);
  await expect(editor(bob).locator('.ws-comment')).toHaveCount(0, { timeout: 15_000 });

  // A comment on text that is then deleted stays, "on deleted text".
  await panel(A).getByRole('button', { name: 'open', exact: true }).click();
  // (Selected directly: arrow keys would also step over Bob's cursor at the end.)
  await selectText(A, 'gears');
  await A.keyboard.press('Control+Shift+M');
  await panel(A).getByTestId('comment-input').first().fill('Spur or helical?');
  await panel(A).getByTestId('comment-input').first().press('Enter');
  await expect(editor(A).locator('.ws-comment')).toHaveText('gears');
  await selectText(A, 'gears');
  await A.keyboard.press('Backspace');
  await expect(threads(A).getByTestId('comment-quote')).toHaveText('On deleted text: gears');
  await expect(editor(A).locator('.ws-comment')).toHaveCount(0);

  // A comment on the whole page.
  await bob.getByLabel('Page title').hover();
  await bob.getByRole('button', { name: 'Add comment' }).click();
  const pageInput = bob.getByTestId('page-comments').getByTestId('comment-input');
  await expect(pageInput).toBeFocused();
  await pageInput.fill('Ready for the design review.');
  await pageInput.press('Enter');
  await expect(
    A.getByTestId('page-comments').getByTestId('comment-body').filter({ hasText: 'design review' }),
  ).toHaveCount(1, { timeout: 15_000 });
  await shot(A, 'comments-3-page-comments');
});
