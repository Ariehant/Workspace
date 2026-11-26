/**
 * Where Workspace Calendar looks for updates: the project's `updates` release on GitHub, a fixed place
 * holding only the small feed files (`<channel>.yml` for Windows, `<channel>-linux.yml` for the
 * AppImage) that point at a versioned release's packages. The Release workflow writes them
 * (docs/releases/README.md).
 */
export const UPDATE_FEED = 'https://github.com/Ariehant/Workspace/releases/download/updates/';

/**
 * The feed's channel for a version: a release candidate (`1.0.0-rc.1`) follows `calendar-rc`,
 * which gets every release candidate and every release; a release follows `calendar`, which
 * gets releases only. (Workspace and the calendar share one release, so each has channels of
 * its own.)
 */
export function updateChannel(version: string): string {
  return version.includes('-') ? 'calendar-rc' : 'calendar';
}
