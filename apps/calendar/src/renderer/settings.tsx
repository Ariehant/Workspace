/** Settings: theme, the day weeks start on, and a second time zone. */
import { Dialog, DialogContent } from '@workspace/ui';
import { useMemo } from 'react';
import type { Settings, ThemePreference } from '../shared/ipc';
import { api, unwrap } from './api';

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
  onClose,
  onError,
}: {
  settings: Settings;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const zones = useMemo(() => {
    try {
      const names = Intl.supportedValuesOf('timeZone').map((z) => RENAMED[z] ?? z);
      return [...new Set(names)].sort();
    } catch {
      return [];
    }
  }, []);
  const set = (patch: Partial<Settings>) =>
    unwrap(api.settings.set(patch)).catch((e: Error) => onError(e.message));

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
            value={settings.theme}
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
            value={settings.weekStartsOn}
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
            value={settings.secondZone ?? ''}
            onChange={(e) => void set({ secondZone: e.target.value || null })}
          >
            <option value="">None</option>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
          <p className="col-span-2 text-xs text-faint">
            Workspace dates have no time zone: an event at 10:00 shows at 10:00 wherever you are.
            The second column shows what the clock says in another zone at each hour.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
