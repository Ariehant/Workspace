/**
 * The Workspace source: connecting, choosing databases, and reading and writing rows as
 * events. It holds no state of its own; the sync service (`../sync.ts`) keeps the cache.
 *
 * Reading follows HANDOFF.md 3.3–3.5:
 * - a calendar's events are its rows dated in the window (6 months back, 12 ahead), queried
 *   with day bounds;
 * - changes are the rows edited since the last sync (minus a minute), whatever their date, read
 *   with a `last_edited_time` timestamp filter (real UTC, unlike date values);
 * - trashed rows simply stop coming back, so the window query, run now and then, is also the
 *   deletion sweep.
 */
import { dayOf, type EventTime } from '../../shared/dates';
import {
  newRowProperties,
  pageToEvent,
  timeProperties,
  titleProperties,
  type ApiPage,
} from '../../shared/mapping';
import type { CalEvent, Calendar, CalendarStatus } from '../../shared/types';
import { WorkspaceApiError, type WorkspaceClient } from './client';

export interface DatabaseInfo {
  id: string;
  title: string;
}

export interface PropertyInfo {
  id: string;
  name: string;
  type: string;
}

export interface Schema extends DatabaseInfo {
  properties: PropertyInfo[];
}

export interface ViewInfo {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  name: string;
}

export interface Window {
  from: string;
  to: string;
}

/** Changes are read from this long before the last sync, for clocks and slow writes. */
export const SLACK_MS = 60_000;

type RichText = { plain_text?: string }[];
const plain = (rich: unknown) =>
  Array.isArray(rich) ? (rich as RichText).map((t) => t.plain_text ?? '').join('') : '';

/** Whether an event touches the window (by its days). */
export const inWindow = (event: CalEvent, window: Window) =>
  dayOf(event.end) >= window.from && dayOf(event.start) <= window.to;

export class WorkspaceEngine {
  constructor(readonly client: WorkspaceClient) {}

  /** Check the address and token; the integration's bot user. */
  async connect(): Promise<{ botId: string; name: string; workspaceName: string }> {
    const { body } = await this.client.request<{
      object?: string;
      id?: string;
      type?: string;
      name?: string;
      bot?: { workspace_name?: string };
    }>('GET', '/users/me');
    if (body.object !== 'user' || typeof body.id !== 'string') {
      throw new WorkspaceApiError(
        'not_workspace',
        `${this.client.server} answered, but not like a Workspace server.`,
      );
    }
    return {
      botId: body.id,
      name: body.name || 'Integration',
      workspaceName: body.bot?.workspace_name ?? '',
    };
  }

  /** The databases connected to the integration. */
  async listDatabases(): Promise<DatabaseInfo[]> {
    const { results } = await this.client.all<{ object: string; id: string; title?: unknown }>(
      'POST',
      '/search',
      { filter: { property: 'object', value: 'database' } },
    );
    return results
      .filter((r) => r.object === 'database')
      .map((r) => ({ id: r.id, title: plain(r.title) || 'Untitled' }));
  }

  async schema(databaseId: string): Promise<Schema> {
    const { body } = await this.client.request<{
      id: string;
      title?: unknown;
      properties: Record<string, { id: string; name?: string; type: string }>;
    }>('GET', `/databases/${encodeURIComponent(databaseId)}`);
    return {
      id: body.id,
      title: plain(body.title) || 'Untitled',
      properties: Object.entries(body.properties).map(([name, p]) => ({
        id: p.id,
        name: p.name ?? name,
        type: p.type,
      })),
    };
  }

  /** The database's own calendar views (a Workspace addition to the API). */
  async calendarViews(databaseId: string): Promise<ViewInfo[]> {
    const { body } = await this.client.request<{
      results: { id: string; name?: string; type?: string }[];
    }>('GET', `/databases/${encodeURIComponent(databaseId)}/views`);
    return body.results
      .filter((v) => v.type === 'calendar')
      .map((v) => ({ id: v.id, name: v.name || 'Calendar' }));
  }

  /** The workspace's people (for "only mine"; bots left out). */
  async people(): Promise<Person[]> {
    const { results } = await this.client.all<{ id: string; type?: string; name?: string }>(
      'GET',
      '/users',
    );
    return results
      .filter((u) => u.type === 'person')
      .map((u) => ({ id: u.id, name: u.name || 'Someone' }));
  }

