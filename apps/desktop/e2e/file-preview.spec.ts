/**
 * Phase 8 N9 (#9): previews of Office files in the page. An attached Word document shows its
 * headings, text and tables; an Excel workbook its sheets, one at a time; a linked workbook on
 * this computer the same. Opening a preview is kept in the page (after a restart too).
 */
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { writeXlsx } from '../../../packages/importers/src/xlsx-fixture';
import { editor, expect, quit, test } from './helpers';

const fixtures = fileURLToPath(new URL('../../../packages/importers/fixtures', import.meta.url));
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const workbook = () =>
  Buffer.from(
    writeXlsx([
      {
        name: 'Joints',
        rows: [
          ['Joint', 'Range'],
          ['Shoulder', '±170°'],
          ['Elbow', '±135°'],
        ],
      },
      {
        name: 'Motors',
        rows: [
          ['Motor', 'Torque'],
          ['M1', 2.5],
        ],
      },
    ]),
  );

let out: string;
test.beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'workspace-preview-'));
});
test.afterEach(() => rmSync(out, { recursive: true, force: true }));

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function attach(window: Page, name: string, mimeType: string, buffer: Buffer) {
  await window.keyboard.type('/file');
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toHaveText(/^File/);
  await window.keyboard.press('Enter');
  await window
    .getByTestId('media-placeholder')
    .getByLabel('Upload file')
    .setInputFiles({ name, mimeType, buffer });
  await expect(editor(window).locator('.ws-media[data-kind="file"]').last()).toContainText(name);
}

test('previews: a Word document, an Excel workbook and a linked one, kept after a restart', async ({
  launch,
}) => {
  const launched = await launch();
  let { window } = launched;
  await newPage(window, 'Gripper review');

  // A Word document: its headings, bold text and tables, read in the page.
  await attach(
    window,
    'review.docx',
    DOCX,
    readFileSync(join(fixtures, 'docx', 'libreoffice.docx')),
  );
  const files = editor(window).locator('.ws-media[data-kind="file"]');
  await files.first().getByRole('button', { name: 'Show preview' }).click();
  const docPreview = files.first().getByTestId('file-preview');
  await expect(docPreview.locator('h1')).toHaveText('Overview');
  await expect(docPreview.locator('strong')).toHaveText('moving conveyor');
  await expect(docPreview.locator('table th')).toHaveText(['Joint', 'Range', 'Max speed']);
  await expect(docPreview.locator('pre')).toContainText('def reach(l1, l2):');

  // A workbook: a sheet at a time.
  await editor(window).press('Control+End');
  await window.keyboard.press('Enter');
  await attach(window, 'limits.xlsx', XLSX, workbook());
  await files.nth(1).getByRole('button', { name: 'Show preview' }).click();
  const sheet = files.nth(1).getByTestId('file-preview');
  await expect(sheet.getByRole('table', { name: 'Joints' }).locator('tr').nth(1)).toHaveText(
    'Shoulder±170°',
  );
  await sheet.getByRole('tab', { name: 'Motors' }).click();
  await expect(sheet.getByRole('table', { name: 'Motors' }).locator('td')).toHaveText([
    'Motor',
    'Torque',
    'M1',
    '2.5',
  ]);
  // Hidden again, for the restart below to keep only the document's open.
  await files.nth(1).getByRole('button', { name: 'Hide preview' }).click();
  await expect(sheet).toHaveCount(0);

  // A linked workbook on this computer.
  const linkedPath = join(out, 'bench.xlsx');
  writeFileSync(linkedPath, workbook());
  await launched.app.evaluate(
    ({ dialog }, filePaths) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as never;
    },
    [linkedPath],
  );
  await editor(window).press('Control+End');
  await window.keyboard.press('Enter');
  await window.keyboard.type('/linked file');
  await window.keyboard.press('Enter');
  const linked = window.getByTestId('linked-file');
  await expect(linked).toHaveAttribute('data-state', 'found');
  await window.getByRole('button', { name: 'Show preview' }).last().click();
  await expect(
    window.getByTestId('file-preview').last().getByRole('table', { name: 'Joints' }),
  ).toContainText('Elbow');

  // Accessible, in the page.
  const axe = await new AxeBuilder({ page: window })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    .include('[data-testid="file-preview"]')
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);

  // After a restart: the document's and the linked workbook's previews are open again.
  await quit(launched.app);
  ({ window } = await launch());
  await window.getByTestId('sidebar-page-title').filter({ hasText: 'Gripper review' }).click();
  await expect(editor(window).getByTestId('file-preview')).toHaveCount(2);
  await expect(editor(window).getByTestId('file-preview').first().locator('h1')).toHaveText(
    'Overview',
  );
});
