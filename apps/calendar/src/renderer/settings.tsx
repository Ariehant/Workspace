/**
 * Settings: theme, the day weeks start on, a second time zone, running in the background, and
 * the Google OAuth client.
 */
import { Dialog, DialogContent } from '@workspace/ui';
import { useMemo, useState } from 'react';
import type { GoogleSetup, Settings, ThemePreference } from '../shared/ipc';
import { api, unwrap } from './api';
import { ClientForm } from './google';

/** ICU still lists some zones by old names: show (and save) the names people use today. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
};

const selectClass =
  'h-8 rounded-md border border-line bg-surface px-2 text-sm text-fg outline-none focus:border-accent';

export function SettingsDialog({
  settings,
  google,
  onClose,
  onError,
}: {
  settings: Settings;
  google: GoogleSetup | null;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [savedClient, setSavedClient] = useState(false);
  const zones = useMemo(() => {
    try {
      const names = Intl.supportedValuesOf('timeZone').map((z) => RENAMED[z] ?? z);
      return [...new Set(names)].sort();
    } catch {
      return [];
    }
  }, []);
  // Shown at once; the main process saves and applies it.
  const [current, setCurrent] = useState(settings);
  const set = (patch: Partial<Settings>) => {
    setCurrent((s) => ({ ...s, ...patch }));
    return unwrap(api.settings.set(patch)).catch((e: Error) => {
      setCurrent(settings);
      onError(e.message);
    });
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title="Settings">
        <div className="grid grid-cols-[160px_1fr] items-center gap-3 p-4">
          <label htmlFor="theme" className="text-sm text-muted">
            Theme
          </label>
          <select
            id="theme"
            className={selectClass}
            value={current.theme}
            onChange={(e) => void set({ theme: e.target.value as ThemePreference })}
          >
            <option value="system">Follow the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <label htmlFor="week-start" className="text-sm text-muted">
            Weeks start on
          </label>
          <select
            id="week-start"
            className={selectClass}
            value={current.weekStartsOn}
            onChange={(e) => void set({ weekStartsOn: Number(e.target.value) as 0 | 1 | 6 })}
          >
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
            <option value={6}>Saturday</option>
          </select>
          <label htmlFor="second-zone" className="text-sm text-muted">
            Second time zone
          </label>
          <select
            id="second-zone"
            className={selectClass}
            value={current.secondZone ?? ''}
            onChange={(e) => void set({ secondZone: e.target.value || null })}
          >
            <option value="">None</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <span className="text-sm text-muted">In the background</span>
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={current.keepInTray}
                onChange={(e) => void set({ keepInTray: e.target.checked })}
              />
              Keep running in the tray when the window is closed
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={current.startAtLogin}
                onChange={(e) => void set({ startAtLogin: e.target.checked })}
              />
              Start when I log in (in the tray)
            </label>
          </div>
          <span className="text-sm text-muted">Drawing</span>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={current.hardwareAcceleration}
              onChange={(e) => void set({ hardwareAcceleration: e.target.checked })}
            />
            Use graphics acceleration (after a restart)
          </label>
          <p className="col-span-2 text-xs text-faint">
            Off, the calendar uses less memory; on, scrolling and dragging can be smoother on very
            large screens.
          </p>
          <p className="col-span-2 text-xs text-faint">
            In the tray the calendar still syncs (every 5 minutes) and notifies you. On GNOME, the
            tray icon needs the AppIndicator extension (Ubuntu has it).
          </p>
          <p className="col-span-2 text-xs text-faint">
            Workspace dates have no time zone: an event at 10:00 shows at 10:00 wherever you are.
            Google events happen at a real moment: they show at this computer&apos;s clock time for
            it. The second column shows what the clock says in another zone at each hour.
          </p>
        </div>
        {google && (
          <section aria-label="Google Calendar" className="border-t border-line p-4">
            <h3 className="mb-2 text-sm font-semibold">Google Calendar</h3>
            {google.fromEnvironment ? (
              <p className="text-sm text-muted">This build brings its own Google OAuth client.</p>
            ) : (
              <>
                <ClientForm setup={google} onSaved={() => setSavedClient(true)} onError={onError} />
                {savedClient && (
                  <p role="status" className="mt-2 text-xs text-muted">
                    Saved.
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
