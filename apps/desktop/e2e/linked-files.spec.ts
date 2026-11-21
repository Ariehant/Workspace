/**
 * Phase 8 N9: linked files. A page points at files on the computer instead of holding copies:
 * inside a linked folder ("Projects") by name, or by full path. They open with the default
 * app (a script only once confirmed), show where they are, an image shows in the page, and a
 * moved file or a folder not linked here says so and how to fix it.
 */
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { editor, expect, quit, test } from './helpers';

// A 4×3 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);

let out: string;
test.beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'workspace-linked-'));
});
test.afterEach(() => rmSync(out, { recursive: true, force: true }));

/** The next open dialog picks these. */
async function pick(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as never;
  }, paths);
}

/** Opening and showing files is recorded, not done; a confirmation answers `answer`. */
async function record(app: ElectronApplication, answer: number) {
  await app.evaluate(({ dialog, shell }, response) => {
    const seen = globalThis as unknown as { opened: string[]; asked: string[] };
    seen.opened ??= [];
    seen.asked ??= [];
    shell.openPath = (async (path: string) => {
      seen.opened.push(path);
      return '';
    }) as never;
    shell.showItemInFolder = ((path: string) => seen.opened.push(`show:${path}`)) as never;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const options = args.at(-1) as { message: string };
      seen.asked.push(options.message);
      return { response, checkboxChecked: false };
    }) as never;
  }, answer);
}

const seen = (app: ElectronApplication) =>
  app.evaluate(() => {
    const s = globalThis as unknown as { opened?: string[]; asked?: string[] };
    return { opened: s.opened ?? [], asked: s.asked ?? [] };
  });

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

async function linkFiles(window: Page) {
  await window.keyboard.type('/linked file');
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toHaveText(
    /Linked file/,
  );
  await window.keyboard.press('Enter');
}

