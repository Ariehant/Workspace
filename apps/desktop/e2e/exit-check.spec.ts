/**
 * Phase 4's exit check: "two devices for one user stay in sync, including after offline
 * edits". Two desktops (separate data folders) signed in as one user on a real server:
 * every kind of change made on one shows on the other; then B is cut off (a proxy in
 * front of the server drops its connection and refuses new ones), both edit the same
 * page, other pages and the same database, and after reconnecting, and again after
 * restarting both, the two hold the very same docs.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { WORKSPACE_DOC_ID, getPageContent, isInTrash, listPages } from '@workspace/core';
import { isDatabaseDoc, readDatabase } from '@workspace/database';
import * as Y from 'yjs';
import { addProperty, addRow, cell, newDatabase, titles } from './db';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';
import { Proxy, startSyncServer, type SyncServer } from './server';

test.describe.configure({ mode: 'serial' });

const shotsDir = process.env.WORKSPACE_SHOTS;
const PASSWORD = 'correct horse battery';

let server: SyncServer | null = null;
let root: string;
let base: string;
let a: Launched;
let b: Launched;
const dirA = () => join(root, 'device-a');
const dirB = () => join(root, 'device-b');
/** Device B reaches the server through this (so the test can cut it off). */
const proxy = new Proxy();

