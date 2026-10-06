import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { addRow, newDatabase } from './db';
import { editor, expect, quit, settle, test } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function slash(window: Page, query: string) {
  await window.keyboard.type(`/${query}`);
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toBeVisible();
  await window.keyboard.press('Enter');
}

const openPage = (window: Page, title: string) =>
  window.getByRole('treeitem').filter({ hasText: title }).first().click();

/** Answer the next native dialogs from the test (save, open, and confirm). */
async function stubDialogs(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as never;
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never;
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as never;
  }, path);
}

async function exportPage(window: Page, format: string, subpages = true) {
  await window.getByRole('button', { name: 'Page options' }).click();
  await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Export…' }).click();
  const dialog = window.getByTestId('export-dialog');
  await dialog.getByRole('radio', { name: new RegExp(`^${format}`) }).check();
  const sub = dialog.getByRole('checkbox', { name: 'Include sub-pages' });
  if ((await sub.isChecked()) !== subpages) await sub.click();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

const exported = (window: Page) =>
  expect(window.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
    timeout: 20_000,
  });

const unzip = (path: string) => {
  const files = unzipSync(readFileSync(path));
  return {
    names: Object.keys(files),
    text: (pattern: RegExp) => {
      const name = Object.keys(files).find((n) => pattern.test(n));
      if (!name) throw new Error(`No file matching ${pattern} in ${Object.keys(files).join(', ')}`);
      return new TextDecoder().decode(files[name]);
    },
  };
};

let out: string;
test.beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'workspace-export-'));
});
test.afterEach(() => rmSync(out, { recursive: true, force: true }));

const ID = '[0-9a-f]{32}';

test('export a page as Markdown & CSV in Notion’s layout, with sub-pages', async ({ launch }) => {
  const { app, window } = await launch();
  await newPage(window, 'Robot');
  await window.keyboard.type('Arm with **two** joints');
  await window.keyboard.press('Enter');
  await slash(window, 'page');
  await window.getByLabel('Page title').fill('Specs');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type('Torque: 2 Nm');
  await settle(window);
  await window.getByTestId('sidebar-page-title').getByText('Robot', { exact: true }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Robot');

  const zip = join(out, 'robot.zip');
  await stubDialogs(app, zip);
  await exportPage(window, 'Markdown');
  await exported(window);
  await expect(window.getByTestId('export-path')).toHaveText(zip);

  const files = unzip(zip);
  expect(files.names).toHaveLength(2);
  expect(files.names).toContainEqual(expect.stringMatching(new RegExp(`^Robot ${ID}\\.md$`)));
  const robot = files.text(/^Robot [0-9a-f]+\.md$/);
  expect(robot).toContain('# Robot\n\nArm with **two** joints');
  // The link to the sub-page points at its file, in the page's folder.
  expect(robot).toMatch(new RegExp(`\\[Specs\\]\\(Robot%20${ID}/Specs%20${ID}\\.md\\)`));
  expect(files.text(/\/Specs [0-9a-f]+\.md$/)).toBe('# Specs\n\nTorque: 2 Nm\n');

  // Without sub-pages: just the page.
  await stubDialogs(app, join(out, 'alone.zip'));
  await exportPage(window, 'Markdown', false);
  await exported(window);
  expect(unzip(join(out, 'alone.zip')).names).toHaveLength(1);
});

test('export the whole workspace as HTML, databases as tables and diagrams as SVG', async ({
  launch,
}) => {
  const { app, window } = await launch();
  await newDatabase(window, 'Tasks');
  await addRow(window, 'Calibrate arm');
  await newPage(window, 'Arch');
  await slash(window, 'mermaid');
  await expect(window.getByTestId('mermaid-diagram')).toBeVisible({ timeout: 15_000 });

  const zip = join(out, 'all.zip');
  await stubDialogs(app, zip);
  await window.getByRole('button', { name: 'Workspace menu' }).click();
  await window.getByRole('menuitem', { name: 'Export all workspace content…' }).click();
  const dialog = window.getByTestId('export-dialog');
  // PDF is for single pages.
  await expect(dialog.getByRole('radio')).toHaveCount(2);
  await dialog.getByRole('radio', { name: /^HTML/ }).check();
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await exported(window);

  const files = unzip(zip);
  expect(files.names).toContainEqual(expect.stringMatching(/^Getting started [0-9a-f]+\.html$/));
  const tasks = files.text(/^Tasks [0-9a-f]+\.html$/);
  expect(tasks).toContain('<table class="database">');
  expect(tasks).toMatch(
    /<a href="Tasks [0-9a-f]+\/Calibrate arm [0-9a-f]+\.html">Calibrate arm<\/a>/,
  );
  expect(files.text(/^Tasks [0-9a-f]+\/Calibrate arm [0-9a-f]+\.html$/)).toContain(
    '<h1 class="page-title">Calibrate arm</h1>',
  );
  const arch = files.text(/^Arch [0-9a-f]+\.html$/);
  expect(arch).toContain('<img class="diagram"');
  expect(arch).toContain('Mermaid source');
});

test('export a page as PDF, and cancel an export', async ({ launch }) => {
  const { app, window } = await launch();
  await newPage(window, 'Datasheet');
  await window.keyboard.type('Rated voltage 24 V');
  await settle(window);

  const pdf = join(out, 'datasheet.pdf');
  await stubDialogs(app, pdf);
  await exportPage(window, 'PDF');
  await exported(window);
  const bytes = readFileSync(pdf);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  await window.getByTestId('export-status').getByRole('button', { name: 'Dismiss' }).click();

  // Cancel while the print window is still rendering.
  const cancelled = join(out, 'cancelled.pdf');
  await stubDialogs(app, cancelled);
  await exportPage(window, 'PDF');
  await window.getByTestId('export-status').getByRole('button', { name: 'Cancel' }).click();
  await expect(window.getByTestId('export-status')).toHaveAttribute('data-state', 'cancelled');
  expect(existsSync(cancelled)).toBe(false);
});

test('back up the workspace and restore it', async ({ launch }) => {
  const first = await launch();
  let { window } = first;
  await newPage(window, 'Before backup');
  await window.keyboard.type('Encoder offsets 0.12 rad');
  await settle(window);

  const backup = join(out, 'backup.zip');
  await stubDialogs(first.app, backup);
  await window.getByRole('button', { name: 'Workspace menu' }).click();
  await window.getByRole('menuitem', { name: 'Back up workspace…' }).click();
  await exported(window);
  const files = unzip(backup);
  expect(files.names).toContain('manifest.json');
  expect(files.names).toContain('docs/workspace.ydoc');

  await newPage(window, 'After backup');
  await settle(window);

  // Restoring replaces the workspace and closes the app (which restarts itself).
  await window.getByRole('button', { name: 'Workspace menu' }).click();
  const closed = first.app.waitForEvent('close');
  await window.getByRole('menuitem', { name: 'Restore from backup…' }).click();
  await closed;
  await quit(first.app).catch(() => {});

  ({ window } = await launch());
  const pages = window.getByRole('tree', { name: 'Pages' }).getByRole('treeitem');
  await expect(pages.filter({ hasText: 'Before backup' })).toHaveCount(1);
  await expect(pages.filter({ hasText: 'After backup' })).toHaveCount(0);
  await openPage(window, 'Before backup');
  await expect(editor(window)).toHaveText('Encoder offsets 0.12 rad');
  // The search index was rebuilt.
  await window.keyboard.press('Control+k');
  await window.getByLabel('Search pages').fill('offsets');
  await expect(window.getByTestId('quick-find-result').first()).toContainText('Before backup');
});
