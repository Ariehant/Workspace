/** The window: sidebar, toolbar, the view, and the event panel. Everything shown comes from the cache. */
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
import {
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Command as CommandIcon,
  Settings2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  atMinutes,
  dayOf,
  minutesOf,
  nowWall,
  startOfMonth,
  startOfWeek,
  today as todayOf,
  type EventTime,
} from '../shared/dates';
import { DEFAULT_SETTINGS, type AppState } from '../shared/ipc';
import type { CalEvent, Calendar } from '../shared/types';
import { api, unwrap } from './api';
import { CommandBar, ShortcutsSheet, type Command } from './command';
import { ConnectDialog } from './connect';
import { GoogleDialog } from './google';
import { NEW_EVENT_MINUTES } from './edits';
import { formatFullDay, formatMonthYear, formatRange } from './format';
import { daysFrom } from './layout';
import { AgendaView, MonthView } from './month';
import { EventPanel } from './panel';
import { SettingsDialog } from './settings';
import { Sidebar } from './sidebar';
import { editable, titleOf, WeekView, type Draft } from './week';

type View =
  | { kind: 'day' }
  | { kind: 'week' }
  | { kind: 'days'; count: number }
  | { kind: 'month' }
  | { kind: 'agenda' };

const AGENDA_DAYS = 30;
const UNDO_MS = 5_000;

/** The days a view shows around `anchor`. */
function range(view: View, anchor: string, weekStartsOn: number) {
  switch (view.kind) {
    case 'day':
      return { first: anchor, count: 1 };
    case 'days':
      return { first: anchor, count: view.count };
    case 'week':
      return { first: startOfWeek(anchor, weekStartsOn), count: 7 };
    case 'month':
      return { first: startOfWeek(startOfMonth(anchor), weekStartsOn), count: 42 };
    case 'agenda':
      return { first: anchor, count: AGENDA_DAYS };
  }
}

