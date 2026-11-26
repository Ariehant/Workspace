/** The bridge between the window and the main process: channel names and the types they carry. */
import type { Account, Calendar, WorkspaceCalendar } from './types';

export const IPC = {
  state: 'state:get',
  events: 'events:range',
  syncNow: 'sync:now',
  connectCheck: 'connect:check',
  connectAccount: 'connect:account',
  connectDatabases: 'connect:databases',
  connectSchema: 'connect:schema',
  connectViews: 'connect:views',
  connectPeople: 'connect:people',
  connectSave: 'connect:save',
  connectCancel: 'connect:cancel',
  googleSetClient: 'google:set-client',
  googleSignIn: 'google:sign-in',
  googleAccount: 'google:account',
  googleSave: 'google:save',
  googleCancel: 'google:cancel',
  icsSubscribe: 'ics:subscribe',
  calendarUpdate: 'calendar:update',
  calendarRemove: 'calendar:remove',
  accountRemove: 'account:remove',
  settingsSet: 'settings:set',
  eventCreate: 'event:create',
  eventUpdate: 'event:update',
  eventDelete: 'event:delete',
  eventUndoDelete: 'event:undo-delete',
  eventDismissConflict: 'event:dismiss-conflict',
  search: 'events:search',
  eventGet: 'event:get',
  snooze: 'event:snooze',
  openLink: 'link:open',
  /** main → window: show this event (a notification or the tray was clicked). */
  showEvent: 'event:show',
  /** main → window: something shown changed (refetch). */
  changed: 'changed',
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemePreference;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStartsOn: 0 | 1 | 6;
  /** Another time zone shown as a second time column (IANA name), or null. */
  secondZone: string | null;
  /** Keep running in the tray when the window is closed (notifications still arrive). */
  keepInTray: boolean;
  /** Start when the user logs in, in the tray. */
  startAtLogin: boolean;
  /** Draw with the GPU (smoother on large screens, more memory). Applies after a restart. */
  hardwareAcceleration: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  weekStartsOn: 1,
  secondZone: null,
  keepInTray: false,
  startAtLogin: false,
  hardwareAcceleration: false,
};

export interface SyncStatusView {
  online: boolean;
  syncing: boolean;
  error: string | null;
  lastSync: number | null;
  /** Edits waiting to be sent. */
  pending: number;
  /** The last edit Workspace refused. */
  editError: string | null;
}

export interface AppState {
  accounts: Account[];
  calendars: Calendar[];
  status: SyncStatusView;
  settings: Settings;
  /** Whether tokens are encrypted by the system's keyring. */
  secureStorage: boolean;
  google: GoogleSetup;
}

/** The Google OAuth client (the secret stays in the main process). */
export interface GoogleSetup {
  configured: boolean;
  /** This build or run brings its own client (Settings can't change it). */
  fromEnvironment: boolean;
  clientId: string;
  hasSecret: boolean;
}

/** A Google account signed in (or already added), and its calendars to choose from. */
export interface GoogleConnect {
  sessionId: string;
  email: string;
  calendars: GoogleCalendarChoice[];
}

export interface GoogleCalendarChoice {
  googleId: string;
  name: string;
  /** Google's colour for it (`#rrggbb`), or null. */
  colour: string | null;
  accessRole: string;
  primary: boolean;
  /** Already shown here. */
  added: boolean;
}

/** A connection being set up (the token stays in the main process). */
export interface ConnectSession {
  sessionId: string;
  server: string;
  botName: string;
  workspaceName: string;
}

export interface DatabaseChoice {
  id: string;
  title: string;
}

export interface SchemaChoice {
  id: string;
  title: string;
  properties: { id: string; name: string; type: string }[];
}

/** A calendar the user set up in the connect dialog. */
export type CalendarDraft = Pick<
  WorkspaceCalendar,
  | 'databaseId'
  | 'viewId'
  | 'name'
  | 'colour'
  | 'dateProperty'
  | 'titleProperty'
  | 'people'
  | 'colourBy'
> & { reminder?: number | null };

/** What the window may change on a calendar. */
export type CalendarPatch = Partial<Pick<Calendar, 'name' | 'colour' | 'visible' | 'reminder'>>;

/** Sent with `showEvent`: the event, and whether it came from a notification (offer snooze). */
export interface ShowEvent {
  eventId: string;
  fromNotification: boolean;
}
