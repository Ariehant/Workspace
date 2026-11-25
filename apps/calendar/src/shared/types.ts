/** The calendar's data model, shared by the main process and the renderer. */

/** A connected source. v1.0 has Workspace servers only. */
export interface Account {
  id: string;
  kind: 'workspace';
  /** What the sidebar shows: the integration's name and the server's host. */
  name: string;
  /** The server's address, e.g. `https://notes.example.com` (no trailing slash). */
  server: string;
  /** The integration's bot user id (from `/v1/users/me`). */
  botId: string;
  /** Set when the token stopped working (`unauthorized`). */
  error: string | null;
}

export type CalendarStatus = 'ok' | 'needs-setup' | 'no-access';

/** One database (with one date property) shown as a calendar. */
export interface Calendar {
  id: string;
  accountId: string;
  databaseId: string;
  /** A database view of type `calendar` used instead of the whole database (or null). */
  viewId: string | null;
  name: string;
  /** A colour name from `COLOURS`. */
  colour: string;
  visible: boolean;
  /** Property ids (and names, for messages) in the database's schema. */
  dateProperty: { id: string; name: string };
  titleProperty: { id: string; name: string };
  /** "Only mine": a `people` property and the person the user is. */
  people: { id: string; name: string; personId: string } | null;
  /** Colour events by a `select` or `status` property's option colour. */
  colourBy: { id: string; name: string } | null;
  /** Notify this many minutes before events (0 = at the start), or null for none. */
  reminder?: number | null;
  status: CalendarStatus;
  /** Why the calendar needs attention (shown to the user). */
  statusMessage: string | null;
}

/**
 * An event. Times are wall-clock strings: Workspace's dates have no time zone, so a row at
 * 10:00 shows at 10:00 wherever the user is (`floating`).
 */
export interface CalEvent {
  /** `<calendarId>:<sourceId>` (the same row can be in two calendars). */
  id: string;
  calendarId: string;
  /** The Workspace page (row) id. */
  sourceId: string;
  title: string;
  allDay: boolean;
  /** All-day: `YYYY-MM-DD`. Timed: `YYYY-MM-DDTHH:mm`. */
  start: string;
  /** All-day: the last day, inclusive. Timed: the end time (exclusive). */
  end: string;
  /** Whether the source has an end (a timed row without one shows as 1 hour). */
  endSet: boolean;
  floating: boolean;
  /** Opens the row in Workspace. */
  url: string | null;
  /** The colour-by option's colour name, if any. */
  colour: string | null;
  /** The row's other properties as text, for the event panel (read-only). */
  extra: { name: string; value: string }[];
  /** Real UTC (`last_edited_time`); '' for an event not yet created at its source. */
  lastEdited: string;
  /** Edits made here are waiting to be sent. */
  pending?: boolean;
  /**
   * The event changed at its source while an edit made here was waiting: the source's version,
   * shown in the panel as "Changed elsewhere" (the edit made here still went; last write wins).
   */
  conflict?: { title: string; allDay: boolean; start: string; end: string } | null;
}

/** Colour names, as Workspace (and Notion) name option colours. */
export const COLOURS = [
  'blue',
  'green',
  'orange',
  'purple',
  'pink',
  'red',
  'yellow',
  'brown',
  'gray',
] as const;
export type ColourName = (typeof COLOURS)[number];
