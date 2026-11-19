import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const fixtures = fileURLToPath(new URL('../../../packages/importers/fixtures', import.meta.url));

/** A fixture folder zipped, as the export downloads. */
function zipFolder(dir: string, path: string) {
  const files: Record<string, Uint8Array> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[relative(dir, full).replace(/\\/g, '/')] = new Uint8Array(readFileSync(full));
    }
  };
  walk(dir);
  writeFileSync(path, zipSync(files));
}

async function importFile(app: ElectronApplication, window: Page, path: string, counts: string) {
  await stubOpen(app, path);
  await window.getByRole('button', { name: 'Import', exact: true }).click();
  const report = window.getByTestId('import-report');
  await expect(report.getByTestId('import-counts')).toHaveText(counts, { timeout: 20_000 });
  return report;
}

test('import a Word document (LibreOffice’s, as Google Docs and Word make them)', async ({
  launch,
}) => {
  const { app, window } = await launch();
  const report = await importFile(
    app,
    window,
    join(fixtures, 'docx', 'libreoffice.docx'),
    '1 page, 0 databases with 0 rows, and 1 file.',
  );
  await expect(report).toContainText('Everything came over.');
  await report.getByRole('button', { name: 'Done' }).click();
  // The document is the page, titled from its Title paragraph.
  await expect(window.getByLabel('Page title')).toHaveValue('Gripper design review');
  const page = editor(window);
  await expect(page.locator('h1')).toHaveText('Overview');
  await expect(page.locator('strong')).toHaveText('moving conveyor');
  await expect(page.locator('ul ol li')).toHaveText(['Detect the part', 'Plan the grasp']);
  await expect(page.locator('table th')).toHaveText(['Joint', 'Range', 'Max speed']);
  await expect(page.locator('table td').first()).toHaveText('Shoulder');
  await expect(page.locator('pre')).toContainText('def reach(l1, l2):');
  const image = page.locator('img').first();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(96);
  // And it's found, by what it says.
  await window.keyboard.press('Control+k');
  await window.getByTestId('quick-find').getByLabel('Search pages').fill('moving conveyor');
  await expect(window.getByTestId('quick-find-result').first()).toContainText(
    'Gripper design review',
    { timeout: 15_000 },
  );
  await window.keyboard.press('Escape');
});

