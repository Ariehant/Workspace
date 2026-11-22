/** The window: sidebar, toolbar and the week grid. Everything shown comes from the cache. */
import {
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
  useAppliedTheme,
} from '@workspace/ui';
import { CalendarDays, ChevronLeft, ChevronRight, Settings2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { addDays, nowWall, startOfWeek, today as todayOf } from '../shared/dates';
import { DEFAULT_SETTINGS, type AppState, type ThemePreference } from '../shared/ipc';
import type { CalEvent, Calendar } from '../shared/types';
import { api, unwrap } from './api';
import { ConnectDialog } from './connect';
import { formatRange } from './format';
import { daysFrom } from './layout';
import { Sidebar } from './sidebar';
import { WeekView } from './week';

/** The wall clock, updated every half minute (for "today" and the now line). */
function useNow(): string {
  const [now, setNow] = useState(() => nowWall());
  useEffect(() => {
    const timer = setInterval(() => setNow(nowWall()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [anchor, setAnchor] = useState(() => todayOf());
  const [connecting, setConnecting] = useState<{ accountId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const today = now.slice(0, 10);
  const settings = state?.settings ?? DEFAULT_SETTINGS;
  useAppliedTheme(settings.theme);

  const first = startOfWeek(anchor, settings.weekStartsOn);
  const days = useMemo(() => daysFrom(first, 7), [first]);
  const last = days[days.length - 1]!;

  // Load what's shown, and again whenever the main process says something changed.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([unwrap(api.state()), unwrap(api.events(first, last))]).then(
        ([s, e]) => {
          if (cancelled) return;
          setState(s);
          setEvents(e);
        },
        (e: Error) => !cancelled && setError(e.message),
      );
    void load();
    const off = api.onChanged(() => void load());
    return () => {
      cancelled = true;
      off();
    };
  }, [first, last]);

  const calendars = useMemo(
    () => new Map<string, Calendar>((state?.calendars ?? []).map((c) => [c.id, c])),
    [state?.calendars],
  );

  const move = useCallback((weeks: number) => setAnchor((a) => addDays(a, weeks * 7)), []);

  // Single-key shortcuts (more come with editing): t today, j/k or arrows to move.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (event.key === 't') setAnchor(todayOf());
      else if (event.key === 'j' || event.key === 'ArrowRight') move(1);
      else if (event.key === 'k' || event.key === 'ArrowLeft') move(-1);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  if (!state) return null;
  const empty = state.accounts.length === 0;

  return (
    <div className="flex h-full">
      <Sidebar
        state={state}
        anchor={anchor}
        shown={days}
        today={today}
        onPickDay={setAnchor}
        onAddCalendars={(accountId) => setConnecting({ accountId: accountId ?? null })}
        onError={setError}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Button
            onClick={() => setAnchor(todayOf())}
            className="border border-line"
            title="Today (T)"
          >
            Today
          </Button>
          <IconButton label="Previous week" onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton label="Next week" onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {formatRange(first, last)}
          </h1>
          <Menu>
            <MenuTrigger asChild>
              <IconButton label="Settings">
                <Settings2 className="size-4" />
              </IconButton>
            </MenuTrigger>
            <MenuContent align="end">
              <div className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted">Theme</div>
              <MenuRadioGroup
                value={settings.theme}
                onValueChange={(theme) =>
                  void unwrap(api.settings.set({ theme: theme as ThemePreference }))
                }
              >
                <MenuRadioItem value="system">Follow the system</MenuRadioItem>
                <MenuRadioItem value="light">Light</MenuRadioItem>
                <MenuRadioItem value="dark">Dark</MenuRadioItem>
              </MenuRadioGroup>
              <div className="px-2 pt-2 pb-0.5 text-xs font-medium text-muted">Weeks start on</div>
              <MenuRadioGroup
                value={String(settings.weekStartsOn)}
                onValueChange={(v) =>
                  void unwrap(api.settings.set({ weekStartsOn: Number(v) as 0 | 1 | 6 }))
                }
              >
                <MenuRadioItem value="1">Monday</MenuRadioItem>
                <MenuRadioItem value="0">Sunday</MenuRadioItem>
                <MenuRadioItem value="6">Saturday</MenuRadioItem>
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        </header>
        {error && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-line bg-hover px-3 py-1.5 text-sm text-danger"
          >
            <span className="flex-1">{error}</span>
            <IconButton label="Dismiss" size="sm" onClick={() => setError(null)}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}
        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <CalendarDays className="size-10 text-faint" aria-hidden />
            <h2 className="text-lg font-semibold">Your Workspace dates, on a calendar</h2>
            <p className="max-w-md text-sm text-muted">
              Connect a Workspace server to see tasks, meetings and deadlines from its databases
              here.
            </p>
            <Button variant="primary" onClick={() => setConnecting({ accountId: null })}>
              Connect Workspace
            </Button>
          </div>
        ) : (
          <WeekView days={days} events={events} calendars={calendars} now={now} />
        )}
      </main>
      {connecting && (
        <ConnectDialog accountId={connecting.accountId} onClose={() => setConnecting(null)} />
      )}
    </div>
  );
}
