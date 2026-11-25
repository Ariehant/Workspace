/**
 * The tray icon (HANDOFF.md 1): the next event and today's list, Open and Quit. On GNOME the icon
 * needs the AppIndicator extension (Ubuntu ships it); without it the app still works.
 */
import { Menu, nativeImage, Tray } from 'electron';
import { dayOf, minutesOf, nowWall, today } from '../shared/dates';
import type { CalEvent } from '../shared/types';

export interface TrayOptions {
  icon: string;
  /** Events touching today and tomorrow (visible calendars). */
  events: () => CalEvent[];
  onOpen: () => void;
  onOpenEvent: (eventId: string) => void;
  onQuit: () => void;
}

const MAX_TODAY = 10;

const pad = (n: number) => String(n).padStart(2, '0');
/** "09:30" (24-hour: the tray menu has no room for the locale's longer forms). */
const clock = (time: string) =>
  `${pad(Math.floor(minutesOf(time) / 60))}:${pad(minutesOf(time) % 60)}`;
const titleOf = (e: CalEvent) => e.title || 'Untitled';

/** The next event that hasn't started (timed), else null; and today's events in order. */
export function trayContents(events: CalEvent[], now = nowWall()) {
  const day = today();
  const todays = events
    .filter((e) => dayOf(e.start) <= day && (e.allDay ? e.end : dayOf(e.end)) >= day)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
  const next =
    events
      .filter((e) => !e.allDay && e.start > now)
      .sort((a, b) => a.start.localeCompare(b.start))[0] ?? null;
  return { next, todays };
}

export class CalendarTray {
  private readonly tray: Tray;

  constructor(private readonly options: TrayOptions) {
    const image = nativeImage.createFromPath(options.icon);
    this.tray = new Tray(image);
    this.tray.setToolTip('Workspace Calendar');
    this.tray.on('click', options.onOpen);
    this.update();
  }

  update() {
    const { next, todays } = trayContents(this.options.events());
    const nextLabel = next
      ? `Next: ${titleOf(next)} · ${dayOf(next.start) === today() ? clock(next.start) : `${dayOf(next.start)} ${clock(next.start)}`}`
      : 'Nothing else today';
    this.tray.setToolTip(next ? `Workspace Calendar — ${nextLabel}` : 'Workspace Calendar');
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: nextLabel, enabled: false },
      { type: 'separator' },
      ...(todays.length
        ? [
            { label: 'Today', enabled: false },
            ...todays.slice(0, MAX_TODAY).map((e) => ({
              label: `${e.allDay ? 'All day' : clock(e.start)}  ${titleOf(e)}`,
              click: () => this.options.onOpenEvent(e.id),
            })),
            ...(todays.length > MAX_TODAY
              ? [{ label: `${todays.length - MAX_TODAY} more…`, click: this.options.onOpen }]
              : []),
          ]
        : [{ label: 'No events today', enabled: false }]),
      { type: 'separator' },
      { label: 'Open Workspace Calendar', click: this.options.onOpen },
      { label: 'Quit', click: this.options.onQuit },
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    // End-to-end tests read the menu here (there's no way to open a tray menu from a test).
    if (process.env.CALENDAR_E2E)
      (globalThis as { __trayMenu?: string[] }).__trayMenu = items.map((i) => i.label ?? '—');
  }

  destroy() {
    this.tray.destroy();
  }
}
