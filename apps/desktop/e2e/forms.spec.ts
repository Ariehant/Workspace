/**
 * Phase 6 M2: forms. Ada (a desktop, on a server) adds a form to her database "Parts":
 *
 * - She builds it (a title, a required question, a new number question) and answers it
 *   herself in the app: the response is a row.
 * - She shares it with anyone who has the link. Someone signed out fills it in, in a
 *   browser: the row appears on Ada's desktop, live, and her inbox says so.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { newDatabase, titles } from './db';
import { expect, launchApp, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let browser: Browser | null = null;
let link = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-forms-'));
  server = await startSyncServer(root);
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
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const db = (window: Page) => window.getByTestId('database-view').first();
const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

test('Ada builds a form and answers it in the app', async () => {
  ada = await launchApp(join(root, 'ada'));
  await ada.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 860),
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
  await newDatabase(A, 'Parts');

  // A form view: every property it can ask, the title first.
  await db(A).getByRole('button', { name: 'Add a view' }).click();
  await A.getByTestId('add-view-menu').getByRole('menuitem', { name: 'Form' }).click();
  const builder = A.getByTestId('form-builder');
  await expect(builder.getByTestId('form-question')).toHaveCount(2);
  await builder.getByLabel('Form title').fill('Order a part');
  await builder.getByLabel('Question for Name').fill('Part');
  await builder.getByLabel('Name is required').check();
  await A.getByTestId('form-add-question').click();
  await A.getByRole('menuitem', { name: 'New number question' }).click();
  await expect(builder.getByTestId('form-question')).toHaveCount(3);
  await builder.getByLabel('Question for Number').fill('How many?');
  await builder.getByText('Notify me of each response').click();
  await shot(A, 'forms-1-builder');

  // Answered in the app.
  await A.getByTestId('form-mode-fill').click();
  const fill = A.getByTestId('form-fill');
  await expect(fill.getByRole('heading', { name: 'Order a part' })).toBeVisible();
  await fill.getByTestId('form-submit').click();
  await expect(fill.getByText('Required')).toBeVisible();
  await fill.getByLabel('Part').fill('Bearing 608');
  await fill.getByLabel('How many?').fill('4');
  await fill.getByTestId('form-submit').click();
  await expect(A.getByTestId('form-submitted')).toContainText('Your response was recorded');

  await db(A).getByRole('tab', { name: 'Table' }).click();
  await expect(titles(A)).toHaveText(['Bearing 608']);
});

test('shared with anyone who has the link, it’s answered signed out', async () => {
  const A = ada.window;
  await db(A).getByRole('tab', { name: 'Form' }).click();
  await A.getByTestId('form-share').click();
  const panel = A.getByTestId('form-share-panel');
  await panel.getByLabel('Who can fill it in').selectOption('public');
  await panel.getByRole('button', { name: 'Create link' }).click();
  await expect(panel.getByTestId('form-link')).toContainText('/f/');
  link = (await panel.getByTestId('form-link').getAttribute('href'))!;
  await shot(A, 'forms-2-share');
  await A.keyboard.press('Escape');
  await synced(A);

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const visitor = await browser.newPage({ viewport: { width: 900, height: 760 } });
  await visitor.goto(link);
  await expect(visitor.locator('h1')).toHaveText('Order a part');
  await visitor.getByLabel('Part').fill('Gear, 12 teeth');
  await visitor.getByLabel('How many?').fill('2');
  await shot(visitor, 'forms-3-public');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByRole('status')).toContainText('Your response was recorded');

  // Live on Ada's desktop, and in her inbox.
  await db(A).getByRole('tab', { name: 'Table' }).click();
  await expect(titles(A)).toHaveText(['Bearing 608', 'Gear, 12 teeth'], { timeout: 15_000 });
  await A.getByTestId('inbox-button').click();
  await expect(A.getByTestId('inbox').getByTestId('inbox-item').first()).toContainText(
    'responded to Order a part',
    { timeout: 15_000 },
  );
  await shot(A, 'forms-4-inbox');
});
