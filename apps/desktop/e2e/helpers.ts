import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _electron as electron,
  test as base,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

export { expect };

const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as string;

export interface Launched {
  app: ElectronApplication;
  window: Page;
}

/**
 * Test fixtures. Each test gets its own empty data dir, and `launch()` starts the
 * built app on it (call it again after `quit` to simulate a restart). Every app a
 * test launched is closed afterwards, even if the test fails.
 *
 * (Fixtures rather than beforeEach/afterEach in this module: hooks in a shared
 * module only register for the first spec file that imports it.)
 */
export const test = base.extend<{ dataDir: string; launch: () => Promise<Launched> }>({
  dataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  launch: async ({ dataDir }, use) => {
    const apps: ElectronApplication[] = [];
    await use(async () => {
      const args = [appDir];
      // Chromium refuses to start its sandbox as root (e.g. in containers).
      if (process.getuid?.() === 0) args.push('--no-sandbox');
      const app = await electron.launch({
        executablePath: electronPath,
        args,
        env: { ...process.env, WORKSPACE_DATA_DIR: dataDir },
      });
      apps.push(app);
      const window = await app.firstWindow();
      await window.getByRole('tree', { name: 'Pages' }).waitFor();
      return { app, window };
    });
    await Promise.all(apps.map((app) => app.close().catch(() => {})));
  },
});

export async function quit(app: ElectronApplication) {
  await app.close();
}

export const sidebarTitles = (window: Page) => window.getByTestId('sidebar-page-title');
export const editor = (window: Page) => window.getByTestId('page-editor');

/** Wait until the main process has indexed `text`, i.e. it has really received the edits. */
export async function waitForIndexed(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate((q) => window.workspace.search(q), text), { timeout: 10_000 })
    .not.toEqual([]);
}
