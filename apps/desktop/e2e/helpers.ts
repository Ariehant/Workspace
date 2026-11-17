import { execFileSync } from 'node:child_process';
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
    const slow = (await Promise.all(apps.map(closeApp))).filter((s): s is string => !!s);
    // An app that won't close is a bug to find: the test fails, with what was still running.
    if (slow.length) throw new Error(`The app didn't close\n${slow.join('\n')}`);
  },
});

const CLOSE_TIMEOUT_MS = 20_000;
const START_TIMEOUT_MS = 40_000;

/**
 * Close an app. If that takes over 20 s, note the processes still running (and what they're
 * doing: state and wait channel), end them so the next test starts clean, and return the note.
 */
async function closeApp(app: ElectronApplication): Promise<string | null> {
  let pid: number | undefined;
  try {
    pid = app.process().pid;
  } catch {
    return null; // the test already closed it
  }
  const closing = app.close().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    closing.then(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), CLOSE_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!timedOut || pid === undefined) return null;
  const tree = processTree(pid);
  for (const line of tree.split('\n').slice(1)) {
    const child = Number(line.trim().split(/\s+/)[0]);
    try {
      if (child) process.kill(child, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  await closing;
  return `Still running ${CLOSE_TIMEOUT_MS / 1000} s after close:\n${tree}`;
}

/** The app's process and its descendants: pid, parent, state, wait channel, age, command. */
function processTree(root: number): string {
  try {
    const all = execFileSync('ps', ['-eo', 'pid=,ppid=,stat=,wchan:20=,etime=,args='], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid, ppid] = line.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), line: line.trim().slice(0, 240) };
      });
    const keep = new Set([root]);
    for (let grew = true; grew;) {
      grew = false;
      for (const p of all) {
        if (!keep.has(p.pid) && keep.has(p.ppid)) {
          keep.add(p.pid);
          grew = true;
        }
      }
    }
    return [
      'PID PPID STAT WCHAN ELAPSED COMMAND',
      ...all.filter((p) => keep.has(p.pid)).map((p) => p.line),
    ].join('\n');
  } catch (error) {
    return `(ps failed: ${String(error)})`;
  }
}

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
  // The main process's last output, for a start that doesn't finish. E2E_MAIN_LOG=1 shows all
  // of it (warnings, errors).
  const output: string[] = [];
  const keep = (stream: NodeJS.WriteStream) => (d: Buffer) => {
    output.push(...String(d).split('\n').filter(Boolean));
    output.splice(0, Math.max(0, output.length - 40));
    if (process.env.E2E_MAIN_LOG) stream.write(`[main] ${d}`);
  };
  app.process().stdout?.on('data', keep(process.stdout));
  app.process().stderr?.on('data', keep(process.stderr));
  // Surface renderer exceptions in the test output instead of failing silently.
  app.on('window', (page) =>
    page.on('pageerror', (error) => console.error(`[renderer] ${error.stack ?? error}`)),
  );
  const started = (async () => {
    const window = await app.firstWindow({ timeout: START_TIMEOUT_MS });
    window.on('pageerror', (error) => console.error(`[renderer] ${error.stack ?? error}`));
    await window
      .getByRole('navigation', { name: 'Sidebar' })
      .waitFor({ timeout: START_TIMEOUT_MS });
    return window;
  })();
  const window = await started.catch((error: unknown) => {
    // What was running, and what the app said, when it didn't start.
    const pid = app.process().pid;
    throw new Error(
      `The app didn't show its sidebar in ${START_TIMEOUT_MS / 1000} s: ${String(error)}\n` +
        `${pid === undefined ? '' : processTree(pid)}\nMain process output:\n${output.join('\n')}`,
    );
  });
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