test.beforeAll(async () => {
  test.setTimeout(120_000);
  root = mkdtempSync(join(tmpdir(), 'workspace-exit-check-'));
  server = await startSyncServer(root);
  base = server.base;
  await proxy.start(server.port);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  await proxy.close().catch(() => {});
  await server?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function launch(dir: string): Promise<Launched> {
  const launched = await launchApp(dir);
  await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
  );
  return launched;
}

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const indicator = (window: Page) => window.getByTestId('sync-indicator');
const synced = (window: Page) =>
  expect(indicator(window)).toHaveText('Synced', { timeout: 20_000 });

async function openPage(window: Page, title: string) {
  await sidebarTitles(window)
    .filter({ hasText: new RegExp(`^${title}$`) })
    .first()
    .click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

/** Type a new paragraph at the end of the open page. */
async function append(window: Page, text: string) {
  await editor(window).click();
  await window.keyboard.press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.type(text);
}

const treeItem = (window: Page, title: string) =>
  window
    .getByRole('treeitem')
    .filter({ has: window.getByText(title, { exact: true }) })
    .first();

async function expand(window: Page, title: string) {
  const item = treeItem(window, title);
  const toggle = item.getByRole('button', { name: 'Expand' }).first();
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
}

/**
 * Everything a device holds, as plain data: the page tree, every page's content, every
 * database (schema and rows) and every row's content, read through the app's own API.
 */
async function snapshot(page: Page) {
  const read = async (docId: string) => {
    // The doc's stored updates (together, its state).
    const updates = await page.evaluate(async (id) => {
      const stored = await window.workspace.docs.open(id);
      window.workspace.docs.close(id);
      return stored.map((update) => Array.from(update));
    }, docId);
    const doc = new Y.Doc();
    for (const update of updates) Y.applyUpdate(doc, Uint8Array.from(update));
    return doc;
  };
  const workspace = await read(WORKSPACE_DOC_ID);
  const pages = listPages(workspace)
    .map((p) => ({ ...p, inTrash: isInTrash(workspace, p.id) }))
    .sort((x, y) => x.id.localeCompare(y.id));
  const content: Record<string, unknown> = {};
  for (const page of pages) {
    const doc = await read(page.id);
    if (isDatabaseDoc(doc)) {
      const db = readDatabase(doc);
      content[page.id] = {
        properties: db.properties.map((p) => [p.id, p.name, p.type]),
        rows: db.rows.map((r) => ({ id: r.id, title: r.title, values: r.values })),
      };
      for (const row of db.rows) {
        content[row.id] = getPageContent(await read(row.id)).toString();
      }
    } else {
      content[page.id] = getPageContent(doc).toString();
    }
  }
  return { pages, content };
}

/** The two devices hold the same docs (waits for sync to settle). */
async function expectSameDocs(timeout = 30_000) {
  let last: [unknown, unknown] = [null, null];
  await expect
    .poll(
      async () => {
        last = [await snapshot(a.window), await snapshot(b.window)];
        return JSON.stringify(last[0]) === JSON.stringify(last[1]);
      },
      { timeout, intervals: [250, 500, 1000] },
    )
    .toBe(true)
    .catch((error: unknown) => {
      expect(last[1], 'device B differs from device A').toEqual(last[0]);
      throw error;
    });
  return last[0] as Awaited<ReturnType<typeof snapshot>>;
}

test('two desktops: account, upload, and the other device joins', async () => {
  a = await launch(dirA());
  await indicator(a.window).click();
  let dialog = a.window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-name').fill('Ada');
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await dialog.getByTestId('sync-start').click();
  await synced(a.window);

  // B reaches the server through the proxy (so the test can cut it off).
  b = await launch(dirB());
  await indicator(b.window).click();
  dialog = b.window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(`http://127.0.0.1:${proxy.port}`);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill(PASSWORD);
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-remote-Robotics lab').click();
  await dialog.getByTestId('sync-replace').check();
  const closed = b.app.waitForEvent('close');
  await dialog.getByTestId('sync-start').click();
  await closed;
  b = await launch(dirB());
  await synced(b.window);
  await expectSameDocs();
});

test('live: text, sub-page, move, database rows and properties, trash, attachment', async () => {
  const A = a.window;
  const B = b.window;

  // Page text.
  await newPage(A, 'Arm');
  await A.keyboard.type('Six-axis arm, 5 kg payload.');
  await expect(sidebarTitles(B).filter({ hasText: /^Arm$/ })).toHaveCount(1, { timeout: 10_000 });
  await openPage(B, 'Arm');
  await expect(editor(B)).toContainText('Six-axis arm, 5 kg payload.');

  // A sub-page.
  const arm = treeItem(A, 'Arm');
  await arm.hover();
  await arm.getByRole('button', { name: 'Add a page inside' }).click();
  await A.getByLabel('Page title').fill('Wrist');
  await expand(B, 'Arm');
  await expect(treeItem(B, 'Arm').getByText('Wrist', { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // A page moved in the tree (top level → inside Arm).
  await newPage(A, 'Motors');
  await expect(sidebarTitles(B).filter({ hasText: /^Motors$/ })).toHaveCount(1, {
    timeout: 10_000,
  });
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByTestId('page-menu').getByRole('menuitem', { name: 'Move to', exact: true }).click();
  const move = A.getByTestId('move-dialog');
  await move.getByLabel('Search for a page to move to').fill('Arm');
  await move.getByRole('option', { name: 'Arm', exact: true }).click();
  await expand(B, 'Arm');
  await expect(treeItem(B, 'Arm').getByText('Motors', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    B.getByRole('tree', { name: 'Private' })
      .locator(':scope > li')
      .filter({ hasText: /^Motors/ }),
  ).toHaveCount(0);

  // A database: rows, a new property, a value.
  await newDatabase(A, 'Inventory');
  await addRow(A, 'Servo');
  await addProperty(A, 'Text', 'Supplier');
  await (await cell(A, 'Servo', 'Supplier')).click();
  await A.keyboard.type('Dynamixel');
  await A.keyboard.press('Escape');
  await expect(sidebarTitles(B).filter({ hasText: /^Inventory$/ })).toHaveCount(1, {
    timeout: 10_000,
  });
  await openPage(B, 'Inventory');
  await expect(titles(B).getByText('Servo', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(await cell(B, 'Servo', 'Supplier')).toHaveText('Dynamixel', { timeout: 10_000 });

  // A deleted page (to the trash).
  await newPage(A, 'Scratch');
  await expect(sidebarTitles(B).filter({ hasText: /^Scratch$/ })).toHaveCount(1, {
    timeout: 10_000,
  });
  await A.getByRole('button', { name: 'Page options' }).click();
  await A.getByTestId('page-menu').getByRole('menuitem', { name: 'Move to Trash' }).click();
  await expect(sidebarTitles(B).filter({ hasText: /^Scratch$/ })).toHaveCount(0, {
    timeout: 10_000,
  });

  // An attachment.
  await openPage(A, 'Arm');
  await editor(A).click();
  await A.keyboard.press('Control+End');
  await editor(A).evaluate(async (el) => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 160;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#e2e8f0';
    g.fillRect(0, 0, 320, 160);
    g.fillStyle = '#2383e2';
    g.fillRect(40, 40, 240, 80);
    const blob = await new Promise<Blob>((r) => canvas.toBlob((x) => r(x!), 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'arm.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await openPage(B, 'Arm');
  const image = editor(B).locator('.ws-image img');
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth).catch(() => 0), {
      timeout: 20_000,
    })
    .toBe(320);

  await synced(A);
  await synced(B);
  await expectSameDocs();
});

test('offline: both edit the same page, other pages and the same database; they converge', async () => {
  const A = a.window;
  const B = b.window;
  proxy.cut();
  await expect(indicator(B)).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });

  // The same page, on both.
  await openPage(A, 'Arm');
  await openPage(B, 'Arm');
  await append(A, 'Edited on A while B was offline.');
  await append(B, 'Edited on B while offline.');
  // Other pages.
  await newPage(A, 'From A');
  await newPage(B, 'From B');
  // The same database: new rows on both, and the same cell changed on both.
  await openPage(A, 'Inventory');
  await openPage(B, 'Inventory');
  await addRow(A, 'Gripper');
  await addRow(B, 'Camera');
  await (await cell(B, 'Camera', 'Supplier')).click();
  await B.keyboard.type('Intel');
  await B.keyboard.press('Escape');
  await (await cell(A, 'Gripper', 'Supplier')).click();
  await A.keyboard.type('Robotiq');
  await A.keyboard.press('Escape');
  await expect(indicator(B)).toContainText(/Offline · \d+ changes? to sync/);
  await shot(B, 'exit-1-b-offline');

  proxy.restore();
  // Reconnect now rather than at the next backoff step.
  await b.app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'));
  await synced(B);
  await synced(A);
  const merged = await expectSameDocs();

  // Everything from both sides is there.
  const titlesOf = (s: typeof merged) => s.pages.filter((p) => !p.inTrash).map((p) => p.title);
  expect(titlesOf(merged)).toEqual(
    expect.arrayContaining(['From A', 'From B', 'Arm', 'Inventory']),
  );
  for (const window of [A, B]) {
    await openPage(window, 'Arm');
    await expect(editor(window)).toContainText('Edited on A while B was offline.');
    await expect(editor(window)).toContainText('Edited on B while offline.');
    await openPage(window, 'Inventory');
    for (const row of ['Servo', 'Gripper', 'Camera']) {
      await expect(titles(window).getByText(row, { exact: true })).toBeVisible();
    }
    await expect(await cell(window, 'Camera', 'Supplier')).toHaveText('Intel');
    await expect(await cell(window, 'Gripper', 'Supplier')).toHaveText('Robotiq');
  }
  await openPage(A, 'Arm');
  await openPage(B, 'Arm');
  await shot(A, 'exit-2-a-after');
  await shot(B, 'exit-3-b-after');

  // Restart both: still identical, and the same as before.
  await a.app.close();
  await b.app.close();
  a = await launch(dirA());
  b = await launch(dirB());
  await synced(a.window);
  await synced(b.window);
  expect(await expectSameDocs()).toEqual(merged);
});
