/**
 * Start at login (a setting, off by default), in the tray: Windows through the login items API,
 * Linux through an autostart entry (`~/.config/autostart`, the freedesktop way GNOME and KDE
 * read). The app is started with `--hidden`, so only the tray icon shows.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';

export const HIDDEN_FLAG = '--hidden';

const desktopFile = () =>
  join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'autostart',
    'workspace-calendar.desktop',
  );

export function setStartAtLogin(enabled: boolean) {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
    return;
  }
  const file = desktopFile();
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  // An AppImage runs from a temporary mount: start the AppImage file itself.
  const exec = process.env.APPIMAGE || process.execPath;
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(
    file,
    [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Workspace Calendar',
      `Exec="${exec.replace(/"/g, '\\"')}" ${HIDDEN_FLAG}`,
      'Icon=workspace-calendar',
      'X-GNOME-Autostart-enabled=true',
      'NoDisplay=false',
      '',
    ].join('\n'),
  );
}
