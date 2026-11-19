/**
 * Phase 8 N9: Google Drive. With the owner's Google client set in Settings → Connections, the
 * desktop signs in through the browser (PKCE, the answer back on 127.0.0.1), picks files with
 * Google's Picker in a window of its own, and the page keeps a card per file that Drive keeps
 * current: renamed, trashed, after a restart (by the refresh token), and after disconnecting.
 * Google is a stand-in here (`google.ts`).
 */
import type { ElectronApplication, Page } from '@playwright/test';
import { editor, expect, launchApp, quit, test, type Launched } from './helpers';
import { googleEnv, startFakeGoogle, type FakeGoogle } from './google';

const SHEET = '1Sheet_gripperBOM-abc';
const PDF = '1Pdf_datasheet-xyz123';

let google: FakeGoogle;
test.beforeEach(async () => {
  google = await startFakeGoogle();
  google.files.set(SHEET, {
    name: 'Gripper BOM',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    modifiedTime: '2026-11-18T10:00:00.000Z',
  });
  google.files.set(PDF, {
    name: 'Servo datasheet.pdf',
    mimeType: 'application/pdf',
    modifiedTime: '2026-11-17T09:30:00.000Z',
    size: '2048',
  });
});
test.afterEach(() => google.close());

/** The browser: opening Google's sign-in follows it (back to the app); the rest is noted. */
async function browser(app: ElectronApplication, origin: string) {
  await app.evaluate(({ shell }, fakeOrigin) => {
    const seen = globalThis as unknown as { external: string[] };
    seen.external = [];
    shell.openExternal = (async (url: string) => {
      seen.external.push(url);
      if (url.startsWith(fakeOrigin)) await fetch(url);
    }) as never;
  }, origin);
}
const external = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as { external: string[] }).external);

async function settings(window: Page) {
  await window.keyboard.press('Control+,');
  await window.getByTestId('settings-window').getByRole('tab', { name: 'Connections' }).click();
  return window.getByTestId('connections');
}

const focus = (window: Page) => window.evaluate(() => globalThis.dispatchEvent(new Event('focus')));

test('google drive: connect, pick with the Picker, kept current, restart, disconnect', async ({
  dataDir,
}) => {
  test.setTimeout(120_000);
  const env = googleEnv(google);
  let launched: Launched | null = await launchApp(dataDir, env);
  try {
    let { app, window } = launched;
    await browser(app, google.origin);

    // The owner's Google client, then connecting through the browser.
    let panel = await settings(window);
    await panel.getByLabel('OAuth client ID').fill(google.clientId);
    await panel.getByLabel('Client secret').fill(google.clientSecret);
    await panel.getByLabel('Picker API key').fill('picker-key');
    await panel.getByLabel('Project number (app ID)').fill('1234');
    await panel.getByRole('button', { name: 'Save' }).click();
    await panel.getByRole('button', { name: 'Connect Google Drive…' }).click();
    await expect(panel.getByTestId('google-account')).toHaveText('Connected as ada@lab.io');
    expect(google.grants).toEqual(['authorization_code']);
    // The tokens aren't the page's to read.
    const read = await window.evaluate(() =>
      (
        globalThis as unknown as {
          workspace: { settings: { get(key: string): Promise<unknown> } };
        }
      ).workspace.settings
        .get('google.account')
        .then(
          () => 'read',
          () => 'refused',
        ),
    );
    expect(read).toBe('refused');
    await window.keyboard.press('Escape');

    // Two files from the Picker (it gets the token, the key and the app id).
    await window.getByRole('button', { name: 'New page' }).click();
    await window.getByLabel('Page title').fill('Gripper');
    await window.getByLabel('Page title').press('Enter');
    await expect(editor(window)).toBeFocused();
    google.picks = [SHEET, PDF];
    await window.keyboard.type('/google drive');
    await expect(window.getByTestId('slash-menu').getByRole('option').first()).toHaveText(
      /Google Drive file/,
    );
    await window.keyboard.press('Enter');
    let cards = window.getByTestId('drive-file');
    await expect(cards).toHaveCount(2);
    // Drive's own names, not the Picker's.
    await expect(cards.getByTestId('drive-file-name')).toHaveText([
      'Gripper BOM',
      'Servo datasheet.pdf',
    ]);
    await expect(cards.nth(0).getByTestId('drive-file-details')).toContainText(
      'Google Drive · Google Sheets',
    );
    await expect(cards.nth(1).getByTestId('drive-file-details')).toContainText(
      'Google Drive · PDF · 2.0 KB',
    );
    expect(google.pickerSeen).toEqual([
      expect.objectContaining({ apiKey: 'picker-key', appId: '1234' }),
    ]);
    expect(google.pickerSeen[0]!.token).toMatch(/^at-/);
    // The Picker's window is gone.
    await expect.poll(() => app.windows().length).toBe(1);

    // Opening one opens it in Drive (by its id).
    await cards.nth(0).getByTestId('drive-file-open').click();
    await expect
      .poll(async () => (await external(app)).at(-1))
      .toBe(`https://drive.google.com/open?id=${SHEET}`);

    // Renamed in Drive: the page follows. Trashed: it says so.
    google.files.get(SHEET)!.name = 'Gripper BOM v2';
    google.files.get(PDF)!.trashed = true;
    await focus(window);
    await expect(cards.nth(0).getByTestId('drive-file-name')).toHaveText('Gripper BOM v2');
    await expect(cards.nth(1)).toHaveAttribute('data-state', 'gone');
    await expect(cards.nth(1).locator('..').getByTestId('drive-file-problem')).toHaveText(
      'Deleted from Google Drive (or in its trash).',
    );
    await quit(app);
    launched = null;

    // After a restart: still connected (a new access token from the refresh token).
    launched = await launchApp(dataDir, env);
    ({ app, window } = launched);
    await browser(app, google.origin);
    await window.getByTestId('sidebar-page-title').filter({ hasText: 'Gripper' }).click();
    cards = window.getByTestId('drive-file');
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'found');
    await expect(cards.nth(0).getByTestId('drive-file-name')).toHaveText('Gripper BOM v2');
    expect(google.grants).toContain('refresh_token');

    // Disconnected: Google is told, and the cards keep what they knew.
    panel = await settings(window);
    await panel.getByRole('button', { name: 'Disconnect' }).click();
    await expect(panel.getByRole('button', { name: 'Connect Google Drive…' })).toBeVisible();
    expect(google.revoked).toEqual(['rt-1']);
    await window.keyboard.press('Escape');
    await expect(cards.nth(0)).toHaveAttribute('data-state', 'notConnected');
    await expect(cards.nth(0).getByTestId('drive-file-name')).toHaveText('Gripper BOM v2');
    await expect(window.getByTestId('drive-file-problem').first()).toHaveText(
      'Connect Google Drive to see it as it is now.',
    );

    // Picking now sends you to connect first.
    await editor(window).press('Control+End');
    await window.keyboard.press('Enter');
    await window.keyboard.type('/google drive');
    await window.keyboard.press('Enter');
    await expect(window.getByTestId('connections-message')).toHaveText(
      'Connect Google Drive to link its files.',
    );
  } finally {
    if (launched) await quit(launched.app);
  }
});
