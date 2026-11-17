import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { startServer, type TestServer } from './server';

test.describe.configure({ mode: 'serial' });

/** Set WORKSPACE_SHOTS=<dir> to save screenshots. */
const shotsDir = process.env.WORKSPACE_SHOTS;
let server: TestServer;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startServer();
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});
test.afterAll(async () => {
  await server?.stop();
});

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const editor = (page: Page) => page.getByTestId('page-editor');
const sidebarTitles = (page: Page) => page.getByTestId('sidebar-page-title');
const table = (page: Page) => page.getByTestId('table-view');

test('sign up, create a workspace, write a page and a database, reload', async ({ page }) => {
  page.on('pageerror', (error) => console.error(`[page] ${error.stack ?? error}`));
  await page.goto(server.base);
  // A new server: the first account becomes its admin.
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Name').fill('Ada');
  await page.getByLabel('Email').fill('ada@lab.io');
  await page.getByLabel('Password').fill('correct horse battery');
  await shot(page, 'web-1-sign-up');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByTestId('workspace-picker')).toBeVisible();
  await page.getByPlaceholder('New workspace name').fill('Robotics lab');
  await shot(page, 'web-2-workspaces');
  await page.getByRole('button', { name: 'Create' }).click();

  // The app, on the server's workspace: a fresh one gets the welcome page.
  await expect(page).toHaveURL(/\/w\/[0-9a-f-]{36}/);
  await expect(sidebarTitles(page)).toHaveText(['Getting started']);
  await expect(page.getByTestId('workspace-name')).toHaveText('Robotics lab');
  // Desktop-only features are hidden, not broken.
  await expect(page.getByRole('button', { name: 'Import' })).toHaveCount(0);
  await expect(page.getByTestId('sync-indicator')).toHaveCount(0);

  await page.getByRole('button', { name: 'New page' }).click();
  await page.getByLabel('Page title').fill('Gripper');
  await page.getByLabel('Page title').press('Enter');
  await expect(editor(page)).toBeFocused();
  await page.keyboard.type('Two-finger parallel gripper, 2 Nm.');
  // An image (drawn here), uploaded to the server.
  await editor(page).evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 300;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#f1f5f9';
    g.fillRect(0, 0, 600, 300);
    g.fillStyle = '#334155';
    g.fillRect(270, 30, 60, 120); // wrist
    g.fillStyle = '#2383e2';
    g.fillRect(200, 150, 50, 120); // fingers
    g.fillRect(350, 150, 50, 120);
    g.fillStyle = '#334155';
    g.fillRect(200, 140, 200, 20); // palm
    g.font = '20px sans-serif';
    g.fillText('Parallel gripper, 40 mm stroke', 160, 295);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png'),
    );
    const data = new DataTransfer();
    data.items.add(new File([blob], 'gripper.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const image = editor(page).locator('.ws-image img');
  await expect(image).toHaveAttribute('src', /^\/api\/workspaces\/.+\/files\/[0-9a-f]{64}\.png$/);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(600);

  // A database with a row.
  await page.getByRole('button', { name: 'New page' }).click();
  await page.getByLabel('Page title').fill('Parts');
  await page.getByTestId('get-started').getByRole('button', { name: 'Database' }).click();
  await expect(table(page)).toBeVisible();
  await table(page).getByTestId('table-new-row').last().click();
  await page.keyboard.type('Servo motor');
  await page.keyboard.press('Enter');
  await expect(table(page).getByTestId('row-title').getByText('Servo motor')).toBeVisible();
  await shot(page, 'web-3-database');

  // Reload: everything comes back from the server.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(sidebarTitles(page)).toHaveText(['Getting started', 'Gripper', 'Parts']);
  await expect(table(page).getByTestId('row-title').getByText('Servo motor')).toBeVisible();
  await sidebarTitles(page).filter({ hasText: 'Gripper' }).click();
  await expect(editor(page)).toContainText('Two-finger parallel gripper, 2 Nm.');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(600);
  await shot(page, 'web-4-page');

  // Quick find searches on the server: by content and by database row.
  await page.keyboard.press('Control+k');
  const find = page.getByTestId('quick-find');
  await find.getByLabel('Search pages').fill('parallel');
  await expect(find.getByTestId('quick-find-result').first()).toContainText('Gripper');
  await shot(page, 'web-5-quick-find');
  await find.getByLabel('Search pages').fill('servo');
  await expect(find.getByTestId('quick-find-result').first()).toContainText('Servo motor');
  await page.keyboard.press('Escape');
});

