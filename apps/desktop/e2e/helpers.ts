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
      const launched = await launchApp(dataDir);
      apps.push(launched.app);
      return launched;
    });
    await Promise.all(apps.map((app) => app.close().catch(() => {})));
  },
});

/** Start the built app on `dataDir` and wait for its sidebar. */
export async function launchApp(
  dataDir: string,
  env: Record<string, string> = {},
): Promise<Launched> {
  const args = [appDir];
  // Chromium refuses to start its sandbox as root (e.g. in containers).
  if (process.getuid?.() === 0) args.push('--no-sandbox');
  const app = await electron.launch({
    executablePath: electronPath,
    args,
    env: {
      ...process.env,
      WORKSPACE_DATA_DIR: dataDir,
      WORKSPACE_E2E: '1',
      WORKSPACE_VERSION_INTERVAL_MS: '1500',
      ...env,
    },
  });
  // E2E_MAIN_LOG=1: show the main process's output (warnings, errors).
  if (process.env.E2E_MAIN_LOG) {
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[main] ${d}`));
    app.process().stderr?.on('data', (d: Buffer) => process.stderr.write(`[main] ${d}`));
  }
  // Surface renderer exceptions in the test output instead of failing silently.
  app.on('window', (page) =>
    page.on('pageerror', (error) => console.error(`[renderer] ${error.stack ?? error}`)),
  );
  const window = await app.firstWindow();
  window.on('pageerror', (error) => console.error(`[renderer] ${error.stack ?? error}`));
  await window.getByRole('tree', { name: 'Pages' }).waitFor({ state: 'attached' });
  // Without a window manager (xvfb) a new window isn't always focused, and the
  // editor's selection toolbar and caret placement need a focused window.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await window.bringToFront();
  return { app, window };
}

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

/**
 * Let two animation frames pass. TipTap's `chain().focus()` (toolbar buttons, paste)
 * rewrites the selection a frame later, which would undo a key pressed in between;
 * people don't type that fast, tests do.
 */
export async function settle(page: Page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
