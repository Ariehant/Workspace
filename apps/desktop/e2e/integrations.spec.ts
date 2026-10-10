/**
 * Phase 6 M5: integrations. Ada (a desktop, on a server) makes "Lab bot" in
 * Members → Integrations and copies its token. The API sees nothing until she connects
 * her database "Parts" to it (Share → Connections); then it reads the rows, and a row it
 * adds appears on her desktop, live. (M6) On a page she connects, it reads her text as
 * blocks, adds its own after it, and comments; she sees both on her desktop. (M7) She sets
 * up its webhook, verifies it with the token sent to it, and a row she adds is reported,
 * signed.
 */
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addRow, newDatabase, titles } from './db';
import { editor, expect, launchApp, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let token = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const received: { body: string; json: any; headers: IncomingMessage['headers'] }[] = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    received.push({ body, json: JSON.parse(body), headers: req.headers });
    res.end('ok');
  });
});
let hookUrl = '';
let partsId = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/notion`;
  root = mkdtempSync(join(tmpdir(), 'workspace-integrations-'));
  server = await startSyncServer(root);
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

/** A call to the API with the integration's token. */
async function api(method: string, path: string, body?: object) {
  const res = await fetch(`${server!.base}/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'notion-version': '2022-06-28',
      ...(body && { 'content-type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

test('Ada makes an integration and copies its token', async () => {
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
  await addRow(A, 'Servo');
  await addRow(A, 'Spur gear');
  await synced(A);

  await A.getByRole('button', { name: 'Members', exact: true }).click();
  const members = A.getByTestId('members-dialog');
  await members.getByRole('tab', { name: 'Integrations' }).click();
  const panel = members.getByTestId('integrations-panel');
  await panel.getByLabel('Integration name').fill('Lab bot');
  await panel.getByRole('button', { name: 'Create' }).click();
  token = (await panel.getByTestId('integration-token-value').textContent()) ?? '';
  expect(token).toMatch(/^ntn_/);
  await shot(A, 'integrations-1-token');
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(panel.getByTestId('integration-row')).toContainText(`ntn_…${token.slice(-4)}`);
  await A.keyboard.press('Escape');

  // Not connected to anything yet.
  expect((await api('GET', '/users/me')).body).toMatchObject({ type: 'bot', name: 'Lab bot' });
  expect((await api('POST', '/search', { query: 'Parts' })).body.results).toEqual([]);
});

test('connected to "Parts", the API reads its rows and adds one, live on the desktop', async () => {
  const A = ada.window;
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByTestId('page-menu-connections').click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Integration', { exact: true }).selectOption({ label: '🤖 Lab bot' });
  await share.getByTestId('connect-integration').click();
  await expect(share.getByTestId('connections')).toContainText('Lab bot');
  await shot(A, 'integrations-2-connections');
  await A.keyboard.press('Escape');

  await expect
    .poll(async () => (await api('POST', '/search', { query: 'Parts' })).body.results?.length, {
      timeout: 15_000,
    })
    .toBe(1);
  const found = await api('POST', '/search', {
    query: 'Parts',
    filter: { property: 'object', value: 'database' },
  });
  const database = found.body.results[0];
  partsId = database.id;
  expect(database).toMatchObject({ object: 'database', title: [{ plain_text: 'Parts' }] });
  const rows = await api('POST', `/databases/${database.id}/query`, {
    sorts: [{ property: 'Name', direction: 'ascending' }],
  });
  expect(
    rows.body.results.map(
      (r: { properties: { Name: { title: { plain_text: string }[] } } }) =>
        r.properties.Name.title[0]!.plain_text,
    ),
  ).toEqual(['Servo', 'Spur gear']);

  const made = await api('POST', '/pages', {
    parent: { database_id: database.id },
    properties: {
      Name: { title: [{ text: { content: 'Stepper motor' } }] },
      Tags: { multi_select: [{ name: 'from the API' }] },
    },
  });
  expect(made.status).toBe(200);
  await expect(titles(A).filter({ hasText: 'Stepper motor' })).toHaveCount(1, { timeout: 15_000 });
  await shot(A, 'integrations-3-row');
});

test('on a connected page, the API reads the blocks, adds its own, and comments', async () => {
  const A = ada.window;
  await A.getByRole('button', { name: 'New page', exact: true }).click();
  await A.getByLabel('Page title').fill('Arm design');
  await A.getByLabel('Page title').press('Enter');
  await expect(editor(A).first()).toBeFocused();
  await A.keyboard.type('Reach is 60 cm.');
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByTestId('page-menu-connections').click();
  const share = A.getByTestId('share-dialog');
  await share.getByLabel('Integration', { exact: true }).selectOption({ label: '🤖 Lab bot' });
  await share.getByTestId('connect-integration').click();
  await expect(share.getByTestId('connections')).toContainText('Lab bot');
  await A.keyboard.press('Escape');
  await synced(A);

  let page: { id: string } | undefined;
  await expect
    .poll(
      async () => {
        const found = await api('POST', '/search', {
          query: 'Arm design',
          filter: { property: 'object', value: 'page' },
        });
        page = found.body.results?.[0];
        return page?.id;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  // Her text, as blocks.
  let blocks: { id: string; type: string; paragraph?: { rich_text: { plain_text: string }[] } }[] =
    [];
  await expect
    .poll(
      async () => {
        blocks = (await api('GET', `/blocks/${page!.id}/children`)).body.results ?? [];
        return blocks.map((b) => b.paragraph?.rich_text.map((r) => r.plain_text).join(''));
      },
      { timeout: 15_000 },
    )
    .toContain('Reach is 60 cm.');

  const text = (content: string) => ({ rich_text: [{ text: { content } }] });
  const added = await api('PATCH', `/blocks/${page!.id}/children`, {
    after: blocks.find((b) => b.type === 'paragraph')!.id,
    children: [
      { type: 'heading_2', heading_2: text('Checks') },
      { type: 'to_do', to_do: { ...text('Torque at full reach'), checked: true } },
      { type: 'to_do', to_do: text('Cable routing') },
      { type: 'callout', callout: { ...text('Payload stays under 2 kg.'), icon: { emoji: '⚠️' } } },
      { type: 'code', code: { ...text('reach_cm = 60'), language: 'python' } },
    ],
  });
  expect(added.status).toBe(200);
  const content = editor(A).first();
  await expect(content.getByRole('heading', { name: 'Checks' })).toBeVisible({ timeout: 15_000 });
  await expect(content).toContainText('Torque at full reach');
  await expect(content).toContainText('Payload stays under 2 kg.');
  await expect(content).toContainText('reach_cm = 60');

  const comment = await api('POST', '/comments', {
    parent: { page_id: page!.id },
    rich_text: [{ text: { content: 'Torque checked at 60 cm: 4.2 N·m, within limits.' } }],
  });
  expect(comment.status).toBe(200);
  await expect(
    A.getByTestId('page-comments').getByTestId('comment-body').filter({ hasText: 'within limits' }),
  ).toHaveCount(1, { timeout: 15_000 });
  await shot(A, 'integrations-4-blocks-and-comment');
});

test('a webhook: verified with the token sent to it, then events for connected pages', async () => {
  const A = ada.window;
  await A.getByRole('button', { name: 'Members', exact: true }).click();
  const members = A.getByTestId('members-dialog');
  await members.getByRole('tab', { name: 'Integrations' }).click();
  const hook = members.getByTestId('webhook-settings');
  await expect(hook.getByTestId('webhook-status')).toHaveText('Off');
  await hook.getByRole('button', { name: 'Set up' }).click();
  await hook.getByLabel('Webhook URL').fill(hookUrl);
  await hook.getByLabel('comment.created').check();
  await shot(A, 'integrations-5-webhook-setup');
  await hook.getByTestId('webhook-save').click();
  await expect(hook.getByTestId('webhook-status')).toHaveText('Waiting for verification');
  await expect.poll(() => received.length, { timeout: 15_000 }).toBe(1);
  const token = received[0]!.json.verification_token as string;
  expect(token).toMatch(/^secret_/);
  await hook.getByLabel('Verification token').fill(token);
  await hook.getByRole('button', { name: 'Verify' }).click();
  await expect(hook.getByTestId('webhook-status')).toHaveText('On');
  await shot(A, 'integrations-6-webhook-on');
  await A.keyboard.press('Escape');

  await A.getByTestId('sidebar-page-title').filter({ hasText: 'Parts' }).click();
  await addRow(A, 'Gear motor');
  await expect
    .poll(() => received.filter((r) => r.json.type === 'page.created').length, {
      timeout: 20_000,
    })
    .toBe(1);
  const event = received.find((r) => r.json.type === 'page.created')!;
  expect(event.json).toMatchObject({
    entity: { type: 'page' },
    data: { parent: { id: partsId, type: 'database' } },
    integration_id: expect.any(String),
  });
  // Signed with the verification token, as Notion documents.
  expect(event.headers['x-notion-signature']).toBe(
    `sha256=${createHmac('sha256', token).update(event.body).digest('hex')}`,
  );
  const page = await api('GET', `/pages/${event.json.entity.id}`);
  expect(page.body.properties.Name.title[0].plain_text).toBe('Gear motor');
});
