/** The sidebar: a mini month, the calendars by account, and the sync status. */
import {
  cn,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from '@workspace/ui';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import { useState } from 'react';
import { addDays, addMonths, startOfMonth, startOfWeek } from '../shared/dates';
import type { AppState } from '../shared/ipc';
import { COLOURS, type Calendar } from '../shared/types';
import { api, colourVar, unwrap } from './api';
import {
  dayNumber,
  formatFullDay,
  formatMonthYear,
  formatTime,
  formatWeekdayNarrow,
} from './format';

interface Props {
  state: AppState;
  /** The day the view is on, and the days it shows. */
  anchor: string;
  shown: string[];
  today: string;
  onPickDay: (day: string) => void;
  onAddCalendars: (accountId?: string) => void;
  onError: (message: string) => void;
}

export function Sidebar({
  state,
  anchor,
  shown,
  today,
  onPickDay,
  onAddCalendars,
  onError,
}: Props) {
  return (
    <nav
      aria-label="Sidebar"
      className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-sidebar p-3"
    >
      <MiniMonth
        anchor={anchor}
        shown={shown}
        today={today}
        weekStartsOn={state.settings.weekStartsOn}
        onPick={onPickDay}
      />
      <div className="flex flex-col gap-3">
        {state.accounts.map((account) => (
          <section key={account.id} aria-label={account.name}>
            <div className="group flex items-center gap-1 px-1 py-0.5">
              <h2
                className="min-w-0 flex-1 truncate text-xs font-semibold text-muted"
                title={account.server}
              >
                {account.name}
              </h2>
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label={`${account.name} options`} size="sm">
                    <MoreHorizontal className="size-3.5" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    onSelect={() => onAddCalendars(account.id)}
                    icon={<Plus className="size-4" />}
                  >
                    Add databases
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onSelect={() =>
                      unwrap(api.accounts.remove(account.id)).catch((e: Error) =>
                        onError(e.message),
                      )
                    }
                  >
                    Remove account
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
            {account.error && (
              <p
                role="alert"
                className="mx-1 mb-1 flex gap-1.5 rounded bg-hover p-2 text-xs text-danger"
              >
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {account.error}
              </p>
            )}
            <ul className="flex flex-col">
              {state.calendars
                .filter((c) => c.accountId === account.id)
                .map((calendar) => (
                  <CalendarRow key={calendar.id} calendar={calendar} onError={onError} />
                ))}
            </ul>
          </section>
        ))}
        <button
          type="button"
          onClick={() => onAddCalendars()}
          className="flex items-center gap-2 rounded px-1 py-1 text-left text-sm text-muted hover:bg-hover hover:text-fg"
        >
          <Plus className="size-4" aria-hidden />
          {state.accounts.length ? 'Connect another Workspace' : 'Connect Workspace'}
        </button>
      </div>
      <div className="mt-auto flex flex-col gap-2">
        {!state.secureStorage && state.accounts.length > 0 && (
          <p className="rounded bg-hover p-2 text-xs text-warning">
            This system has no keyring, so tokens are saved unencrypted on this computer.
          </p>
        )}
        <SyncStatus state={state} />
      </div>
    </nav>
  );
}

function CalendarRow({ calendar, onError }: { calendar: Calendar; onError: (m: string) => void }) {
  const update = (patch: Parameters<typeof api.calendars.update>[1]) =>
    unwrap(api.calendars.update(calendar.id, patch)).catch((e: Error) => onError(e.message));
  return (
    <li className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-hover">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm">
        <span className="relative inline-flex size-4 shrink-0 items-center justify-center">
          <input
            type="checkbox"
            checked={calendar.visible}
            onChange={(e) => update({ visible: e.target.checked })}
            className="peer absolute inset-0 cursor-pointer opacity-0"
          />
          <span
            style={colourVar(calendar.colour)}
            className={cn(
              'flex size-4 items-center justify-center rounded border-2 peer-focus-visible:outline-2 peer-focus-visible:outline-accent',
              calendar.visible ? 'cal-swatch border-transparent' : 'border-[var(--cal-colour)]',
            )}
            aria-hidden
          >
            {calendar.visible && <Check className="size-3 text-white" strokeWidth={3} />}
          </span>
        </span>
        <span className="truncate">{calendar.name}</span>
      </label>
      {calendar.status !== 'ok' && (
        <span
          title={calendar.statusMessage ?? ''}
          className="text-warning"
          role="img"
          aria-label={calendar.statusMessage ?? 'Needs attention'}
        >
          <AlertTriangle className="size-3.5" />
        </span>
      )}
      <Menu>
        <MenuTrigger asChild>
          <IconButton
            label={`${calendar.name} options`}
            size="sm"
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </IconButton>
        </MenuTrigger>
        <MenuContent align="end">
          <div className="grid grid-cols-5 gap-1 p-2" role="group" aria-label="Colour">
            {COLOURS.map((colour) => (
              <MenuItem
                key={colour}
                onSelect={() => update({ colour })}
                aria-label={colour}
                className="justify-center p-1"
              >
                <span
                  style={colourVar(colour)}
                  className={cn(
                    'cal-swatch size-4 rounded-full',
                    calendar.colour === colour && 'ring-2 ring-fg ring-offset-1',
                  )}
                />
              </MenuItem>
            ))}
          </div>
          {calendar.statusMessage && (
            <p className="max-w-64 px-2 pb-2 text-xs text-muted">{calendar.statusMessage}</p>
          )}
          <MenuSeparator />
          <MenuItem
            danger
            onSelect={() =>
              unwrap(api.calendars.remove(calendar.id)).catch((e: Error) => onError(e.message))
            }
          >
            Remove calendar
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  );
}

function SyncStatus({ state }: { state: AppState }) {
  const { status } = state;
  if (state.accounts.length === 0) return null;
  const last = status.lastSync ? new Date(status.lastSync) : null;
  const label = !status.online
    ? 'Offline: showing saved events'
    : status.syncing
      ? 'Syncing…'
      : status.error
        ? `Sync failed: ${status.error}`
        : last
          ? `Synced at ${formatTime(last.getHours() * 60 + last.getMinutes())}`
          : 'Not synced yet';
  return (
    <div className="flex items-center gap-1 px-1 text-xs text-muted" role="status">
      {!status.online && <WifiOff className="size-3.5 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {label}
      </span>
      <IconButton label="Sync now" size="sm" onClick={() => void api.syncNow()}>
        <RefreshCw className={cn('size-3.5', status.syncing && 'animate-spin')} />
      </IconButton>
    </div>
  );
}

/** A month of days to jump to; the days shown are marked. */
function MiniMonth({
  anchor,
  shown,
  today,
  weekStartsOn,
  onPick,
}: {
  anchor: string;
  shown: string[];
  today: string;
  weekStartsOn: number;
  onPick: (day: string) => void;
}) {
  const [month, setMonth] = useState(() => startOfMonth(anchor));
  const [lastAnchor, setLastAnchor] = useState(anchor);
  if (anchor !== lastAnchor) {
    // Follow the main view when it moves to another month.
    setLastAnchor(anchor);
    if (startOfMonth(anchor) !== month) setMonth(startOfMonth(anchor));
  }
  const first = startOfWeek(month, weekStartsOn);
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const shownSet = new Set(shown);
  return (
    <div aria-label="Mini calendar" role="group">
      <div className="mb-1 flex items-center gap-1 px-1">
        <div className="flex-1 text-sm font-semibold">{formatMonthYear(month)}</div>
        <IconButton label="Previous month" size="sm" onClick={() => setMonth(addMonths(month, -1))}>
          <ChevronLeft className="size-4" />
        </IconButton>
        <IconButton label="Next month" size="sm" onClick={() => setMonth(addMonths(month, 1))}>
          <ChevronRight className="size-4" />
        </IconButton>
      </div>
      <div className="grid grid-cols-7 text-center text-[11px] text-faint">
        {days.slice(0, 7).map((d) => (
          <div key={d} aria-hidden>
            {formatWeekdayNarrow(d)}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center text-xs">
        {days.map((day) => (
          <button
            type="button"
            key={day}
            onClick={() => onPick(day)}
            aria-label={formatFullDay(day)}
            aria-current={day === today ? 'date' : undefined}
            className={cn(
              'm-px flex h-7 items-center justify-center rounded',
              shownSet.has(day) && 'bg-active',
              day.slice(0, 7) !== month.slice(0, 7) && 'text-faint',
              day === today ? 'font-semibold text-accent' : 'hover:bg-hover',
            )}
          >
            {dayNumber(day)}
          </button>
        ))}
      </div>
    </div>
  );
}