test('import a Trello board, an Evernote notebook and a Confluence space', async ({ launch }) => {
  const { app, window } = await launch();

  // Trello: a board grouped by list, cards with their checklists.
  let report = await importFile(
    app,
    window,
    join(fixtures, 'trello', 'arm-build.json'),
    '0 pages, 1 database with 3 rows, and 0 files.',
  );
  await expect(report.getByTestId('import-warnings')).toHaveText(
    '2 archived Trello cards were left out',
  );
  await report.getByRole('button', { name: 'Done' }).click();
  // Found straight away: quick find asks again once the index has the new rows.
  await find(window, 'Mount the base');
  await expect(editor(window).first()).toContainText('Bolt the base to the bench.');
  await find(window, 'Arm build');
  const doing = window.getByTestId('board-column').filter({ hasText: 'Doing' });
  const key = await doing.getAttribute('data-group-key');
  await expect(window.locator(`[data-testid="board-cell"][data-group-key="${key}"]`)).toContainText(
    'Mount the base',
  );
  // A card opens with its description, checklist and comments.
  await window.getByTestId('card').filter({ hasText: 'Mount the base' }).click();
  const peek = window.getByTestId('row-peek');
  await expect(peek.getByLabel('Page title')).toHaveValue('Mount the base');
  await expect(peek.getByTestId('page-editor')).toContainText('Bolt the base to the bench.');
  await expect(peek.getByTestId('page-editor')).toContainText('Drill holes');
  await expect(peek.getByTestId('page-editor')).toContainText(
    'Asha Rao, 2026-11-02: Bolts arrived.',
  );
  await peek.getByRole('button', { name: 'Close' }).click();

  // Evernote: a database of notes, with the note's image and to-dos.
  report = await importFile(
    app,
    window,
    join(fixtures, 'evernote', 'Robotics.enex'),
    '0 pages, 1 database with 2 rows, and 2 files.',
  );
  await report.getByRole('button', { name: 'Done' }).click();
  await find(window, 'Robotics');
  const gripper = window.getByTestId('table-row').filter({ hasText: 'Gripper ideas & tests' });
  await expect(gripper).toContainText('hardware');
  await gripper.getByTestId('row-title').hover();
  await gripper.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(peek.getByLabel('Page title')).toHaveValue('Gripper ideas & tests');
  await expect(peek.getByTestId('page-editor')).toContainText('Silicone fingers, two chambers');
  const image = peek.getByTestId('page-editor').locator('img').first();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  await expect(peek.getByTestId('page-editor').getByRole('checkbox').first()).toBeChecked();
  await peek.getByRole('button', { name: 'Close' }).click();

  // Confluence: the page tree, a callout, and links between pages.
  const zip = join(out, 'Confluence-space-export.zip');
  zipFolder(join(fixtures, 'confluence'), zip);
  report = await importFile(app, window, zip, '4 pages, 0 databases with 0 rows, and 2 files.');
  await expect(report).toContainText('Everything came over.');
  await report.getByRole('button', { name: 'Done' }).click();
  await find(window, 'Arm design');
  await expect(editor(window).first().getByText('Keep hands clear of the elbow.')).toBeVisible();
  await expect(window.getByLabel('Breadcrumb')).toContainText('Home');
  await editor(window).first().getByTestId('mention').filter({ hasText: 'Controllers' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Controllers');
});

test('import Asana and Jira CSV exports: a board, sub-tasks, and the page', async ({ launch }) => {
  const { app, window } = await launch();
  const peek = window.getByTestId('row-peek');
  const column = async (name: string) => {
    const key = await window
      .getByTestId('board-column')
      .filter({ hasText: name })
      .getAttribute('data-group-key');
    return window.locator(`[data-testid="board-cell"][data-group-key="${key}"]`);
  };

  // Asana: a board grouped by section; sub-tasks under their parent.
  let report = await importFile(
    app,
    window,
    join(fixtures, 'asana', 'Arm_build.csv'),
    '0 pages, 1 database with 4 rows, and 0 files.',
  );
  await expect(report.getByTestId('import-warnings')).toHaveText(
    '1 Asana sub-task’s parent was not in the export',
  );
  await report.getByRole('button', { name: 'Done' }).click();
  await find(window, 'Arm build');
  await expect(await column('Doing')).toContainText('Mount the base');
  await expect(await column('To do')).toContainText('Write the joint driver');
  await window.getByTestId('card').filter({ hasText: 'Mount the base' }).click();
  await expect(peek.getByLabel('Page title')).toHaveValue('Mount the base');
  await expect(peek.getByTestId('page-editor')).toContainText('Use the M8 bolts.');
  await expect(peek).toContainText('Drill holes');
  await peek.getByRole('button', { name: 'Close' }).click();

  // Jira: grouped by status, with the description and comments in the page.
  report = await importFile(
    app,
    window,
    join(fixtures, 'jira', 'Jira.csv'),
    '0 pages, 1 database with 3 rows, and 0 files.',
  );
  await report.getByRole('button', { name: 'Done' }).click();
  await find(window, 'Gripper slips on wet parts');
  await expect(editor(window).first()).toContainText('Tried a softer pad.');
  // Back is the import's page; it links to the database.
  await window.keyboard.press('Alt+ArrowLeft');
  await expect(window.getByLabel('Page title')).toHaveValue('Jira');
  await editor(window).getByRole('button', { name: 'Arm build' }).click();
  await expect(window.getByTestId('board-column').filter({ hasText: 'In Progress' })).toHaveCount(
    1,
  );
  await expect(await column('In Progress')).toContainText('Gripper slips on wet parts');
  await expect(await column('Done')).toContainText('Calibrate the wrist');
});
