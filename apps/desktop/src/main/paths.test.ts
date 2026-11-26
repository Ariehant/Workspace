import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from './paths';

describe('resolveDataDir', () => {
  it('uses ~/.local/share on Linux, or $XDG_DATA_HOME', () => {
    expect(resolveDataDir({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'workspace-app'));
    expect(resolveDataDir({ XDG_DATA_HOME: '/data' }, 'linux')).toBe(
      join('/data', 'workspace-app'),
    );
  });

  it('uses %APPDATA% on Windows, not the XDG folders', () => {
    const appData = 'C:\\Users\\ada\\AppData\\Roaming';
    expect(resolveDataDir({ APPDATA: appData, XDG_DATA_HOME: '/data' }, 'win32')).toBe(
      join(appData, 'workspace-app'),
    );
    expect(resolveDataDir({}, 'win32')).toBe(
      join(homedir(), 'AppData', 'Roaming', 'workspace-app'),
    );
  });

  it('lets WORKSPACE_DATA_DIR override it everywhere', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(resolveDataDir({ WORKSPACE_DATA_DIR: '/tmp/ws', APPDATA: 'x' }, platform)).toBe(
        '/tmp/ws',
      );
    }
  });
});
