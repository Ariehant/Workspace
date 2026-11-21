import {
  formatDateTime,
  formatPlainNumber,
  regionChoices,
  resolveRegion,
  systemLocale,
  regionOf,
  type DateStyle,
  type HourCycle,
  type RegionSettings,
  type WeekStart,
} from '@workspace/core';
import { useMemo, type ReactNode } from 'react';
import { SettingsShell } from './settings/shell';

const select =
  'h-8 w-full rounded-md border border-line bg-transparent px-2 text-sm text-fg outline-none focus:border-accent';

/** An example moment for the preview: today at 3:05 PM. */
const sample = () => {
  const d = new Date();
  d.setHours(15, 5, 0, 0);
  return d;
};

const DATE_LABELS: Record<DateStyle, string> = {
  full: 'Full date',
  mdy: 'Month/Day/Year',
  dmy: 'Day/Month/Year',
  ymd: 'Year/Month/Day',
};

/**
 * Settings → Language and region: the app's language (English only, for now) and how dates,
 * times and numbers look. Each format follows the region unless set on its own.
 */
export function RegionDialog({
  settings,
  onChange,
  onClose,
}: {
  settings: RegionSettings;
  onChange(next: RegionSettings): void;
  onClose(): void;
}) {
  const choices = useMemo(() => regionChoices(), []);
  const system = regionOf(systemLocale());
  const systemName = choices.find((c) => c.code === system)?.name ?? system ?? 'United States';
  // What "Automatic" would be for each format, given the region chosen.
  const auto = resolveRegion({ region: settings.region });
  const effective = resolveRegion(settings);
  const set = (change: Partial<RegionSettings>) => onChange({ ...settings, ...change });
  const now = sample();

  return (
    <SettingsShell onClose={onClose} title="Language and region" data-testid="region-dialog">
      <div className="flex flex-col gap-4 p-4 pt-3">
        <Field label="Language" hint="More languages are coming; translations are welcome.">
          <select aria-label="Language" className={select} value="en" disabled>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label="Region" hint="Sets the formats below, unless you choose them yourself.">
          <select
            aria-label="Region"
            className={select}
            value={settings.region ?? ''}
            onChange={(e) => set({ region: e.target.value || null })}
          >
            <option value="">Automatic ({systemName})</option>
            {choices.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Date format">
            <select
              aria-label="Date format"
              className={select}
              value={settings.date ?? ''}
              onChange={(e) => set({ date: (e.target.value || null) as DateStyle | null })}
            >
              <option value="">Automatic</option>
              {(Object.keys(DATE_LABELS) as DateStyle[]).map((style) => (
                <option key={style} value={style}>
                  {DATE_LABELS[style]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Time">
            <select
              aria-label="Time format"
              className={select}
              value={settings.time ?? ''}
              onChange={(e) => set({ time: (e.target.value || null) as HourCycle | null })}
            >
              <option value="">Automatic ({auto.time === '12h' ? '12-hour' : '24-hour'})</option>
              <option value="12h">12-hour</option>
              <option value="24h">24-hour</option>
            </select>
          </Field>
          <Field label="Week starts on">
            <select
              aria-label="First day of the week"
              className={select}
              value={settings.weekStart ?? ''}
              onChange={(e) =>
                set({
                  weekStart: e.target.value === '' ? null : (Number(e.target.value) as WeekStart),
                })
              }
            >
              <option value="">Automatic ({auto.weekStart === 1 ? 'Monday' : 'Sunday'})</option>
              <option value="0">Sunday</option>
              <option value="1">Monday</option>
            </select>
          </Field>
        </div>
        <p className="rounded-md bg-hover px-3 py-2 text-sm" data-testid="region-preview">
          {formatDateTime(now, effective)} ·{' '}
          {formatPlainNumber(1234567.89, { grouping: true }, effective)}
        </p>
        <p className="text-xs text-muted">
          A database property with its own date or number format keeps it.
        </p>
      </div>
    </SettingsShell>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}