  private queryPath(calendar: Calendar) {
    const db = encodeURIComponent(calendar.databaseId);
    return calendar.viewId
      ? `/databases/${db}/views/${encodeURIComponent(calendar.viewId)}/query`
      : `/databases/${db}/query`;
  }

  /** Every event in the window (the first sync, and the deletion sweep). */
  async fetchWindow(
    calendar: Calendar,
    window: Window,
  ): Promise<{ events: CalEvent[]; serverTime: number | null }> {
    const date = calendar.dateProperty.id;
    const { results, serverTime } = await this.client.all<ApiPage>(
      'POST',
      this.queryPath(calendar),
      {
        filter: {
          and: [
            { property: date, date: { on_or_after: window.from } },
            { property: date, date: { on_or_before: window.to } },
            ...(calendar.people
              ? [{ property: calendar.people.id, people: { contains: calendar.people.personId } }]
              : []),
          ],
        },
      },
    );
    const events = results
      .map((page) => pageToEvent(page, calendar))
      .filter((e): e is CalEvent => !!e && inWindow(e, window));
    return { events, serverTime };
  }

  /**
   * Rows edited since `since` (a server time, in ms), whatever their date: the events to keep
   * or update, and the rows that left the calendar (date cleared or moved out of the window,
   * no longer "mine", trashed).
   */
  async fetchChanged(
    calendar: Calendar,
    since: number,
    window: Window,
  ): Promise<{ upserts: CalEvent[]; removed: string[]; serverTime: number | null }> {
    const { results, serverTime } = await this.client.all<ApiPage>(
      'POST',
      this.queryPath(calendar),
      {
        filter: {
          timestamp: 'last_edited_time',
          last_edited_time: { on_or_after: new Date(since - SLACK_MS).toISOString() },
        },
      },
    );
    const upserts: CalEvent[] = [];
    const removed: string[] = [];
    for (const page of results) {
      const event = pageToEvent(page, calendar);
      if (event && inWindow(event, window)) upserts.push(event);
      else removed.push(page.id);
    }
    return { upserts, removed, serverTime };
  }

  /** A new row; the event it became (null if the calendar wouldn't show it). */
  async create(calendar: Calendar, title: string, time: EventTime): Promise<CalEvent | null> {
    const { body } = await this.client.request<ApiPage>('POST', '/pages', {
      parent: { database_id: calendar.databaseId },
      properties: newRowProperties(calendar, title, time),
    });
    return pageToEvent(body, calendar);
  }

  /** Change a row's time and/or title; the event it is now (null if it left the calendar). */
  async update(
    calendar: Calendar,
    sourceId: string,
    change: { title?: string; time?: EventTime },
  ): Promise<CalEvent | null> {
    const { body } = await this.client.request<ApiPage>(
      'PATCH',
      `/pages/${encodeURIComponent(sourceId)}`,
      {
        properties: {
          ...(change.title !== undefined && titleProperties(calendar, change.title)),
          ...(change.time && timeProperties(calendar, change.time)),
        },
      },
    );
    return pageToEvent(body, calendar);
  }

  /** Move a row to Workspace's trash (it can be restored there). */
  async trash(sourceId: string): Promise<void> {
    await this.client.request('PATCH', `/pages/${encodeURIComponent(sourceId)}`, {
      in_trash: true,
    });
  }
}

/**
 * What a failed request means for a calendar: a status to show (with a message), or null when
 * it's not about this calendar (offline, busy, a bad token: the account's problem).
 */
export function calendarProblem(
  error: unknown,
  calendar: Calendar,
): { status: CalendarStatus; message: string } | null {
  if (!(error instanceof WorkspaceApiError)) return null;
  if (error.code === 'object_not_found' || error.code === 'restricted_resource') {
    return {
      status: 'no-access',
      message:
        `"${calendar.name}" is no longer connected to the integration. In Workspace, open the ` +
        `database (or a page above it), choose Share → Connections, and add the integration again.`,
    };
  }
  if (error.code === 'validation_error') {
    return {
      status: 'needs-setup',
      message: `The date property "${calendar.dateProperty.name}" changed or is gone: ${error.message}`,
    };
  }
  return null;
}
