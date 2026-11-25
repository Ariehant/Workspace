/** The calendar's data model, shared by the main process and the renderer. */

/** A Workspace server, through an integration (v1.0). */
export interface WorkspaceAccount {
  id: string;
  /** Absent in accounts saved before v1.1 (they're all Workspace). */
  kind?: 'workspace';
  /** What the sidebar shows: the workspace's name and the server's host. */
  name: string;
  /** The server's address, e.g. `https://notes.example.com` (no trailing slash). */
  server: string;
  /** The integration's bot user id (from `/v1/users/me`). */
  botId: string;
  /** Set when the token stopped working (`unauthorized`). */
  error: string | null;
}

/** A Google account (v1.1). */
export interface GoogleAccount {
  id: string;
  kind: 'google';
  /** The account's email, shown in the sidebar. */
  name: string;
  email: string;
  error: string | null;
}

export type Account = WorkspaceAccount | GoogleAccount;

export const isGoogleAccount = (a: Account): a is GoogleAccount => a.kind === 'google';

export type CalendarStatus = 'ok' | 'needs-setup' | 'no-access';

interface CalendarBase {
  id: string;
  accountId: string;
  name: string;
  /** A colour name from `COLOURS`, or a hex colour (`#rrggbb`, Google's). */
  colour: string;
  visible: boolean;
  /** Notify this many minutes before events (0 = at the start), or null for none. */
  reminder?: number | null;
  status: CalendarStatus;
  /** Why the calendar needs attention (shown to the user). */
  statusMessage: string | null;
}

/** One database (with one date property) shown as a calendar. */
export interface WorkspaceCalendar extends CalendarBase {
  /** Absent in calendars saved before v1.1 (they're all Workspace). */
  kind?: 'workspace';
  databaseId: string;
  /** A database view of type `calendar` used instead of the whole database (or null). */
  viewId: string | null;
  /** Property ids (and names, for messages) in the database's schema. */
  dateProperty: { id: string; name: string };
  titleProperty: { id: string; name: string };
  /** "Only mine": a `people` property and the person the user is. */
  people: { id: string; name: string; personId: string } | null;
  /** Colour events by a `select` or `status` property's option colour. */
  colourBy: { id: string; name: string } | null;
}

/** One of a Google account's calendars. */
export interface GoogleCalendar extends CalendarBase {
  kind: 'google';
  /** Google's calendar id (an email address for most). */
  googleId: string;
  /** What the account may do: `owner`, `writer`, `reader` or `freeBusyReader`. */
  accessRole: string;
  /** The calendar's time zone (IANA), for new events. */
  timeZone: string;
}

export type Calendar = WorkspaceCalendar | GoogleCalendar;

export const isGoogleCalendar = (c: Calendar): c is GoogleCalendar => c.kind === 'google';

/**
 * Whether events in the calendar can be changed here: not one that lost access, nor a Google
 * calendar the account may only see (`reader`, `freeBusyReader`).
 */
export const canEdit = (calendar: Calendar | null | undefined): boolean =>
  !!calendar &&
  calendar.status !== 'no-access' &&
  (!isGoogleCalendar(calendar) || ['owner', 'writer'].includes(calendar.accessRole));

/** Why a calendar's events can't be changed here. */
export const READ_ONLY_MESSAGE = 'This calendar is view-only for your account.';

/** Which occurrences of a recurring event an edit is for. */
export type EditScope = 'this' | 'following' | 'all';

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
  /**
   * A timed event at a real instant (Google): its start and end in UTC. `start` and `end` are
   * then this machine's clock times for them, worked out again if the time zone changes.
   */
  instant?: { start: string; end: string };
  /** The time zone the event was made in (IANA), for writing it back. */
  timeZone?: string;
  /** An instance of a recurring event: its series' source id, and its original start. */
  series?: { id: string; originalStart: string };
  /** The source's version (Google's etag), to notice changes made elsewhere. */
  etag?: string;
  /** A video call to join (Google Meet). */
  meetLink?: string | null;
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
