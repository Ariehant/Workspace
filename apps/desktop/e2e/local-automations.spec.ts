/**
 * Phase 6 M4: automations on a desktop whose workspace isn't synced. The main process
 * runs them: a page added fills in a date, notifies, and sends a signed webhook; a
 * scheduled one runs at its time, and once at the next start when it was missed while
 * the app was closed. A button's webhook and notification steps go from here too.
 */
import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication, Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, titles } from './db';
import { expect, launchApp, settle, test, type Launched } from './helpers';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const DAY = 24 * 3600_000;
/** Look at changes soon after they're made (not the usual 3 s). */
const ENV = { WORKSPACE_AUTOMATION_DELAY_MS: '200' };

let root: string;
let me: Launched;
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
  root = mkdtempSync(join(tmpdir(), 'workspace-local-automations-'));
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await me?.app.close().catch(() => {});
  await new Promise((r) => receiver.close(r));
  if (root) rmSync(root, { recursive: true, force: true });
});

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const notifications = (app: ElectronApplication) =>
  app.evaluate(
    () =>
      ((globalThis as { __notifications?: { title: string; body: string }[] }).__notifications ??
        []) as { title: string; body: string }[],
  );

const sign = (secret: string, body: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

test('a page added: the desktop logs it, tells me, and sends a signed webhook', async () => {
  me = await launchApp(join(root, 'me'), ENV);
  await me.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 860),
  );
  const W = me.window;
  await newDatabase(W, 'Chores');
  await addProperty(W, 'Date', 'Logged');

  // Offered without a server: this device runs them.
  await W.getByTestId('automations-button').click();
  const automations = W.getByTestId('automations-dialog');
  await automations.getByRole('button', { name: 'New automation' }).click();
  const editor = automations.getByTestId('automation-editor');
  await editor.getByLabel('Automation name').fill('Log chores');
  await editor.getByLabel('Add an action').selectOption('setProperties');
  await editor.getByLabel('Set a property').selectOption({ label: 'Logged' });
  await editor.getByLabel('Add an action').selectOption('notify');
  await editor.getByTestId('automation-action').nth(1).getByRole('checkbox').first().check();
  await editor.getByLabel('Message').fill('A chore was added');
  await editor.getByLabel('Add an action').selectOption('webhook');
  await editor.getByLabel('Webhook URL').fill(hookUrl);
  await editor.getByRole('button', { name: 'Show signing secret' }).click();
  const secret = (await editor.getByTestId('webhook-secret').textContent())!;
  expect(secret).toMatch(/^whsec_/);
  await shot(W, 'local-automations-1-editor');
  await editor.getByTestId('automation-save').click();
  await expect(automations.getByTestId('automation-row')).toContainText('When a page is added');
  await W.keyboard.press('Escape');

  await addRow(W, 'Oil the hinges');
  const logged = await cell(W, 'Oil the hinges', 'Logged');
  await expect(logged).toContainText(String(new Date().getDate()), { timeout: 10_000 });
  await expect
    .poll(async () => (await notifications(me.app)).map((n) => `${n.title}: ${n.body}`))
    .toContain('Automation: Log chores: A chore was added');
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(1);
  const { body, headers } = received[0]!;
  expect(JSON.parse(body)).toMatchObject({
    source: { type: 'automation' },
    data: { title: 'Oil the hinges' },
  });
  expect(headers['x-notion-signature']).toBe(sign(secret, body));

  // Its run is in the log.
  await W.getByTestId('automations-button').click();
  await automations.getByRole('button', { name: /^Log chores/ }).click();
  await expect(editor.getByTestId('automation-runs')).toContainText('Done');
  await shot(W, 'local-automations-2-runs');
  await W.keyboard.press('Escape');
});

