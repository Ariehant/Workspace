import { Button } from '@workspace/ui';
import { useEffect, useState } from 'react';
import type { AboutPlatform, UpdateInfo, UpdatesPlatform } from './platform';
import { SettingsShell } from './settings/shell';

/** The update state, kept current (null while loading, or where the host has no updates). */
export function useUpdates(updates: UpdatesPlatform | undefined): UpdateInfo | null {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    void updates.get().then((i) => live && setInfo(i));
    const off = updates.onChange(setInfo);
    return () => {
      live = false;
      off();
    };
  }, [updates]);
  return info;
}

function updateText(info: UpdateInfo): string {
  switch (info.status) {
    case 'checking':
      return 'Looking for updates…';
    case 'none':
      return 'Workspace is up to date.';
    case 'downloading':
      return `Downloading ${info.version}${info.progress !== null ? ` (${info.progress}%)` : ''}…`;
    case 'ready':
      return `Version ${info.version} is ready. Restart to use it.`;
    case 'error':
      return `Couldn’t check for updates: ${info.error ?? 'unknown error'}`;
    default:
      return info.auto ? 'Updates download by themselves.' : 'Automatic updates are off.';
  }
}

/** The project's source code (a server can name its own: see `sourceUrl`). */
export const SOURCE_URL = 'https://github.com/ariehant/workspace';

/** Workspace menu → About Workspace: the versions, and updates where the app updates itself. */
export function AboutDialog({ about, onClose }: { about: AboutPlatform; onClose(): void }) {
  const [version, setVersion] = useState<string | null>(null);
  const [server, setServer] = useState<string | null>(null);
  const [source, setSource] = useState(SOURCE_URL);
  const updates = useUpdates(about.updates);
  useEffect(() => {
    void about.appVersion().then(setVersion);
    void about.serverVersion?.().then(setServer, () => setServer(null));
    void about.sourceUrl?.().then(
      (url) => url && setSource(url),
      () => {},
    );
  }, [about]);

  return (
    <SettingsShell onClose={onClose} title="About Workspace" data-testid="about-dialog">
      <div className="flex flex-col gap-3 p-4 pt-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Version</dt>
          <dd data-testid="app-version">{version ?? '…'}</dd>
          {server && (
            <>
              <dt className="text-muted">Server</dt>
              <dd data-testid="server-version">{server}</dd>
            </>
          )}
        </dl>
        <p className="text-muted" data-testid="license">
          Free software under the{' '}
          <a
            href="https://www.gnu.org/licenses/agpl-3.0.html"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            GNU Affero General Public License 3.0
          </a>{' '}
          or later.{' '}
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
            data-testid="source-link"
          >
            Source code
          </a>
        </p>
        {updates && !updates.supported && (
          <p className="text-muted">
            This copy updates with your system: apt for the .deb, the Snap Store or Flathub.
          </p>
        )}
        {updates?.supported && (
          <div className="flex flex-col gap-2 border-t border-line pt-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={updates.auto}
                onChange={(e) => about.updates!.setAuto(e.target.checked)}
              />
              Download updates automatically
            </label>
            <p role="status" className="text-muted" data-testid="update-status">
              {updateText(updates)}
            </p>
            <div>
              {updates.status === 'ready' ? (
                <Button variant="primary" onClick={() => about.updates!.install()}>
                  Restart to update
                </Button>
              ) : (
                <Button
                  disabled={updates.status === 'checking' || updates.status === 'downloading'}
                  onClick={() => about.updates!.check()}
                >
                  Check for updates
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}
