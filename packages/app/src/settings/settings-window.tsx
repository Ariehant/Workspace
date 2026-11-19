/**
 * One Settings window (Phase 8 N8, #27): every setting in one place, a section each,
 * listed on the left. The menu items and buttons that used to open each dialog open it at
 * their section.
 */
import { NOTIFICATION_KINDS, formatZoom, stepZoom, type NotificationKind } from '@workspace/core';
import { Button, Dialog, DialogContent, cn, type ThemePreference } from '@workspace/ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { KIND_LABELS } from '../inbox';
import type { NotificationsPlatform, ZoomPlatform } from '../platform';
import { useZoomFactor } from '../sidebar';

import { SettingsEmbedded, SettingsShell } from './shell';

export type SettingsSection =
  | 'account'
  | 'appearance'
  | 'region'
  | 'notifications'
  | 'emoji'
  | 'linkedFolders'
  | 'connections'
  | 'members'
  | 'teamspaces'
  | 'sync'
  | 'shortcuts'
  | 'about';

export interface SettingsPanel {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  content: ReactNode;
}

export function SettingsWindow({
  panels,
  section,
  onSection,
  onClose,
}: {
  /** The sections this host and workspace have, in order. */
  panels: SettingsPanel[];
  section: SettingsSection;
  onSection(section: SettingsSection): void;
  onClose(): void;
}) {
  const current = panels.find((p) => p.id === section) ?? panels[0]!;
  const tabs = useRef<HTMLDivElement>(null);
  // Up and down move between sections, as in a vertical tab list.
  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = panels.findIndex((p) => p.id === current.id);
    const to =
      event.key === 'ArrowDown'
        ? (at + 1) % panels.length
        : event.key === 'ArrowUp'
          ? (at - 1 + panels.length) % panels.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? panels.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    onSection(panels[to]!.id);
    tabs.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        title="Settings"
        hideTitle
        data-testid="settings-window"
        className="top-[6vh] flex h-[min(720px,88vh)] w-[min(960px,calc(100vw-32px))] overflow-hidden p-0"
      >
        <nav
          aria-label="Settings"
          className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-sidebar p-2"
        >
          <h2 className="px-2 pt-2 pb-1 text-xs font-medium text-muted">Settings</h2>
          <div
            ref={tabs}
            role="tablist"
            aria-orientation="vertical"
            aria-label="Settings sections"
            onKeyDown={onKeyDown}
            className="flex flex-col gap-0.5"
          >
            {panels.map((p) => (
              <button
                key={p.id}
                type="button"
                role="tab"
                id={`settings-tab-${p.id}`}
                aria-selected={p.id === current.id}
                aria-controls="settings-panel"
                tabIndex={p.id === current.id ? 0 : -1}
                onClick={() => onSection(p.id)}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2 text-left text-sm text-muted hover:bg-hover',
                  p.id === current.id && 'bg-active text-fg',
                )}
              >
                {p.icon}
                {p.label}
              </button>
            ))}
          </div>
        </nav>
        <div
          id="settings-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${current.id}`}
          className="min-w-0 flex-1 overflow-y-auto pb-4"
        >
          <SettingsEmbedded.Provider value>{current.content}</SettingsEmbedded.Provider>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const THEMES: [ThemePreference, string][] = [
  ['system', 'Use system setting'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

/** Settings → Appearance: the theme, and the zoom (desktop). */
export function AppearancePanel({
  theme,
  onTheme,
  zoom,
}: {
  theme: ThemePreference;
  onTheme(theme: ThemePreference): void;
  zoom?: ZoomPlatform;
}) {
  const factor = useZoomFactor(zoom);
  return (
    <SettingsShell title="Appearance" onClose={() => {}} data-testid="appearance-settings">
      <div className="flex flex-col gap-5 p-4 pt-3 text-sm">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium text-muted">Theme</legend>
          {THEMES.map(([value, label]) => (
            <label key={value} className="flex items-center gap-2">
              <input
                type="radio"
                name="theme"
                value={value}
                checked={theme === value}
                onChange={() => onTheme(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {zoom && factor !== null && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted" id="zoom-label">
              Zoom (every window)
            </span>
            <div className="flex items-center gap-2" role="group" aria-labelledby="zoom-label">
              <Button
                variant="ghost"
                className="border border-line"
                onClick={() => zoom.set(stepZoom(factor, 'out'))}
              >
                Zoom out
              </Button>
              <span className="w-14 text-center tabular-nums" data-testid="zoom-level">
                {formatZoom(factor)}
              </span>
              <Button
                variant="ghost"
                className="border border-line"
                onClick={() => zoom.set(stepZoom(factor, 'in'))}
              >
                Zoom in
              </Button>
              <Button variant="ghost" disabled={factor === 1} onClick={() => zoom.set(1)}>
                Actual size
              </Button>
            </div>
          </div>
        )}
      </div>
    </SettingsShell>
  );
}

/** Settings → Notifications: which kinds show as system notifications (desktop), and email. */
export function NotificationsPanel({
  notifications,
  email,
}: {
  notifications?: NotificationsPlatform;
  /** The email digest setting (a server workspace). */
  email?: ReactNode;
}) {
  const kinds = notifications?.systemKinds;
  const [value, setValue] = useState<Partial<Record<NotificationKind, boolean>> | null>(null);
  useEffect(() => {
    kinds?.get().then(setValue, () => setValue({}));
  }, [kinds]);
  return (
    <SettingsShell title="Notifications" onClose={() => {}} data-testid="notification-settings">
      <div className="flex flex-col gap-5 p-4 pt-3 text-sm">
        {kinds && value && (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium text-muted">Desktop notifications</legend>
            {NOTIFICATION_KINDS.map((kind) => (
              <label key={kind} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={value[kind] !== false}
                  onChange={() => {
                    const next = { ...value, [kind]: value[kind] === false };
                    setValue(next);
                    kinds.set(next);
                  }}
                />
                {KIND_LABELS[kind]}
              </label>
            ))}
          </fieldset>
        )}
        {email}
        {!kinds && !email && (
          <p className="text-muted">
            Mentions, replies and reminders arrive in your inbox, in the sidebar.
          </p>
        )}
      </div>
    </SettingsShell>
  );
}
