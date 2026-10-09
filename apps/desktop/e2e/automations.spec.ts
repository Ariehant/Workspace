/**
 * Phase 6 M3: automations. Ada (a desktop, on a server) adds one to her database "Tasks":
 * when a page is added, set "Logged" to today, notify her, and send a webhook. She adds a
 * page; the server runs it: the date appears on her desktop, live, her inbox says so,
 * and a local receiver gets the page, signed.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase } from './db';
import { expect, launchApp, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
const received: { body: string; headers: IncomingMessage['headers'] }[] = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    received.push({ body, headers: req.headers });
    res.end('ok');
  });
});
let hookUrl = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-automations-'));
  server = await startSyncServer(root);
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await server?.stop();
  await new Promise((r) => receiver.close(r));
  if (root) rmSync(root, { recursive: true, force: true });
});

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

test('Ada adds an automation: when a page is added, log it, tell her, call a webhook', async () => {
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
  await newDatabase(A, 'Tasks');
  await addProperty(A, 'Date', 'Logged');

  await A.getByTestId('automations-button').click();
  const automations = A.getByTestId('automations-dialog');
  await automations.getByRole('button', { name: 'New automation' }).click();
  const editor = automations.getByTestId('automation-editor');
  await editor.getByLabel('Automation name').fill('Log new tasks');
  await expect(editor.getByLabel('Trigger')).toHaveValue('pageAdded');
  await editor.getByLabel('Add an action').selectOption('setProperties');
  await editor.getByLabel('Set a property').selectOption({ label: 'Logged' });
  await expect(editor.getByLabel('Logged value')).toHaveValue('now');
  await editor.getByLabel('Add an action').selectOption('notify');
  await editor.getByTestId('automation-action').nth(1).getByLabel('Ada').check();
  await editor.getByLabel('Message').fill('A task was added');
  await editor.getByLabel('Add an action').selectOption('webhook');
  await editor.getByLabel('Webhook URL').fill(hookUrl);
  await shot(A, 'automations-1-editor');
  await editor.getByTestId('automation-save').click();
  await expect(automations.getByTestId('automation-row')).toContainText('When a page is added');
  await shot(A, 'automations-2-list');
  await A.keyboard.press('Escape');
  await synced(A);
});

test('a page added: the server logs it, live; Ada is told; the webhook arrives', async () => {
  const A = ada.window;
  await addRow(A, 'Grease the gears');
  const today = new Date();
  const logged = await cell(A, 'Grease the gears', 'Logged');
  await expect(logged).not.toBeEmpty({ timeout: 20_000 });
  await expect(logged).toContainText(String(today.getDate()));

  await A.getByTestId('inbox-button').click();
  await expect(A.getByTestId('inbox').getByTestId('inbox-item').first()).toContainText(
    'Log new tasks',
    { timeout: 15_000 },
  );
  await shot(A, 'automations-3-done');
  await A.keyboard.press('Escape');

  await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);
  const sent = JSON.parse(received[0]!.body);
  expect(sent).toMatchObject({ data: { title: 'Grease the gears' } });
  expect(received[0]!.headers['x-notion-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
});
