/**
 * Phase 6 M5: integrations. Ada (a desktop, on a server) makes "Lab bot" in
 * Members → Integrations and copies its token. The API sees nothing until she connects
 * her database "Parts" to it (Share → Connections); then it reads the rows, and a row it
 * adds appears on her desktop, live.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addRow, newDatabase, titles } from './db';
import { expect, launchApp, test, type Launched } from './helpers';
import { startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let ada: Launched;
let token = '';

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-integrations-'));
  server = await startSyncServer(root);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await ada?.app.close().catch(() => {});
  await server?.stop();
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
