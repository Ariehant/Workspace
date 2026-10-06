import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { zipSync } from 'fflate';
import { cell, table } from './db';
import { editor, expect, quit, settle, test } from './helpers';

const R = '1a2b3c4d5e6f40718293a4b5c6d7e8f9';
const S = '2a2b3c4d5e6f40718293a4b5c6d7e8f9';
const T = '3a2b3c4d5e6f40718293a4b5c6d7e8f9';
const P = '4a2b3c4d5e6f40718293a4b5c6d7e8f9';
const A = '6a2b3c4d5e6f40718293a4b5c6d7e8f9';
const enc = (text: string) => new TextEncoder().encode(text);
// A 1×1 PNG.
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
);

/** A Notion "Markdown & CSV" export, zipped the way Notion does (a zip in a zip). */
function notionExport(path: string) {
  const files = {
    [`Robot ${R}.md`]: enc(
      [
        '# Robot',
        `Arm with **two** joints. See [Specs](Robot%20${R}/Specs%20${S}.md).`,
        '<aside>\n💡 Keep hands clear\n\n</aside>',
        `![arm.png](Robot%20${R}/arm.png)`,
        `[Tasks](Robot%20${R}/Tasks%20${T}.csv)`,
      ].join('\n\n'),
    ),
    [`Robot ${R}/arm.png`]: PNG,
    [`Robot ${R}/Specs ${S}.md`]: enc('# Specs\n\nTorque limit 2 Nm'),
    [`Robot ${R}/Tasks ${T}_all.csv`]: enc(
      '﻿Name,Status,Project\n' +
        `Wire motors,Done,Arm (../Projects%20${P}/Arm%20${A}.md)\n` +
        `Tune PID,Doing,Arm (../Projects%20${P}/Arm%20${A}.md)\n`,
    ),
    [`Robot ${R}/Projects ${P}.csv`]: enc('Name\nArm\n'),
    [`Robot ${R}/Projects ${P}/Arm ${A}.md`]: enc('# Arm\n\nThe 6-DOF arm.'),
  };
  const inner = zipSync(files);
  writeFileSync(path, zipSync({ 'Export-abc-Part-1.zip': inner }));
}

async function stubOpen(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as never;
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as never;
  }, path);
}

async function find(window: Page, title: string) {
  await window.keyboard.press('Control+k');
  await window.getByLabel('Search pages').fill(title);
  await window
    .getByTestId('quick-find-result')
    .filter({ hasText: new RegExp(`^${title}`) })
    .first()
    .click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

let out: string;
test.beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'workspace-import-'));
});
test.afterEach(() => rmSync(out, { recursive: true, force: true }));

test('import a Notion export: pages, callout, image, links, databases and relations', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  const zip = join(out, 'Notion export.zip');
  notionExport(zip);
  await stubOpen(first.app, zip);
  await window.getByRole('button', { name: 'Import', exact: true }).click();

  const report = window.getByTestId('import-report');
  await expect(report.getByTestId('import-counts')).toHaveText(
    '2 pages, 2 databases with 3 rows, and 1 file.',
    { timeout: 20_000 },
  );
  await expect(report).toContainText('Everything came over.');
  await report.getByRole('button', { name: 'Done' }).click();
  // The import sits under a page named after the file.
  await expect(window.getByLabel('Page title')).toHaveValue('Notion export');

  await find(window, 'Robot');
  await expect(editor(window).first()).toContainText('Arm with two joints. See Specs.');
  await expect(editor(window).first().locator('strong')).toHaveText('two');
  await expect(editor(window).first().getByText('Keep hands clear')).toBeVisible();
  const image = editor(window).first().locator('img').first();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  // The inline database shows its rows.
  await expect(table(window).getByText('Wire motors')).toBeVisible();
  // The mention opens the imported page.
  await editor(window).first().getByTestId('mention').click();
  await expect(window.getByLabel('Page title')).toHaveValue('Specs');

  await find(window, 'Tasks');
  await expect(await cell(window, 'Tune PID', 'Project')).toHaveText('Arm');
  await expect(await cell(window, 'Wire motors', 'Status')).toHaveText('Done');

  await quit(first.app);
  ({ window } = await launch());
  // Indexed for search, and kept after a restart.
  await find(window, 'Robot');
  await expect(editor(window).first().getByText('Keep hands clear')).toBeVisible();
  await window.keyboard.press('Control+k');
  await window.getByLabel('Search pages').fill('6-DOF');
  await expect(window.getByTestId('quick-find-result').first()).toContainText('Arm');
});

test('export a page to Markdown and import it back', async ({ launch }) => {
  const { app, window } = await launch();
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill('Calibration');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type('# Steps');
  await window.keyboard.press('Enter');
  await window.keyboard.type('[] Zero the encoders');
  await settle(window);

  const zip = join(out, 'calibration.zip');
  await stubOpen(app, zip);
  await window.getByRole('button', { name: 'Page options' }).click();
  await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Export…' }).click();
  await window
    .getByTestId('export-dialog')
    .getByRole('button', { name: 'Export', exact: true })
    .click();
  await expect(window.getByTestId('export-status')).toHaveAttribute('data-state', 'done');

  await window.getByRole('button', { name: 'Import', exact: true }).click();
  await window.getByTestId('import-report').getByRole('button', { name: 'Done' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('calibration');
  const imported = window
    .getByRole('tree', { name: 'Pages' })
    .getByRole('treeitem')
    .filter({ hasText: 'Calibration' });
  await expect(imported).toHaveCount(2);
  await window
    .getByTestId('sidebar-page-title')
    .getByText('Calibration', { exact: true })
    .last()
    .click();
  await expect(editor(window).locator('h1')).toHaveText('Steps');
  await expect(editor(window).locator('ul[data-type="taskList"] li p')).toHaveText(
    'Zero the encoders',
  );
});