test('export a page as Markdown with its image, and print it to PDF', async ({ page }) => {
  page.on('pageerror', (error) => console.error(`[page] ${error.stack ?? error}`));
  await page.goto(server.base);
  await page.getByLabel('Email').fill('ada@lab.io');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page
    .getByTestId('workspace-picker')
    .getByRole('button', { name: /Robotics lab/ })
    .click();
  await sidebarTitles(page).filter({ hasText: 'Gripper' }).click();
  await expect(editor(page)).toContainText('Two-finger parallel gripper');

  // Markdown: made by the server, downloaded by the browser.
  const openExport = async () => {
    await page.getByRole('button', { name: 'Page options' }).click();
    await page.getByTestId('page-menu').getByRole('menuitem', { name: 'Export…' }).click();
    return page.getByTestId('export-dialog');
  };
  let dialog = await openExport();
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Gripper (Markdown).zip');
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  const paths = Object.keys(files);
  const markdown = paths.find((p) => p.endsWith('.md'))!;
  expect(new TextDecoder().decode(files[markdown])).toContain('Two-finger parallel gripper, 2 Nm.');
  // The image the page shows, under its name.
  expect(paths.some((p) => p.endsWith('/gripper.png'))).toBe(true);
  await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done');

  // PDF: the page in a tab of its own, printed by the browser (its dialog saves PDFs).
  await page.context().addInitScript(() => {
    window.print = () => {
      (window as unknown as { printed: boolean }).printed = true;
    };
  });
  dialog = await openExport();
  await dialog.getByRole('radio', { name: /^PDF/ }).check();
  const opening = page.waitForEvent('popup');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const tab = await opening;
  await expect(editor(tab)).toContainText('Two-finger parallel gripper');
  await expect
    .poll(() => tab.evaluate(() => (window as unknown as { printed?: boolean }).printed))
    .toBe(true);
  await tab.close();
});

test('a second tab sees edits live, and signing out returns to sign-in', async ({
  browser,
  page,
}) => {
  const context = page.context();
  await page.goto(server.base);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email').fill('ada@lab.io');
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page
    .getByTestId('workspace-picker')
    .getByRole('button', { name: /Robotics lab/ })
    .click();
  await expect(sidebarTitles(page).first()).toBeVisible();
  const other = await context.newPage();
  await other.goto(page.url());
  await expect(sidebarTitles(other).first()).toBeVisible();

  await sidebarTitles(page).filter({ hasText: 'Gripper' }).click();
  await sidebarTitles(other).filter({ hasText: 'Gripper' }).click();
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed in the first tab.');
  await expect(editor(other)).toContainText('Typed in the first tab.');
  await other.getByLabel('Page title').fill('Gripper v2');
  await expect(sidebarTitles(page).filter({ hasText: 'Gripper v2' })).toHaveCount(1);

  // Settings follow the account: the theme chosen here is there after a reload.
  await page.getByRole('button', { name: 'Appearance' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(300);
  await other.reload();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(other, 'web-6-dark');

  await page.getByRole('button', { name: 'Workspace menu' }).click();
  // Exports work here; backups are the desktop's.
  await expect(page.getByRole('menuitem', { name: /Export all/ })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Back up/ })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByTestId('sign-in')).toBeVisible();
  // Signed out everywhere in this browser (the cookie is gone).
  await other.reload();
  await expect(other.getByTestId('sign-in')).toBeVisible();
  void browser;
});

test('offline: keeps editing, reopens without the server, and sends the edits when it’s back', async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const signIn = async (p: Page) => {
    await p.goto(server.base);
    await p.getByLabel('Email').fill('ada@lab.io');
    await p.getByLabel('Password').fill('correct horse battery');
    await p.getByRole('button', { name: 'Sign in' }).click();
    await p
      .getByTestId('workspace-picker')
      .getByRole('button', { name: /Robotics lab/ })
      .click();
    await expect(sidebarTitles(p).first()).toBeVisible();
  };
  await signIn(page);
  // The app's files are kept for offline use once its worker is in charge.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.getByRole('button', { name: 'New page' }).click();
  await page.getByLabel('Page title').fill('Field notes');
  await page.getByLabel('Page title').press('Enter');
  await page.keyboard.type('Before the outage.');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await page.waitForTimeout(1000);

  // The server goes away: editing goes on, and the edits are kept in this browser.
  await server.pause();
  await expect(page.getByTestId('offline-banner')).toBeVisible({ timeout: 15_000 });
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Written offline.');
  await expect(page.getByTestId('offline-banner')).toContainText('kept here');
  await page.waitForTimeout(1000);

  // Reopened with no server at all: the app, the page and the edit are all here.
  await page.reload();
  await expect(sidebarTitles(page).filter({ hasText: 'Field notes' })).toBeVisible();
  await sidebarTitles(page).filter({ hasText: 'Field notes' }).click();
  await expect(editor(page)).toContainText('Before the outage.');
  await expect(editor(page)).toContainText('Written offline.');

  // The server is back: the kept edits go to it, and a fresh browser sees them.
  await server.resume();
  await page.getByTestId('offline-banner').getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('offline-banner')).toHaveCount(0, { timeout: 20_000 });
  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await signIn(other);
  await sidebarTitles(other).filter({ hasText: 'Field notes' }).click();
  await expect(editor(other)).toContainText('Written offline.');
  await fresh.close();
});
