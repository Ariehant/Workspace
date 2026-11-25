/** The bridge between the window and the main process: channel names and the types they carry. */
import type { Account, Calendar } from './types';

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
  calendarUpdate: 'calendar:update',
  calendarRemove: 'calendar:remove',
  accountRemove: 'account:remove',
  settingsSet: 'settings:set',
  /** main → window: something shown changed (refetch). */
  changed: 'changed',
} as const;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Settings {
  theme: ThemePreference;
  /** 0 = Sunday, 1 = Monday, 6 = Saturday. */
  weekStartsOn: 0 | 1 | 6;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'system', weekStartsOn: 1 };

export interface SyncStatusView {
  online: boolean;
  syncing: boolean;
  error: string | null;
  lastSync: number | null;
}

export interface AppState {
  accounts: Account[];
  calendars: Calendar[];
  status: SyncStatusView;
  settings: Settings;
  /** Whether tokens are encrypted by the system's keyring. */
  secureStorage: boolean;
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
  Calendar,
  | 'databaseId'
  | 'viewId'
  | 'name'
  | 'colour'
  | 'dateProperty'
  | 'titleProperty'
  | 'people'
  | 'colourBy'
>;

/** What the window may change on a calendar. */
export type CalendarPatch = Partial<Pick<Calendar, 'name' | 'colour' | 'visible'>>;