test('linked files: point at files in a linked folder or by path, open, move, unlink', async ({
  launch,
}) => {
  const work = join(out, 'work');
  mkdirSync(join(work, 'arm'), { recursive: true });
  writeFileSync(join(work, 'arm', 'v3.step'), 'ISO-10303-21;');
  writeFileSync(join(work, 'bench.png'), PNG);
  const script = join(out, 'flash.sh');
  writeFileSync(script, '#!/bin/sh\necho flashed\n');
  chmodSync(script, 0o755);

  const { app, window } = await launch();
  const settingsWindow = window.getByTestId('settings-window');

  // Settings → Linked folders: "Projects" is `work` on this computer.
  await window.keyboard.press('Control+,');
  await settingsWindow.getByRole('tab', { name: 'Linked folders' }).click();
  const panel = window.getByTestId('linked-folders');
  await expect(panel.getByText('No linked folders yet.')).toBeVisible();
  await panel.getByLabel('Folder name').fill('Projects');
  await pick(app, [work]);
  await panel.getByRole('button', { name: 'Add and choose the folder…' }).click();
  await expect(panel.getByTestId('linked-folder')).toHaveCount(1);
  await expect(panel.getByTestId('linked-folder-path')).toHaveText(work);
  // The name is the workspace's: taken now.
  await panel.getByLabel('Folder name').fill('projects');
  await expect(panel.getByRole('alert')).toHaveText('“projects” is already a linked folder');
  await panel.getByLabel('Folder name').fill('');
  await window.keyboard.press('Escape');

  // Where folders are is this computer's, and the page can't change it.
  const steered = await window.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        workspace: {
          settings: { set(key: string, value: unknown): void };
          linkedFiles: { folders(): Promise<unknown> };
        };
      }
    ).workspace;
    try {
      api.settings.set('linkedFolders', { Projects: '/' });
    } catch {
      // Refused either way.
    }
    return api.linkedFiles.folders();
  });
  expect(steered).toEqual({ Projects: work });

  // A page links two files in the folder.
  await newPage(window, 'Arm build');
  await pick(app, [join(work, 'arm', 'v3.step'), join(work, 'bench.png')]);
  await linkFiles(window);
  const cards = window.getByTestId('linked-file');
  await expect(cards).toHaveCount(2);
  await expect(cards.getByTestId('linked-file-name')).toHaveText(['v3.step', 'bench.png']);
  await expect(cards.nth(0).getByTestId('linked-file-location')).toContainText(
    'Projects/arm/v3.step · 13 B',
  );
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'found');
  // The image shows in the page, from where it is.
  const preview = window.locator('img.ws-linked-file-preview');
  await expect(preview).toHaveAttribute('alt', 'bench.png');
  await expect.poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(4);

  // Opening one opens the file itself; "Show in folder" shows it.
  await record(app, 0);
  await cards.nth(0).getByTestId('linked-file-open').click();
  await cards.nth(0).getByRole('button', { name: 'Show in folder' }).click();
  await expect
    .poll(async () => (await seen(app)).opened)
    .toEqual([join(work, 'arm', 'v3.step'), `show:${join(work, 'arm', 'v3.step')}`]);

  // A script outside the folder: linked by its full path, and run only once confirmed.
  await editor(window).press('Control+End');
  await window.keyboard.press('Enter');
  await pick(app, [script]);
  await linkFiles(window);
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2).getByTestId('linked-file-location')).toContainText(script);
  await cards.nth(2).getByTestId('linked-file-open').click();
  await expect
    .poll(async () => (await seen(app)).asked)
    .toEqual(['“flash.sh” is a program or script']);
  expect((await seen(app)).opened).toHaveLength(2);
  await record(app, 1);
  await cards.nth(2).getByTestId('linked-file-open').click();
  await expect.poll(async () => (await seen(app)).opened.at(-1)).toBe(script);

  // Moved: it says so when the window comes back, and Locate… points it at the new place.
  renameSync(join(work, 'arm', 'v3.step'), join(work, 'arm', 'v4.step'));
  await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'missing');
  await expect(window.getByTestId('linked-file-problem')).toHaveText('Not found on this computer.');
  await pick(app, [join(work, 'arm', 'v4.step')]);
  await window.getByRole('button', { name: 'Locate…' }).click();
  await expect(cards.nth(0).getByTestId('linked-file-name')).toHaveText('v4.step');
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'found');

  // The folder unlinked here: the files say which folder to link, and Link it… opens Settings.
  await window.keyboard.press('Control+,');
  await settingsWindow.getByRole('tab', { name: 'Linked folders' }).click();
  await panel.getByRole('button', { name: 'Unlink here' }).click();
  await expect(panel.getByTestId('linked-folder-path')).toHaveText('Not linked on this computer');
  await window.keyboard.press('Escape');
  await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'noFolder');
  await expect(window.getByTestId('linked-file-problem').first()).toHaveText(
    'The “Projects” folder isn’t linked on this computer.',
  );
  await expect(preview).toHaveCount(0);
  // The script by full path still opens.
  await expect(cards.nth(2)).toHaveAttribute('data-state', 'found');
  await window.getByRole('button', { name: 'Link it…' }).first().click();
  await expect(panel).toBeVisible();
  await pick(app, [work]);
  await panel.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(panel.getByTestId('linked-folder-path')).toHaveText(work);
  await window.keyboard.press('Escape');
  await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(cards.nth(0)).toHaveAttribute('data-state', 'found');
  await quit(app);

  // After a restart: the pointers and this computer's folder are kept.
  const again = await launch();
  await again.window.getByTestId('sidebar-page-title').filter({ hasText: 'Arm build' }).click();
  const after = again.window.getByTestId('linked-file');
  await expect(after.getByTestId('linked-file-name')).toHaveText([
    'v4.step',
    'bench.png',
    'flash.sh',
  ]);
  await expect(after.nth(1)).toHaveAttribute('data-state', 'found');
});
