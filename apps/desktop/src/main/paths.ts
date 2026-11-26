import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR_NAME = 'workspace-app';

/**
 * Where the workspace database and files live.
 *
 * - Linux: the XDG base directory spec, `$XDG_DATA_HOME/workspace-app`, which is
 *   `~/.local/share/workspace-app` by default.
 * - Windows: `%APPDATA%\workspace-app` (the roaming profile, where Windows apps keep their data).
 *
 * `WORKSPACE_DATA_DIR` overrides it (used by tests, and handy for keeping several separate
 * workspaces).
 */
export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.WORKSPACE_DATA_DIR) return env.WORKSPACE_DATA_DIR;
  if (platform === 'win32') {
    return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), DATA_DIR_NAME);
  }
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, DATA_DIR_NAME);
}
