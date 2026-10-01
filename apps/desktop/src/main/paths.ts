import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR_NAME = 'workspace-app';

/**
 * Where the workspace database and files live.
 *
 * Follows the XDG base directory spec: `$XDG_DATA_HOME/workspace-app`, which is
 * `~/.local/share/workspace-app` by default. `WORKSPACE_DATA_DIR` overrides it
 * (used by tests, and handy for keeping several separate workspaces).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKSPACE_DATA_DIR) return env.WORKSPACE_DATA_DIR;
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataHome, DATA_DIR_NAME);
}
