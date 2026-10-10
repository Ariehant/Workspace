/**
 * Phase 6 exit check: all of Phase 6 together. Ada (owner, a desktop on a server) has the
 * database "Orders", with an automation (when a page is added: fill in "Logged" and call
 * a webhook) and her integration "Shop bot" connected to it, with its own webhook.
 *
 * - An outside script adds an order through the API: it appears on her desktop, live;
 *   the automation runs and its webhook arrives; the integration's webhook reports
 *   `page.created`, then `page.properties_updated` (the automation's change).
 * - A public form submission starts the same automation.
 * - Bob, with "Can edit content", adds an order (and the automation runs for it too), but
 *   can't change the database's properties.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from '@playwright/test';
import { addProperty, addRow, cell, newDatabase, table, titles } from './db';
import { expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let bob: Launched;
let browser: Browser | null = null;
let token = '';
let verification = '';
let ordersId = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
/** What the automation's webhook (/automation) and the integration's (/integration) got. */
const received: { path: string; body: string; json: Json; headers: IncomingMessage['headers'] }[] =
  [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    received.push({ path: req.url ?? '', body, json: JSON.parse(body), headers: req.headers });
    res.end('ok');
  });
});
let base = '';
const automationHooks = () => received.filter((r) => r.path === '/automation');
const events = () =>
  received.filter((r) => r.path === '/integration' && r.json.type).map((r) => r.json);

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
  root = mkdtempSync(join(tmpdir(), 'workspace-phase6-exit-'));
  server = await startSyncServer(root);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await browser?.close();
  await ada?.app.close().catch(() => {});
  await bob?.app.close().catch(() => {});
  await server?.stop();
  await new Promise((r) => receiver.close(r));
  if (root) rmSync(root, { recursive: true, force: true });
});

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function launch(dir: string): Promise<Launched> {
  const launched = await launchApp(join(root, dir));
  await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 860),
  );
  return launched;
}

