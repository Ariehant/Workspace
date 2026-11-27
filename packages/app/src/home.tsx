/**
 * Home (Phase 8 N6, #26): where you left off and what's coming. The pages you visited last,
 * the reminders still to come (`@remind` in pages, and on date properties), and the pages
 * edited most recently.
 */
import {
  formatShortDay,
  formatTimeOfDay,
  formatWeekday,
  isInTrash,
  listPages,
  type PageId,
} from '@workspace/core';
import { PageIcon, type PageRef } from '@workspace/editor';
import { IconButton } from '@workspace/ui';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  ChevronsRight,
  Clock,
  History,
  House,
} from 'lucide-react';
import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { timeAgo } from './comments';
import { useApp } from './context';
import type { ChromeProps } from './page-view';
import { isoDay } from './meetings';
import { dayHeading, eventTime, useUpcomingEvents } from './meetings-view';
import type { UpcomingReminder } from './platform';

/** How many of each list Home shows. */
const RECENT_CARDS = 8;
const EDITED_ROWS = 8;
const HOME_EVENTS = 3;

/** "Good morning" before noon, "Good afternoon" until six, then "Good evening". */
export function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** When a reminder fires, as Home lists it: "Today 3:00 PM", "Tomorrow …", "Mon, Nov 23 …". */
export function upcomingWhen(ms: number, now: Date): string {
  const date = new Date(ms);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(date) - day(now)) / 86_400_000);
  const time = formatTimeOfDay(date);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${formatWeekday(date)} ${time}`;
  return `${formatShortDay(date)} ${time}`;
}

function Section({
  title,
  icon,
  testId,
  children,
}: {
  title: string;
  icon: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} data-testid={testId} className="flex flex-col gap-2">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Home({
  chrome,
  recent,
  onOpen,
}: {
  chrome: ChromeProps;
  /** Pages visited, most recent first. */
  recent: readonly PageId[];
  /** Open a page (at a block, for a reminder in its content). */
  onOpen(pageId: PageId, blockId: string | null): void;
}) {
  const { platform, pages, workspace, user } = useApp();
  // Titles, icons and edits change as people work: draw again.
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => pages.subscribe(bump), [pages]);
  const [upcoming, setUpcoming] = useState<UpcomingReminder[] | null>(null);
  const events = useUpcomingEvents(HOME_EVENTS);
  useEffect(() => {
    if (!platform.upcoming) return;
    let live = true;
    void platform.upcoming().then((list) => live && setUpcoming(list));
    return () => {
      live = false;
    };
    // `version`: a reminder may have been added or changed.
  }, [platform, version]);

  const now = new Date();
  const today = isoDay(now);
  /** The day an event is listed under: the later of its start and today. */
  const shownOn = (event: { start: string }) =>
    event.start.slice(0, 10) < today ? today : event.start.slice(0, 10);
  const visited = recent
    .map((id) => pages.get(id))
    .filter((p): p is PageRef => p !== null && !p.inTrash)
    .slice(0, RECENT_CARDS);
  const edited = listPages(workspace)
    .filter((p) => !isInTrash(workspace, p.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, EDITED_ROWS);
  const parentTitle = (id: PageId) => {
    const crumbs = pages.breadcrumb(id);
    return crumbs.length > 1 ? crumbs[crumbs.length - 2]!.title || 'Untitled' : null;
  };
  const firstName = user.name.trim().split(/\s+/)[0] ?? '';

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface" data-testid="home">
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
        <IconButton
          label="Go forward (Alt+→)"
          className="disabled:opacity-30"
          disabled={!chrome.canGoForward}
          onClick={() => chrome.onGo(1)}
        >
          <ArrowRight size={16} />
        </IconButton>
        <span className="flex items-center gap-1.5 px-1">
          <House size={14} aria-hidden />
          Home
        </span>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[900px] flex-col gap-8 px-24 pt-10 pb-24 max-md:px-6">
          <h1 className="text-center text-3xl font-bold">
            {greeting(now)}
            {firstName && `, ${firstName}`}
          </h1>

          <Section title="Recently visited" icon={<Clock size={14} />} testId="home-recent">
            {visited.length === 0 ? (
              <p className="text-sm text-faint">The pages you open show up here.</p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
                {visited.map((page) => (
                  <li key={page.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(page.id, null)}
                      data-testid="home-recent-page"
                      className="flex h-28 w-full flex-col gap-2 rounded-lg border border-line bg-surface p-3 text-left shadow-sm hover:bg-hover"
                    >
                      <PageIcon icon={page.icon} size={24} fileUrl={platform.fileUrl} />
                      <span className="line-clamp-2 text-sm font-medium">
                        {page.title || 'Untitled'}
                      </span>
                      {parentTitle(page.id) && (
                        <span className="mt-auto truncate text-xs text-muted">
                          {parentTitle(page.id)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {platform.upcomingEvents && (
            <Section title="Upcoming events" icon={<CalendarDays size={14} />} testId="home-events">
              {events?.length === 0 && (
                <p className="text-sm text-faint">No upcoming events in the next two weeks.</p>
              )}
              {events && events.length > 0 && (
                <ul className="flex flex-col">
                  {events.map((event) => (
                    <li key={`${event.rowId}/${event.propertyId}`}>
                      <button
                        type="button"
                        onClick={() => onOpen(event.rowId, null)}
                        data-testid="home-event"
                        className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-hover"
                      >
                        <span className="w-36 shrink-0 text-muted tabular-nums">
                          {dayHeading(shownOn(event), now)} {eventTime(event, shownOn(event))}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{event.title || 'Untitled'}</span>
                        <span className="max-w-[30%] shrink-0 truncate text-xs text-muted">
                          {event.databaseTitle}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          {platform.upcoming && (
            <Section title="Upcoming" icon={<Bell size={14} />} testId="home-upcoming">
              {upcoming?.length === 0 && (
                <p className="text-sm text-faint">
                  No reminders coming up. Type @remind in a page, or set a reminder on a date.
                </p>
              )}
              {upcoming && upcoming.length > 0 && (
                <ul className="flex flex-col">
                  {upcoming.map((r) => (
                    <li key={`${r.pageId}/${r.blockId}/${r.fireAt}`}>
                      <button
                        type="button"
                        onClick={() => onOpen(r.pageId, r.blockId)}
                        data-testid="home-reminder"
                        className="flex h-9 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-hover"
                      >
                        <span className="w-36 shrink-0 text-muted tabular-nums">
                          {upcomingWhen(r.fireAt, now)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{r.text || 'Reminder'}</span>
                        <span className="max-w-[30%] shrink-0 truncate text-xs text-muted">
                          {pages.get(r.pageId)?.title || r.pageTitle || 'Untitled'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}

          <Section title="Recently edited" icon={<History size={14} />} testId="home-edited">
            <ul className="flex flex-col">
              {edited.map((page) => (
                <li key={page.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(page.id, null)}
                    data-testid="home-edited-page"
                    className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-hover"
                  >
                    <PageIcon icon={page.icon} size={16} fileUrl={platform.fileUrl} />
                    <span className="min-w-0 flex-1 truncate">{page.title || 'Untitled'}</span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(page.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </div>
    </main>
  );
}
