/**
 * Desktop sync against a real server: the built `apps/server` bundle on a throwaway
 * Postgres. Device A creates the account and uploads its workspace; device B takes the
 * server's workspace; edits, attachments and offline changes flow between them.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { createTestDatabase, startTestPostgres } from '@workspace/storage-remote/testing';
import { startFakeProvider } from '../../server/src/test-oidc-provider';
import { editor, expect, launchApp, sidebarTitles, test, type Launched } from './helpers';

test.describe.configure({ mode: 'serial' });

const serverDir = fileURLToPath(new URL('../../server', import.meta.url));
/** Set WORKSPACE_SHOTS=<dir> to save screenshots of the sync UI. */
const shotsDir = process.env.WORKSPACE_SHOTS;

/** 4×3 red PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);

let postgres: Awaited<ReturnType<typeof startTestPostgres>>;
let databaseUrl: string;
let server: ChildProcess | null = null;
let port: number;
let base: string;
let root: string;
const dirA = () => join(root, 'device-a');
const dirB = () => join(root, 'device-b');
const dirC = () => join(root, 'device-c');
let a: Launched | null = null;
let b: Launched | null = null;
let c: Launched | null = null;

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

async function startServer(extraEnv: Record<string, string> = {}) {
  server = spawn('node', ['dist/main.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      ...extraEnv,
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: base,
      FILES_DIR: join(root, 'server-files'),
      SIGNUP: 'open',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  await expect
    .poll(
      () =>
        fetch(`${base}/api/ready`).then(
          (r) => r.status,
          () => 0,
        ),
      { timeout: 20_000 },
    )
    .toBe(200);
}

async function stopServer() {
  const running = server;
  server = null;
  if (!running || running.exitCode !== null) return;
  await new Promise((resolve) => {
    running.once('exit', resolve);
    running.kill('SIGTERM');
  });
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  const build = spawnSync('node', ['build.mjs'], { cwd: serverDir, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`Server build failed: ${build.stderr}`);
  postgres = await startTestPostgres();
  databaseUrl = await createTestDatabase(postgres.url);
  root = mkdtempSync(join(tmpdir(), 'workspace-sync-e2e-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  await startServer();
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});

test.afterAll(async () => {
  await a?.app.close().catch(() => {});
  await b?.app.close().catch(() => {});
  await c?.app.close().catch(() => {});
  await stopServer();
  await postgres?.stop();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function shot(window: Page, name: string) {
  if (!shotsDir) return;
  await window.waitForTimeout(250);
  await window.screenshot({ path: join(shotsDir, `${name}.png`) });
}

async function launch(dir: string, env: Record<string, string> = {}): Promise<Launched> {
  const launched = await launchApp(dir, env);
  await launched.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 800),
  );
  return launched;
}

const indicator = (window: Page) => window.getByTestId('sync-indicator');

async function openPage(window: Page, title: string) {
  await sidebarTitles(window).filter({ hasText: title }).first().click();
  await expect(window.getByLabel('Page title')).toHaveValue(title);
}

test('device A creates the account and uploads its workspace', async () => {
  a = await launch(dirA());
  const { window } = a;
  await expect(indicator(window)).toHaveText('Sync is off');

  // A page made before sync was set up goes up with everything else.
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill('Gripper');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type('Two-finger parallel gripper.');

  await indicator(window).click();
  const dialog = window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(base);
  await shot(window, '1-sync-server');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  // A brand-new server: the first account becomes its admin.
  await expect(dialog).toContainText('this account becomes its admin');
  await dialog.getByTestId('sync-name').fill('Ada');
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill('correct horse battery');
  await shot(window, '2-sync-create-account');
  await dialog.getByTestId('sync-sign-in').click();

  await expect(dialog.getByTestId('sync-upload')).toBeVisible();
  await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
  await shot(window, '3-sync-choose-workspace');
  await dialog.getByTestId('sync-start').click();
  await expect(dialog).toBeHidden();

  await expect(indicator(window)).toHaveAttribute('data-state', 'live');
  await expect(indicator(window)).toHaveText('Synced', { timeout: 15_000 });
  await shot(window, '4-synced-sidebar');

  await indicator(window).click();
  await expect(dialog.getByTestId('sync-workspace')).toHaveText('Robotics lab');
  await expect(dialog.getByTestId('sync-changes-to-send')).toHaveText('0');
  await shot(window, '5-sync-status');
  await window.keyboard.press('Escape');

  // The server has it: the workspace is listed for the account.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-workspace-client': 'e2e' },
    body: JSON.stringify({
      email: 'ada@lab.io',
      password: 'correct horse battery',
      client: 'desktop',
    }),
  }).then((r) => r.json() as Promise<{ token: string }>);
  const listed = await fetch(`${base}/api/workspaces`, {
    headers: { authorization: `Bearer ${login.token}` },
  }).then((r) => r.json() as Promise<{ workspaces: { id: string; name: string }[] }>);
  expect(listed.workspaces.map((w) => w.name)).toEqual(['Robotics lab']);
  // ...and has indexed it: the server's search finds the page by its content.
  const search = () =>
    fetch(`${base}/api/workspaces/${listed.workspaces[0]!.id}/search?q=parallel`, {
      headers: { authorization: `Bearer ${login.token}` },
    }).then((r) => r.json() as Promise<{ results: { title: string; snippet: string }[] }>);
  await expect.poll(async () => (await search()).results.map((r) => r.title)).toEqual(['Gripper']);
  expect((await search()).results[0]!.snippet).toContain('[parallel]');
});

test('device B takes the server’s workspace, and edits flow both ways', async () => {
  b = await launch(dirB());
  // A fresh install has its own welcome page...
  await expect(sidebarTitles(b.window)).toHaveText(['Getting started']);
  await indicator(b.window).click();
  const dialog = b.window.getByTestId('sync-dialog');
  await dialog.getByTestId('sync-server').fill(base);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByTestId('sync-email').fill('ada@lab.io');
  await dialog.getByTestId('sync-password').fill('correct horse battery');
  await dialog.getByTestId('sync-sign-in').click();
  await dialog.getByTestId('sync-remote-Robotics lab').click();
  await dialog.getByTestId('sync-replace').check();
  await shot(b.window, '6-sync-join-replace');
  // ...which is set aside: the app restarts on the server's workspace.
  const closed = b.app.waitForEvent('close');
  await dialog.getByTestId('sync-start').click();
  await closed;

  b = await launch(dirB());
  await expect(indicator(b.window)).toHaveText('Synced', { timeout: 15_000 });
  await expect(sidebarTitles(b.window)).toHaveText(
    await sidebarTitles(a!.window).allTextContents(),
  );
  await openPage(b.window, 'Gripper');
  await expect(editor(b.window)).toContainText('Two-finger parallel gripper.');

  // Live: A types, B sees it; B renames, A sees it.
  await openPage(a!.window, 'Gripper');
  await editor(a!.window).click();
  await a!.window.keyboard.press('End');
  await a!.window.keyboard.press('Enter');
  await a!.window.keyboard.type('Torque limit 2 Nm.');
  await expect(editor(b.window)).toContainText('Torque limit 2 Nm.', { timeout: 10_000 });
  await b.window.getByLabel('Page title').fill('Gripper v2');
  await expect(sidebarTitles(a!.window).filter({ hasText: 'Gripper v2' })).toHaveCount(1, {
    timeout: 10_000,
  });

  await shot(a!.window, '7-device-a');
  await shot(b.window, '8-device-b');

  // An attachment pasted on A uploads; B downloads it when the page shows it.
  await editor(a!.window).evaluate((el, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], 'gripper.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, PNG.toString('base64'));
  await expect(indicator(a!.window)).toHaveText('Synced', { timeout: 15_000 });
  const image = editor(b.window).locator('.ws-image img');
  await expect(image).toHaveAttribute('src', /^ws-file:/, { timeout: 10_000 });
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 10_000 })
    .toBe(4);
});

test('offline changes wait in the outbox, and a restart keeps syncing', async () => {
  const A = a!;
  await stopServer();
  await expect(indicator(A.window)).toHaveAttribute('data-state', 'offline', { timeout: 15_000 });
  await editor(A.window).click();
  await A.window.keyboard.press('Control+End');
  await A.window.keyboard.press('Enter');
  await A.window.keyboard.type('Written while the server was down.');
  await expect(indicator(A.window)).toContainText(/Offline · \d+ changes? to sync/);
  await indicator(A.window).click();
  await shot(A.window, '9-offline');

  await startServer();
  // "Retry now" reconnects at once (unless the backoff got there first).
  await A.window
    .getByTestId('sync-dialog')
    .getByRole('button', { name: 'Retry now' })
    .click({ timeout: 2000 })
    .catch(() => {});
  await expect(A.window.getByTestId('sync-status')).toHaveAttribute('data-state', 'live', {
    timeout: 20_000,
  });
  await A.window.keyboard.press('Escape');
  // B reconnects on its own (backoff), then gets the change.
  await expect(editor(b!.window)).toContainText('Written while the server was down.', {
    timeout: 45_000,
  });

  // Quit and start A again: still signed in, still syncing.
  await A.app.close();
  a = await launch(dirA());
  await expect(indicator(a.window)).toHaveText('Synced', { timeout: 15_000 });
  await openPage(a.window, 'Gripper v2');
  await editor(a.window).click();
  await a.window.keyboard.press('Control+End');
  await a.window.keyboard.press('Enter');
  await a.window.keyboard.type('After a restart.');
  await expect(editor(b!.window)).toContainText('After a restart.', { timeout: 10_000 });
});

test('a third device signs in with single sign-on and merges its pages', async () => {
  // The server with an OIDC provider (a fake one, started here).
  const idp = await startFakeProvider();
  idp.account = { sub: 'ada-sso', email: 'ada@lab.io', email_verified: true, name: 'Ada' };
  try {
    await stopServer();
    await startServer({
      OIDC_PROVIDERS: 'lab',
      OIDC_LAB_ISSUER: idp.issuer,
      OIDC_LAB_CLIENT_ID: idp.clientId,
      OIDC_LAB_CLIENT_SECRET: idp.clientSecret,
      OIDC_LAB_NAME: 'Lab SSO',
      OIDC_ALLOW_INSECURE: 'true',
    });
    // The app "opens the browser" by following the links itself.
    c = await launch(dirC(), { WORKSPACE_E2E_FOLLOW_LINKS: '1' });
    await indicator(c.window).click();
    const dialog = c.window.getByTestId('sync-dialog');
    await dialog.getByTestId('sync-server').fill(base);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await shot(c.window, '10-sync-sso');
    await dialog.getByRole('button', { name: 'Continue with Lab SSO' }).click();
    // Same verified email: the SSO identity joins Ada's account, which sees the workspace.
    await dialog.getByTestId('sync-remote-Robotics lab').click();
    await dialog.getByTestId('sync-start').click();
    await expect(indicator(c.window)).toHaveText('Synced', { timeout: 15_000 });
    // Merged: the server's pages and this device's own welcome page.
    await expect(sidebarTitles(c.window).filter({ hasText: 'Gripper v2' })).toHaveCount(1);
    await expect(sidebarTitles(c.window).filter({ hasText: 'Getting started' })).toHaveCount(2);
    // ...and C's page reaches A.
    await expect(sidebarTitles(a!.window).filter({ hasText: 'Getting started' })).toHaveCount(2, {
      timeout: 15_000,
    });
  } finally {
    await idp.stop();
  }
});