const synced = (window: Page) =>
  expect(window.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

async function signIn(launched: Launched, email: string, name?: string) {
  const window = launched.window;
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

/** The server's own API, as Ada (for the invite). */
async function rest<T = Json>(method: string, path: string, auth: string | null, body?: object) {
  const res = await fetch(`${server!.base}${path}`, {
    method,
    headers: {
      'x-workspace-client': 'desktop',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T;
  expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
  return json;
}

/** The public API, as an outside script would call it. */
async function notion(method: string, path: string, body?: object) {
  const res = await fetch(`${server!.base}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': '2025-09-03',
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Json };
}

test('Ada sets it up: a database with an automation, and an integration with a webhook', async () => {
  ada = await launch('ada');
  const A = ada.window;
  const start = await signIn(ada, 'ada@lab.io', 'Ada');
  await start.getByTestId('sync-workspace-name').fill('Robot shop');
  await start.getByTestId('sync-start').click();
  await synced(A);
  await newDatabase(A, 'Orders');
  await addProperty(A, 'Date', 'Logged');

  // The automation.
  await A.getByTestId('automations-button').click();
  const automations = A.getByTestId('automations-dialog');
  await automations.getByRole('button', { name: 'New automation' }).click();
  const editor = automations.getByTestId('automation-editor');
  await editor.getByLabel('Automation name').fill('Log orders');
  await editor.getByLabel('Add an action').selectOption('setProperties');
  await editor.getByLabel('Set a property').selectOption({ label: 'Logged' });
  await editor.getByLabel('Add an action').selectOption('webhook');
  await editor.getByLabel('Webhook URL').fill(`${base}/automation`);
  await editor.getByTestId('automation-save').click();
  await expect(automations.getByTestId('automation-row')).toContainText('When a page is added');
  await A.keyboard.press('Escape');

  // The integration, and its webhook (verified with the token sent to it).
  await A.getByRole('button', { name: 'Members', exact: true }).click();
  const members = A.getByTestId('members-dialog');
  await members.getByRole('tab', { name: 'Integrations' }).click();
  const panel = members.getByTestId('integrations-panel');
  await panel.getByLabel('Integration name').fill('Shop bot');
  await panel.getByRole('button', { name: 'Create' }).click();
  token = (await panel.getByTestId('integration-token-value').textContent()) ?? '';
  await panel.getByRole('button', { name: 'Done' }).click();
  const hook = panel.getByTestId('webhook-settings');
  await hook.getByRole('button', { name: 'Set up' }).click();
  await hook.getByLabel('Webhook URL').fill(`${base}/integration`);
  await hook.getByTestId('webhook-save').click();
  await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);
  verification = received[0]!.json.verification_token as string;
  await hook.getByLabel('Verification token').fill(verification);
  await hook.getByRole('button', { name: 'Verify' }).click();
  await expect(hook.getByTestId('webhook-status')).toHaveText('On');
  await A.keyboard.press('Escape');

  // Connected to "Orders".
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByTestId('page-menu-connections').click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Integration', { exact: true }).selectOption({ label: '🤖 Shop bot' });
  await share.getByTestId('connect-integration').click();
  await expect(share.getByTestId('connections')).toContainText('Shop bot');
  await A.keyboard.press('Escape');
  await synced(A);
});

test('an outside script adds an order: live on the desktop, the automation runs, both webhooks fire', async () => {
  const A = ada.window;
  await expect
    .poll(
      async () => {
        const found = await notion('POST', '/search', {
          query: 'Orders',
          filter: { property: 'object', value: 'data_source' },
        });
        ordersId = found.body.results?.[0]?.id ?? '';
        return ordersId;
      },
      { timeout: 15_000 },
    )
    .not.toBe('');
  const made = await notion('POST', '/pages', {
    parent: { data_source_id: ordersId },
    properties: { Name: { title: [{ text: { content: 'Order #1001' } }] } },
  });
  expect(made.status).toBe(200);
  const orderId = made.body.id as string;

  // Live on Ada's desktop, logged by the automation.
  await expect(titles(A).filter({ hasText: 'Order #1001' })).toHaveCount(1, { timeout: 15_000 });
  await expect(await cell(A, 'Order #1001', 'Logged')).toContainText(String(new Date().getDate()), {
    timeout: 20_000,
  });
  // The automation's webhook.
  await expect
    .poll(() => automationHooks().map((r) => r.json.data?.title), { timeout: 15_000 })
    .toContain('Order #1001');
  // The integration's: made by the integration, then changed by the automation.
  await expect
    .poll(
      () =>
        events()
          .filter((e) => e.entity.id === orderId)
          .map((e) => e.type),
      { timeout: 20_000 },
    )
    .toEqual(expect.arrayContaining(['page.created', 'page.properties_updated']));
  const created = events().find((e) => e.type === 'page.created' && e.entity.id === orderId)!;
  expect(created).toMatchObject({
    authors: [{ type: 'bot' }],
    data: { parent: { id: ordersId, type: 'database' } },
  });
  const updated = events().find(
    (e) => e.type === 'page.properties_updated' && e.entity.id === orderId,
  )!;
  expect(updated.authors).toEqual([expect.objectContaining({ type: 'bot' })]);
  expect(updated.data.updated_properties).toHaveLength(1);
  // Every event is signed with the verification token.
  for (const r of received.filter((x) => x.path === '/integration' && x.json.type)) {
    expect(r.headers['x-notion-signature']).toBe(
      `sha256=${createHmac('sha256', verification).update(r.body).digest('hex')}`,
    );
  }
  await shot(A, 'phase6-exit-1-api-order');
});

test('a public form submission starts the same automation', async () => {
  const A = ada.window;
  const db = A.getByTestId('database-view').first();
  await db.getByRole('button', { name: 'Add a view' }).click();
  await A.getByTestId('add-view-menu').getByRole('menuitem', { name: 'Form' }).click();
  const builder = A.getByTestId('form-builder');
  await builder.getByLabel('Form title').fill('Place an order');
  await A.getByTestId('form-share').click();
  const panel = A.getByTestId('form-share-panel');
  await panel.getByLabel('Who can fill it in').selectOption('public');
  await panel.getByRole('button', { name: 'Create link' }).click();
  const link = (await panel.getByTestId('form-link').getAttribute('href'))!;
  await A.keyboard.press('Escape');
  await synced(A);

  browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const visitor = await browser.newPage({ viewport: { width: 900, height: 760 } });
  await visitor.goto(link);
  await expect(visitor.locator('h1')).toHaveText('Place an order');
  await visitor.getByLabel('Name').fill('Order #1002');
  await visitor.getByRole('button', { name: 'Submit' }).click();
  await expect(visitor.getByRole('status')).toContainText('Your response was recorded');

  await db.getByRole('tab', { name: 'Table' }).click();
  await expect(titles(A).filter({ hasText: 'Order #1002' })).toHaveCount(1, { timeout: 15_000 });
  await expect(await cell(A, 'Order #1002', 'Logged')).toContainText(String(new Date().getDate()), {
    timeout: 20_000,
  });
  await expect
    .poll(() => automationHooks().map((r) => r.json.data?.title), { timeout: 15_000 })
    .toContain('Order #1002');
  const rows = await notion('POST', `/data_sources/${ordersId}/query`, {
    filter: { property: 'Name', title: { equals: 'Order #1002' } },
  });
  const formRow = rows.body.results[0].id as string;
  await expect
    .poll(
      () =>
        events()
          .filter((e) => e.entity.id === formRow)
          .map((e) => e.type),
      {
        timeout: 20_000,
      },
    )
    .toContain('page.created');
  await shot(A, 'phase6-exit-2-form-order');
});

test('Bob, who may edit content, adds an order but can’t change the database', async () => {
  const A = ada.window;
  const { token: adaToken } = await rest<{ token: string }>('POST', '/api/auth/login', null, {
    email: 'ada@lab.io',
    password: PASSWORD,
    client: 'desktop',
  });
  const { workspaces } = await rest<{ workspaces: { id: string; name: string }[] }>(
    'GET',
    '/api/workspaces',
    adaToken,
  );
  const workspaceId = workspaces.find((w) => w.name === 'Robot shop')!.id;
  const { invites } = await rest<{ invites: { link: string }[] }>(
    'POST',
    `/api/workspaces/${workspaceId}/invites`,
    adaToken,
    { emails: ['bob@lab.io'], role: 'member' },
  );
  await rest('POST', '/api/auth/signup', null, {
    email: 'bob@lab.io',
    name: 'Bob',
    password: PASSWORD,
    invite: invites[0]!.link.split('/invite/')[1],
  });
  bob = await launch('bob');
  const join = await signIn(bob, 'bob@lab.io');
  await join.getByTestId('sync-remote-Robot shop').click();
  await join.getByTestId('sync-replace').check();
  const closed = bob.app.waitForEvent('close');
  await join.getByTestId('sync-start').click();
  await closed;
  bob = await launch('bob');
  await synced(bob.window);

  await A.getByRole('button', { name: 'Share', exact: true }).click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Person or group').selectOption({ label: 'Bob (bob@lab.io)' });
  await share.getByLabel('Role').selectOption('content');
  await share.getByRole('button', { name: 'Invite' }).click();
  await expect(share.getByLabel('Access for Bob')).toHaveValue('content', { timeout: 10_000 });
  await A.keyboard.press('Escape');

  const B = bob.window;
  await expect(sidebarTitles(B).filter({ hasText: /^Orders$/ })).toHaveCount(1, {
    timeout: 15_000,
  });
  await sidebarTitles(B)
    .filter({ hasText: /^Orders$/ })
    .click();
  await expect(B.getByTestId('access-badge')).toHaveText('Can edit content');
  await expect(table(B).getByRole('button', { name: 'Add a property' })).toHaveCount(0);
  await expect(B.getByRole('button', { name: 'Add a view' })).toHaveCount(0);
  await addRow(B, 'Order #1003');
  await synced(B);
  await expect(titles(A).filter({ hasText: 'Order #1003' })).toHaveCount(1, { timeout: 15_000 });
  await expect(await cell(B, 'Order #1003', 'Logged')).toContainText(String(new Date().getDate()), {
    timeout: 20_000,
  });
  await expect
    .poll(() => automationHooks().map((r) => r.json.data?.title), { timeout: 15_000 })
    .toContain('Order #1003');
  await shot(B, 'phase6-exit-3-bob');
  await expect
    .poll(
      () =>
        events()
          .filter((e) => e.type === 'page.created')
          .flatMap((e) => e.authors.map((a: Json) => a.type)),
      { timeout: 20_000 },
    )
    .toContain('person');
});