test('a schedule runs at its time, and once at the next start when it was missed', async () => {
  const W = me.window;
  await W.getByTestId('automations-button').click();
  const automations = W.getByTestId('automations-dialog');
  await automations.getByRole('button', { name: 'New automation' }).click();
  const editor = automations.getByTestId('automation-editor');
  await editor.getByLabel('Automation name').fill('Daily review');
  await editor.getByLabel('Trigger').selectOption('schedule');
  await editor.getByLabel('Every').selectOption('day');
  await editor.getByLabel('Time').fill('09:00');
  await editor.getByLabel('Add an action').selectOption('addPage');
  await editor.getByLabel('Page title').fill('Review the day');
  await editor.getByTestId('automation-save').click();
  await expect(automations.getByTestId('automation-row').nth(1)).toContainText(
    'Every day at 09:00',
  );
  await W.keyboard.press('Escape');
  // The new schedule counts from now; a day later, it's due.
  await W.waitForTimeout(800);
  await me.app.evaluate((_electron, day) => {
    const g = globalThis as { __automationClockOffset?: number; __automationsTick?: () => void };
    g.__automationClockOffset = day;
    g.__automationsTick?.();
  }, DAY + 60_000);
  await expect(titles(W).filter({ hasText: 'Review the day' })).toHaveCount(1, {
    timeout: 10_000,
  });

  // Closed for three days: one run at the next start (not three).
  await me.app.close();
  me = await launchApp(join(root, 'me'), {
    ...ENV,
    WORKSPACE_AUTOMATION_CLOCK_OFFSET_MS: String(4 * DAY),
  });
  await me.window.getByTestId('sidebar-page-title').filter({ hasText: 'Chores' }).click();
  await expect(titles(me.window).filter({ hasText: 'Review the day' })).toHaveCount(2, {
    timeout: 10_000,
  });
  await me.window.waitForTimeout(1000);
  await expect(titles(me.window).filter({ hasText: 'Review the day' })).toHaveCount(2);
  await shot(me.window, 'local-automations-3-scheduled');
});

test('a button sends a signed webhook and a notification from the desktop', async () => {
  const W = me.window;
  await W.getByRole('button', { name: 'New page', exact: true }).click();
  await W.getByLabel('Page title').fill('Robot log');
  await W.getByLabel('Page title').press('Enter');
  // Typing goes to the page only once its editor has the focus.
  await expect(W.getByTestId('page-editor').first()).toBeFocused();
  await W.keyboard.type('/button');
  await expect(W.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await W.keyboard.press('Enter');
  const dialog = W.getByTestId('button-editor');
  await dialog.getByLabel('Button label').fill('Ping the lab');
  await dialog.getByRole('button', { name: 'Add a step' }).click();
  await W.getByTestId('add-step-menu').getByRole('menuitem', { name: 'Send webhook' }).click();
  await dialog.getByLabel('Webhook URL').fill(hookUrl);
  await dialog.getByRole('button', { name: 'Add a step' }).click();
  await W.getByTestId('add-step-menu').getByRole('menuitem', { name: 'Send notification' }).click();
  await dialog.getByTestId('button-step').nth(1).getByRole('checkbox').first().check();
  await dialog.getByLabel('Notification message').fill('Someone pinged the lab');
  await shot(W, 'local-automations-4-button');
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await settle(W);

  const before = received.length;
  await W.getByTestId('button-block').getByRole('button', { name: 'Ping the lab' }).click();
  await expect.poll(() => received.length, { timeout: 10_000 }).toBe(before + 1);
  const { body, headers } = received.at(-1)!;
  expect(JSON.parse(body)).toMatchObject({
    source: { type: 'button' },
    data: { title: 'Robot log' },
  });
  const secret = await W.evaluate(() => window.workspace.automations.buttonSecret());
  expect(headers['x-notion-signature']).toBe(sign(secret, body));
  await expect
    .poll(async () => (await notifications(me.app)).map((n) => `${n.title}: ${n.body}`))
    .toContain('Button: Ping the lab: Someone pinged the lab');
});
