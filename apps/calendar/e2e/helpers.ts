/**
 * E2E fixtures: a real Workspace server per worker (built from apps/server, on a throwaway
 * Postgres, seeded with a workspace and an integration), and the built calendar app started on
 * a fresh data dir per test.
 */
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
import {
  seedWorkspace,
  startTestServer,
  type SeededWorkspace,
  type TestServer,
} from '@workspace/server/testing';

export { expect };

const appDir = fileURLToPath(new URL('..', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as string;

export interface Launched {
  app: ElectronApplication;
  window: Page;
}

/** Calls to the seeded workspace's `/v1` API, as the integration. */
export class V1 {
  constructor(readonly seed: SeededWorkspace) {}

  async call<T = Record<string, unknown>>(method: string, path: string, body?: object): Promise<T> {
    const res = await fetch(`${this.seed.base}/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.seed.integration.token}`,
        'notion-version': '2022-06-28',
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    const json = (await res.json()) as T;
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  }

  /** A database with a title, a date property `When` and a select `Kind`. */
  async database(title: string): Promise<string> {
    const db = await this.call<{ id: string }>('POST', '/databases', {
      parent: { page_id: this.seed.pageId },
      title: [{ text: { content: title } }],
      properties: {
        Name: { title: {} },
        When: { date: {} },
        Kind: { select: { options: [{ name: 'Work', color: 'green' }] } },
      },
    });
    return db.id;
  }

  async row(databaseId: string, name: string, date: { start: string; end?: string | null }) {
    const page = await this.call<{ id: string }>('POST', '/pages', {
      parent: { database_id: databaseId },
      properties: {
        Name: { title: [{ text: { content: name } }] },
        When: { date },
      },
    });
    return page.id;
  }

  async page(id: string) {
    return this.call<{ properties: Record<string, unknown>; in_trash: boolean }>(
      'GET',
      `/pages/${id}`,
    );
  }
}

export const test = base.extend<
  { dataDir: string; launch: (env?: Record<string, string>) => Promise<Launched> },
  { server: TestServer; seed: SeededWorkspace; v1: V1 }
>({
  server: [
    async ({}, use) => {
      const server = await startTestServer();
      await use(server);
      await server.stop();
    },
    { scope: 'worker', timeout: 180_000 },
  ],
  seed: [async ({ server }, use) => use(await seedWorkspace(server.base)), { scope: 'worker' }],
  v1: [async ({ seed }, use) => use(new V1(seed)), { scope: 'worker' }],

  dataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'calendar-e2e-'));
    await use(dir);
    rmSync(dir, { recursive: true, force: true });
  },

  launch: async ({ dataDir }, use) => {
    const apps: ElectronApplication[] = [];
    await use(async (env = {}) => {
      const launched = await launchApp(dataDir, env);
      apps.push(launched.app);
      return launched;
    });
    for (const app of apps) await closeApp(app);
  },
});

const CLOSE_TIMEOUT_MS = 20_000;

/** Close an app; one that won't close in 20 s is killed (and the test fails). */
export async function closeApp(app: ElectronApplication) {
  let pid: number | undefined;
  try {
    pid = app.process().pid;
  } catch {
    return;
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
  if (timedOut && pid) {
    process.kill(pid, 'SIGKILL');
    throw new Error(`The app didn't close within ${CLOSE_TIMEOUT_MS / 1000} s`);
  }
}

/** Start the built app on `dataDir`, and wait for its window. */
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
      CALENDAR_DATA_DIR: dataDir,
      CALENDAR_SYNC_INTERVAL_MS: '1500',
      ...env,
    },
    timeout: 40_000,
  });
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');
  await expect(window.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  return { app, window };
}
