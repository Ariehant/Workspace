/**
 * Phase 8 N8 (#27): one Settings window. Ctrl+, opens it; each section is reachable from the
 * list on the left (by keyboard too); the menu items that used to open dialogs open it at
 * their section.
 */
import { expect, test } from './helpers';

test('settings: one window, its sections by keyboard, and the old menu items open it', async ({
  launch,
}) => {
  const { window } = await launch();
  const settingsWindow = window.getByTestId('settings-window');
  const tabs = settingsWindow.getByRole('tab');

  await window.keyboard.press('Control+,');
  await expect(settingsWindow).toBeVisible();
  // A local desktop workspace: no account, members or teamspaces.
  await expect(tabs).toHaveText([
    'Appearance',
    'Language and region',
    'Notifications',
    'Emoji',
    'Linked folders',
    'Sync',
    'Keyboard shortcuts',
    'About',
  ]);
  await expect(settingsWindow.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // The theme, at once.
  await settingsWindow.getByLabel('Dark').check();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settingsWindow.getByLabel('Light').check();
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');

  // Down and Up move through the list; the panel follows.
  await settingsWindow.getByRole('tab', { name: 'Appearance' }).focus();
  await window.keyboard.press('ArrowDown');
  await expect(settingsWindow.getByRole('tab', { name: 'Language and region' })).toBeFocused();
  await expect(window.getByTestId('region-dialog')).toBeVisible();
  await window.keyboard.press('ArrowDown');
  await expect(window.getByTestId('notification-settings')).toBeVisible();
  await expect(
    window.getByTestId('notification-settings').getByRole('checkbox', { name: 'Mentions' }),
  ).toBeChecked();
  await window.keyboard.press('End');
  await expect(window.getByTestId('about-dialog')).toBeVisible();
  await window.keyboard.press('Home');
  await expect(window.getByTestId('appearance-settings')).toBeVisible();
  await window.keyboard.press('Escape');
  await expect(settingsWindow).toBeHidden();

  // The workspace menu: Settings…, and each old item at its section.
  const menuItem = async (name: string) => {
    await window.getByRole('button', { name: /workspace menu/i }).click();
    await window.getByRole('menuitem', { name }).click();
    await expect(settingsWindow).toBeVisible();
  };
  await menuItem('Emoji…');
  await expect(settingsWindow.getByRole('tab', { name: 'Emoji' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(window.getByTestId('emoji-settings')).toBeVisible();
  await window.keyboard.press('Escape');
  await menuItem('Keyboard shortcuts');
  await expect(window.getByTestId('shortcuts-dialog')).toBeVisible();
  await window.keyboard.press('Escape');

  // The sync indicator opens Sync.
  await window.getByTestId('sync-indicator').click();
  await expect(window.getByTestId('sync-dialog')).toBeVisible();
  await expect(settingsWindow.getByRole('tab', { name: 'Sync' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});
