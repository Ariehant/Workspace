/**
 * Phase 5 M7: publishing to the web. Ada publishes a page (with a sub-page, and a mention
 * of a page she keeps private) from her desktop; someone signed out reads it in a browser,
 * sees nothing of the private page, and their visit counts as a view. Unpublishing takes
 * it down at once. On the web app, Ada sees the backlink from the server.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let browser: Browser | null = null;
let visitor: Page;
let url = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-publish-'));
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

const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

test('Ada publishes a page with a sub-page from her desktop', async () => {
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

  await newPage(A, 'Secret plans');
  await A.keyboard.type('Not for the web.');
  await newPage(A, 'Gearbox');
  await A.keyboard.type('Planetary drive, see @Secret');
  await expect(A.getByTestId('mention-menu').getByRole('option').first()).toHaveText(/Secret/);
  await A.keyboard.press('Enter');
  await A.keyboard.type('for costs.');
  // A sub-page.
  const gearbox = sidebarTitles(A)
    .filter({ hasText: /^Gearbox$/ })
    .locator('xpath=..');
  await gearbox.hover();
  await gearbox.getByRole('button', { name: 'Add a page inside' }).click();
  await A.getByLabel('Page title').fill('Specs');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A)).toBeFocused();
  await A.keyboard.type('Ratio 64:1.');
  await synced(A);

  await sidebarTitles(A)
    .filter({ hasText: /^Gearbox$/ })
    .click();
  await expect(A.getByLabel('Page title')).toHaveValue('Gearbox');
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  const publish = share.getByTestId('publish-section');
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publish.getByTestId('publish-url')).toContainText('/p/gearbox');
  url = (await publish.getByTestId('publish-url').getAttribute('href'))!;
  await shot(A, 'publish-1-share-dialog');
  await A.keyboard.press('Escape');
});

test('signed out, the page reads on the web; nothing of the private page shows', async () => {
  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  visitor = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const response = await visitor.goto(url);
  expect(response?.status()).toBe(200);
  await expect(visitor.locator('h1')).toHaveText('Gearbox');
  await expect(visitor.locator('article')).toContainText('Planetary drive, see');
  await expect(visitor.locator('article')).toContainText('Private page');
  await expect(visitor.locator('article')).not.toContainText('Secret');
  await shot(visitor, 'publish-2-signed-out');
  await visitor.getByRole('link', { name: 'Specs' }).click();
  await expect(visitor.locator('h1')).toHaveText('Specs');
  await expect(visitor.locator('article')).toContainText('Ratio 64:1.');

  // The visits count as views, in the page's menu.
  const A = ada.window;
  await A.getByRole('button', { name: 'Page options' }).click();
  await expect(A.getByTestId('page-views')).toContainText(/\d+ views? · 2 people/);
  await A.keyboard.press('Escape');
});

test('unpublishing takes it down at once', async () => {
  const A = ada.window;
  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const publish = A.getByTestId('share-dialog').getByTestId('publish-section');
  await publish.getByRole('button', { name: 'Unpublish' }).click();
  await expect(publish.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
  const response = await visitor.goto(url);
  expect(response?.status()).toBe(404);
  await expect(visitor.locator('body')).toContainText('isn’t published');
});

test('on the web app, backlinks come from the server', async () => {
  const web = await browser!.newPage({ viewport: { width: 1280, height: 800 } });
  await web.goto(server!.base);
  await web.getByLabel('Email').fill('ada@lab.io');
  await web.getByLabel('Password').fill(PASSWORD);
  await web.getByRole('button', { name: 'Sign in' }).click();
  await web
    .getByTestId('workspace-picker')
    .getByRole('button', { name: /Robotics lab/ })
    .click();
  await sidebarTitles(web)
    .filter({ hasText: /^Secret plans$/ })
    .click();
  await expect(web.getByLabel('Page title')).toHaveValue('Secret plans');
  const backlinks = web.getByTestId('backlinks');
  await expect(backlinks.getByRole('button', { name: '1 backlink' })).toBeVisible({
    timeout: 15_000,
  });
  await backlinks.getByRole('button', { name: '1 backlink' }).click();
  await expect(web.getByTestId('backlink')).toContainText('Gearbox');
  await shot(web, 'publish-3-web-backlinks');
});
