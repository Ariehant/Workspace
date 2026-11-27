/**
 * The Meetings screen: New meeting note, and what's coming up in the next two weeks from the
 * workspace's dated database rows (the same rows Workspace Calendar shows).
 */
import { formatShortDay, formatTimeOfDay, formatWeekday } from '@workspace/core';
import { dateFromString } from '@workspace/database';
import { PageIcon } from '@workspace/editor';
import { Button, IconButton } from '@workspace/ui';
import { ArrowLeft, CalendarDays, ChevronsRight, Mic } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useApp } from './context';
import { byDay, upcomingRange } from './meetings';
import type { ChromeProps } from './page-view';
import type { UpcomingEvent } from './platform';

/** A day's heading: Today, Tomorrow, a weekday this week, else the date. */
export function dayHeading(day: string, now: Date): string {
  const date = dateFromString(day);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((date.getTime() - today.getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return formatWeekday(date);
  return formatShortDay(date);
}

/** An event's time on its day: All day, its start, or "until …" for one that began earlier. */
export function eventTime(event: UpcomingEvent, day: string): string {
  if (event.allDay) return 'All day';
  if (event.start.slice(0, 10) < day) {
    return event.end.slice(0, 10) === day
      ? `until ${formatTimeOfDay(dateFromString(event.end))}`
      : 'All day';
  }
  const start = formatTimeOfDay(dateFromString(event.start));
  return event.end > event.start && event.end.slice(0, 10) === event.start.slice(0, 10)
    ? `${start} – ${formatTimeOfDay(dateFromString(event.end))}`
    : start;
}

/** What's coming up, from the platform's index, refreshed while shown. */
export function useUpcomingEvents(limit?: number): UpcomingEvent[] | null {
  const { platform } = useApp();
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null);
  useEffect(() => {
    if (!platform.upcomingEvents) return;
    let live = true;
    const load = () => {
      const { from, to } = upcomingRange(new Date());
      void platform.upcomingEvents!(from, to).then(
        (list) => live && setEvents(limit ? list.slice(0, limit) : list),
      );
    };
    load();
    // The index follows edits a moment after they're made.
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [platform, limit]);
  return events;
}

export function MeetingsView({
  chrome,
  onOpen,
  onNewNote,
}: {
  chrome: ChromeProps;
  onOpen(rowId: string): void;
  onNewNote(): Promise<void>;
}) {
  const { platform, pages } = useApp();
  const events = useUpcomingEvents();
  const [busy, setBusy] = useState(false);
  const now = new Date();

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface" data-testid="meetings">
      <header className="flex h-11 shrink-0 items-center gap-1 px-3 text-sm">
        {!chrome.sidebarOpen && (
          <IconButton label="Open sidebar (Ctrl+\)" onClick={chrome.onOpenSidebar}>
            <ChevronsRight size={18} />
          </IconButton>
        )}
        <IconButton
          label="Go back (Alt+←)"
          className="disabled:opacity-30"
          disabled={!chrome.canGoBack}
          onClick={() => chrome.onGo(-1)}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <span className="flex items-center gap-1.5 px-1">
          <CalendarDays size={14} aria-hidden />
          Meetings
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-16 pt-10 pb-24 max-md:px-6">
          <h1 className="text-3xl font-bold">Meetings</h1>
          <div>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void onNewNote().finally(() => setBusy(false));
              }}
            >
              <Mic size={16} aria-hidden />
              New meeting note
            </Button>
          </div>

          <section aria-label="Upcoming events" className="flex flex-col gap-3">
            <h2 className="text-xs font-medium text-muted">Upcoming events</h2>
            {!platform.upcomingEvents && (
              <p className="text-sm text-faint">Upcoming events are listed in the desktop app.</p>
            )}
            {events?.length === 0 && (
              <p className="text-sm text-faint">
                No upcoming events in the next two weeks. Dates in your databases show here, and
                meeting notes you make.
              </p>
            )}
            {events &&
              byDay(events, now).map(([day, list]) => (
                <div key={day} className="flex flex-col">
                  <h3
                    className="px-2 pb-1 text-xs font-semibold text-muted"
                    data-testid="meetings-day"
                  >
                    {dayHeading(day, now)}
                  </h3>
                  <ul className="flex flex-col">
                    {list.map((event) => (
                      <li key={`${event.rowId}/${event.propertyId}`}>
                        <button
                          type="button"
                          onClick={() => onOpen(event.rowId)}
                          data-testid="meetings-event"
                          className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-hover"
                        >
                          <span className="w-36 shrink-0 text-muted tabular-nums">
                            {eventTime(event, day)}
                          </span>
                          <PageIcon icon={event.icon} size={16} fileUrl={platform.fileUrl} />
                          <span className="min-w-0 flex-1 truncate">
                            {event.title || 'Untitled'}
                          </span>
                          <span className="max-w-[30%] shrink-0 truncate text-xs text-muted">
                            {pages.get(event.databaseId)?.title || event.databaseTitle}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        </div>
      </div>
    </main>
  );
}