const viewLabel = (view: View) =>
  view.kind === 'days'
    ? `${view.count} days`
    : { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' }[view.kind];

const viewKey = (view: View) => (view.kind === 'days' ? `days-${view.count}` : view.kind);

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

type Selection =
  | { kind: 'event'; event: CalEvent; fromNotification?: boolean }
  | { kind: 'draft'; draft: Draft }
  | null;

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [view, setView] = useState<View>({ kind: 'week' });
  const [anchor, setAnchor] = useState(() => todayOf());
  const [selection, setSelection] = useState<Selection>(null);
  const [connecting, setConnecting] = useState<{
    kind: 'workspace' | 'google';
    accountId: string | null;
  } | null>(null);
  const [dialog, setDialog] = useState<'command' | 'shortcuts' | 'settings' | null>(null);
  const [toast, setToast] = useState<{ eventId: string; title: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastCalendar = useRef<string | null>(null);
  const now = useNow();
  const today = dayOf(now);
  const settings = state?.settings ?? DEFAULT_SETTINGS;
  useAppliedTheme(settings.theme);

  const { first, count } = range(view, anchor, settings.weekStartsOn);
  const days = useMemo(() => daysFrom(first, count), [first, count]);
  const last = days[days.length - 1]!;

  // Load what's shown, and again whenever the main process says something changed.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([unwrap(api.state()), unwrap(api.events.range(first, last))]).then(
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

  // The open event, as it is now (it changes as edits are saved and syncs come in).
  const openEvent =
    selection?.kind === 'event'
      ? (events.find((e) => e.id === selection.event.id) ?? selection.event)
      : null;

  const report = useCallback((e: unknown) => setError((e as Error).message), []);

  // A notification or the tray asked for an event: go to its day and open it.
  useEffect(
    () =>
      api.onShowEvent(({ eventId, fromNotification }) => {
        unwrap(api.events.get(eventId)).then((event) => {
          if (!event) return;
          setAnchor(dayOf(event.start));
          setSelection({ kind: 'event', event, fromNotification });
        }, report);
      }),
    [report],
  );

  const move = useCallback(
    (step: number) =>
      setAnchor((a) => {
        switch (view.kind) {
          case 'day':
            return addDays(a, step);
          case 'days':
            return addDays(a, step * view.count);
          case 'week':
            return addDays(a, step * 7);
          case 'month':
            return addMonths(startOfMonth(a), step);
          case 'agenda':
            return addDays(a, step * 7);
        }
      }),
    [view],
  );

  const goTo = useCallback((day: string) => setAnchor(day), []);

  /** A calendar for new events: the last one used, else the first that can be edited. */
  const defaultCalendar = useCallback(() => {
    const list = (state?.calendars ?? []).filter((c) => editable(c));
    return (
      list.find((c) => c.id === lastCalendar.current && c.visible) ??
      list.find((c) => c.visible) ??
      list[0] ??
      null
    );
  }, [state?.calendars]);

  const startDraft = useCallback(
    (time: EventTime) => {
      const calendar = defaultCalendar();
      if (!calendar) return setError('Connect a Workspace database to add events to.');
      setSelection({ kind: 'draft', draft: { time, calendarId: calendar.id, title: '' } });
    },
    [defaultCalendar],
  );

  /** `c`: a new hour-long event at the next full hour (today, or 9:00 on the day shown). */
  const createAtNextHour = useCallback(() => {
    const day = days.includes(today) ? today : days[0]!;
    const hour = day === today ? Math.min(23, Math.floor(minutesOf(now) / 60) + 1) : 9;
    startDraft({
      allDay: false,
      start: atMinutes(day, hour * 60),
      end: atMinutes(day, Math.min(24 * 60 - 15, hour * 60 + NEW_EVENT_MINUTES)),
      endSet: true,
    });
  }, [days, today, now, startDraft]);

  const saveDraft = useCallback(
    (draft: Draft) => {
      lastCalendar.current = draft.calendarId;
      setSelection(null);
      unwrap(api.events.create(draft.calendarId, draft.title.trim(), draft.time)).catch(report);
    },
    [report],
  );

  const changeEvent = useCallback(
    (event: CalEvent, change: { title?: string; time?: EventTime }) => {
      // Shown at once (the main process sends a change notice too).
      setEvents((list) =>
        list.map((e) =>
          e.id === event.id
            ? {
                ...e,
                ...(change.time ?? {}),
                ...(change.title !== undefined && { title: change.title }),
                pending: true,
              }
            : e,
        ),
      );
      unwrap(api.events.update(event.id, change)).catch(report);
    },
    [report],
  );

  const deleteEvent = useCallback(
    (event: CalEvent) => {
      setSelection((s) => (s?.kind === 'event' && s.event.id === event.id ? null : s));
      setEvents((list) => list.filter((e) => e.id !== event.id));
      setToast({ eventId: event.id, title: titleOf(event) });
      unwrap(api.events.remove(event.id)).catch(report);
    },
    [report],
  );

  const undoDelete = useCallback(() => {
    if (!toast) return;
    setToast(null);
    unwrap(api.events.undoRemove(toast.eventId)).then((back) => {
      if (!back) setError('Too late to undo: the event was already deleted in Workspace.');
    }, report);
  }, [toast, report]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  const commands = useMemo<Command[]>(
    () => [
      { id: 'today', label: 'Today', shortcut: 'T', run: () => setAnchor(todayOf()) },
      { id: 'day', label: 'Day view', shortcut: 'D', run: () => setView({ kind: 'day' }) },
      { id: 'week', label: 'Week view', shortcut: 'W', run: () => setView({ kind: 'week' }) },
      { id: 'month', label: 'Month view', shortcut: 'M', run: () => setView({ kind: 'month' }) },
      { id: 'agenda', label: 'Agenda', shortcut: 'A', run: () => setView({ kind: 'agenda' }) },
      ...[2, 3, 4, 5, 6].map((n) => ({
        id: `days-${n}`,
        label: `${n} days view`,
        shortcut: String(n),
        run: () => setView({ kind: 'days', count: n }),
      })),
      { id: 'next', label: 'Next period', shortcut: 'J', run: () => move(1) },
      { id: 'previous', label: 'Previous period', shortcut: 'K', run: () => move(-1) },
      { id: 'create', label: 'Create event', shortcut: 'C', run: createAtNextHour },
      { id: 'sync', label: 'Sync now', run: () => void api.syncNow() },
      { id: 'settings', label: 'Settings', run: () => setDialog('settings') },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        shortcut: '?',
        run: () => setDialog('shortcuts'),
      },
      {
        id: 'connect',
        label: 'Connect Workspace',
        run: () => setConnecting({ kind: 'workspace', accountId: null }),
      },
      {
        id: 'connect-google',
        label: 'Connect Google Calendar',
        run: () => setConnecting({ kind: 'google', accountId: null }),
      },
    ],
    [move, createAtNextHour],
  );

  // Keyboard (HANDOFF.md 1): Ctrl+K, single keys, Delete, Ctrl+Z, Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDialog((d) => (d === 'command' ? null : 'command'));
        return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      if (mod && event.key.toLowerCase() === 'z' && toast && !isTyping(event.target)) {
        event.preventDefault();
        undoDelete();
        return;
      }
      if (mod || event.altKey || isTyping(event.target)) return;
      if (event.key === 'Escape') {
        if (selection) setSelection(null);
        return;
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        const focused = (event.target as HTMLElement | null)?.closest?.('[data-event-id]');
        const id = focused?.getAttribute('data-event-id') ?? openEvent?.id;
        const target =
          events.find((e) => e.id === id) ?? (openEvent && openEvent.id === id ? openEvent : null);
        if (target && editable(calendars.get(target.calendarId))) {
          event.preventDefault();
          deleteEvent(target);
        }
        return;
      }
      const number = Number(event.key);
      if (number >= 1 && number <= 7) {
        setView(
          number === 1
            ? { kind: 'day' }
            : number === 7
              ? { kind: 'week' }
              : { kind: 'days', count: number },
        );
      } else if (event.key === 't') setAnchor(todayOf());
      else if (event.key === 'd') setView({ kind: 'day' });
      else if (event.key === 'w') setView({ kind: 'week' });
      else if (event.key === 'm') setView({ kind: 'month' });
      else if (event.key === 'a') setView({ kind: 'agenda' });
      else if (event.key === 'j' || event.key === 'ArrowRight') move(1);
      else if (event.key === 'k' || event.key === 'ArrowLeft') move(-1);
      else if (event.key === 'c') createAtNextHour();
      else if (event.key === '?') setDialog('shortcuts');
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    move,
    createAtNextHour,
    selection,
    openEvent,
    events,
    calendars,
    deleteEvent,
    toast,
    undoDelete,
  ]);

  if (!state) return null;
  const empty = state.accounts.length === 0;
  const title =
    view.kind === 'month'
      ? formatMonthYear(anchor)
      : view.kind === 'day'
        ? formatFullDay(anchor)
        : formatRange(first, last);

  const open = (event: CalEvent) => setSelection({ kind: 'event', event });
  const pickDay = (day: string) => {
    setAnchor(day);
    setView({ kind: 'day' });
  };

  return (
    <div className="flex h-full">
      <Sidebar
        state={state}
        anchor={anchor}
        shown={view.kind === 'month' || view.kind === 'agenda' ? [] : days}
        today={today}
        onPickDay={goTo}
        onAddCalendars={(accountId, kind) =>
          setConnecting({ kind: kind ?? 'workspace', accountId: accountId ?? null })
        }
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
          <IconButton label="Previous" onClick={() => move(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <IconButton label="Next" onClick={() => move(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">{title}</h1>
          <Menu>
            <MenuTrigger asChild>
              <Button className="border border-line" aria-label={`View: ${viewLabel(view)}`}>
                {viewLabel(view)}
                <ChevronDown className="size-3.5" aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuRadioGroup
                value={viewKey(view)}
                onValueChange={(v) =>
                  setView(
                    v.startsWith('days-')
                      ? { kind: 'days', count: Number(v.slice(5)) }
                      : ({ kind: v } as View),
                  )
                }
              >
                <MenuRadioItem value="day">Day</MenuRadioItem>
                <MenuRadioItem value="week">Week</MenuRadioItem>
                <MenuRadioItem value="month">Month</MenuRadioItem>
                <MenuRadioItem value="agenda">Agenda</MenuRadioItem>
                {[2, 3, 4, 5, 6].map((n) => (
                  <MenuRadioItem key={n} value={`days-${n}`}>
                    {n} days
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
          <IconButton label="Command bar (Ctrl+K)" onClick={() => setDialog('command')}>
            <CommandIcon className="size-4" />
          </IconButton>
          <IconButton label="Settings" onClick={() => setDialog('settings')}>
            <Settings2 className="size-4" />
          </IconButton>
        </header>
        {(error || state.status.editError) && (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-line bg-hover px-3 py-1.5 text-sm text-danger"
          >
            <span className="flex-1">{error ?? state.status.editError}</span>
            {error && (
              <IconButton label="Dismiss" size="sm" onClick={() => setError(null)}>
                <X className="size-3.5" />
              </IconButton>
            )}
          </div>
        )}
        <div className="flex min-h-0 flex-1">
          {empty ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <CalendarDays className="size-10 text-faint" aria-hidden />
              <h2 className="text-lg font-semibold">Your Workspace dates, on a calendar</h2>
              <p className="max-w-md text-sm text-muted">
                Connect a Workspace server to see tasks, meetings and deadlines from its databases
                here.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => setConnecting({ kind: 'workspace', accountId: null })}
                >
                  Connect Workspace
                </Button>
                <Button onClick={() => setConnecting({ kind: 'google', accountId: null })}>
                  Connect Google Calendar
                </Button>
              </div>
            </div>
          ) : view.kind === 'month' ? (
            <MonthView
              first={first}
              month={anchor.slice(0, 7)}
              today={today}
              events={events}
              calendars={calendars}
              selectedId={openEvent?.id ?? null}
              onOpen={open}
              onPickDay={pickDay}
              onCreate={(day) => startDraft({ allDay: true, start: day, end: day, endSet: false })}
            />
          ) : view.kind === 'agenda' ? (
            <AgendaView
              days={days}
              today={today}
              events={events}
              calendars={calendars}
              selectedId={openEvent?.id ?? null}
              onOpen={open}
            />
          ) : (
            <WeekView
              days={days}
              events={events}
              calendars={calendars}
              now={now}
              selectedId={openEvent?.id ?? null}
              draft={selection?.kind === 'draft' ? selection.draft : null}
              secondZone={settings.secondZone}
              onOpen={open}
              onCreate={startDraft}
              onChange={(event, time) => changeEvent(event, { time })}
              onPickDay={pickDay}
            />
          )}
          {openEvent && (
            <EventPanel
              mode="event"
              event={openEvent}
              calendars={state.calendars}
              onClose={() => setSelection(null)}
              onUpdate={(change) => changeEvent(openEvent, change)}
              onDelete={() => deleteEvent(openEvent)}
              onOpenLink={(url) => void unwrap(api.openLink(url)).catch(report)}
              onDismissConflict={() => void api.events.dismissConflict(openEvent.id)}
              onSnooze={
                selection?.kind === 'event' && selection.fromNotification
                  ? () => {
                      void unwrap(api.events.snooze(openEvent.id)).catch(report);
                      setSelection(null);
                    }
                  : undefined
              }
            />
          )}
          {selection?.kind === 'draft' && (
            <EventPanel
              mode="draft"
              draft={selection.draft}
              calendars={state.calendars}
              onClose={() => setSelection(null)}
              onDraftChange={(draft) => setSelection({ kind: 'draft', draft })}
              onSave={() => saveDraft(selection.draft)}
            />
          )}
        </div>
      </main>
      {toast && (
        <div
          role="status"
          aria-label="Deleted"
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-menu px-4 py-2 text-sm shadow-menu"
        >
          <span>Deleted &ldquo;{toast.title}&rdquo;</span>
          <Button onClick={undoDelete} className="text-accent">
            Undo
          </Button>
        </div>
      )}
      {connecting?.kind === 'workspace' && (
        <ConnectDialog accountId={connecting.accountId} onClose={() => setConnecting(null)} />
      )}
      {connecting?.kind === 'google' && state && (
        <GoogleDialog
          setup={state.google}
          accountId={connecting.accountId}
          onClose={() => setConnecting(null)}
        />
      )}
      {dialog === 'command' && (
        <CommandBar
          today={today}
          commands={commands}
          onGoTo={goTo}
          onOpenEvent={(event) => {
            setAnchor(dayOf(event.start));
            open(event);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'shortcuts' && <ShortcutsSheet onClose={() => setDialog(null)} />}
      {dialog === 'settings' && (
        <SettingsDialog
          settings={settings}
          google={state?.google ?? null}
          onClose={() => setDialog(null)}
          onError={setError}
        />
      )}
    </div>
  );
}
