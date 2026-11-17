import { readFileSync } from 'node:fs';
import { expect, test } from './helpers';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

test('About Workspace shows the version; this build updates with the system', async ({
  launch,
}) => {
  const { app, window } = await launch();
  await window.getByRole('button', { name: /workspace menu/i }).click();
  await window.getByRole('menuitem', { name: 'About Workspace' }).click();
  const dialog = window.getByTestId('about-dialog');
  await expect(dialog.getByTestId('app-version')).toHaveText(version);
  expect(await app.evaluate(({ app }) => app.getVersion())).toBe(version);
  // Not an AppImage (the tests run the unpacked app): no update controls, and why.
  await expect(dialog).toContainText('updates with your system');
  await expect(dialog.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
  await window.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // No update downloaded, so no restart button.
  await expect(window.getByTestId('update-ready')).toHaveCount(0);
});
