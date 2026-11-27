/**
 * Meetings: what's coming up from the workspace's dated database rows, and meeting notes
 * kept in a Meetings database (made on first use), so Workspace Calendar shows them too.
 */
import {
  createPage,
  getPage,
  isInTrash,
  type DocClient,
  type PageId,
  type PageTree,
} from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addView,
  deleteProperty,
  initDatabase,
  readDatabase,
} from '@workspace/database';
import { appendContent } from '@workspace/editor';
import type * as Y from 'yjs';
import type { Platform, UpcomingEvent } from './platform';

/** The Meetings database's id, once made. */
export const MEETINGS_SETTING = 'meetings.databaseId';
/** How far ahead Meetings looks. */
export const UPCOMING_DAYS = 14;

const pad = (n: number) => String(n).padStart(2, '0');
/** `YYYY-MM-DD` of a local date. */
export const isoDay = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `YYYY-MM-DDTHH:MM` of a local time. */
export const isoMinute = (d: Date) => `${isoDay(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** The range Meetings asks for: from now to the end of the `days`th day. */
export function upcomingRange(now: Date, days = UPCOMING_DAYS): { from: string; to: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return { from: isoMinute(now), to: isoDay(end) };
}

/** Events grouped by the day they're shown under: the later of their start and today. */
export function byDay(events: readonly UpcomingEvent[], now: Date): [string, UpcomingEvent[]][] {
  const today = isoDay(now);
  const days = new Map<string, UpcomingEvent[]>();
  for (const event of events) {
    const start = event.start.slice(0, 10);
    const day = start < today ? today : start;
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Now, rounded up to the next half hour (a new meeting's start). */
export function nextHalfHour(now: Date): Date {
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
  );
  if (next < now) next.setMinutes(next.getMinutes() + 1);
  const over = next.getMinutes() % 30;
  if (over) next.setMinutes(next.getMinutes() + 30 - over);
  return next;
}

const MEETING_NOTES = ['## Agenda', '- ', '## Notes', '', '## Action items', '- [ ] '].join('\n\n');

async function withDoc<T>(client: DocClient, id: string, fn: (doc: Y.Doc) => T) {
  const handle = client.acquire(id);
  try {
    await handle.ready;
    return fn(handle.doc);
  } finally {
    handle.release();
  }
}

/** The Meetings database: the one made before (if it's still there), else a new one. */
export async function meetingsDatabase(
  client: DocClient,
  workspace: PageTree,
  platform: Platform,
  createdBy: string | null,
): Promise<PageId> {
  const known = await platform.getSetting<string>(MEETINGS_SETTING);
  if (known && getPage(workspace, known)?.kind === 'database' && !isInTrash(workspace, known)) {
    return known;
  }
  const id = createPage(workspace, {
    parentId: null,
    title: 'Meetings',
    icon: '📅',
    kind: 'database',
    createdBy,
  });
  await withDoc(client, id, (doc) => {
    initDatabase(doc, { databaseId: id });
    doc.transact(() => {
      for (const p of readDatabase(doc).properties) {
        if (p.id !== TITLE_PROPERTY_ID) deleteProperty(doc, p.id);
      }
      addProperty(doc, { name: 'Date', type: 'date' });
      addProperty(doc, { name: 'Attendees', type: 'person' });
      addProperty(doc, {
        name: 'Type',
        type: 'select',
        config: {
          options: [
            { id: 'meeting', name: 'Meeting', color: 'blue' },
            { id: 'one-on-one', name: '1:1', color: 'green' },
            { id: 'call', name: 'Call', color: 'purple' },
          ],
        },
      });
      addView(doc, { viewSet: id, name: 'Calendar', type: 'calendar' });
    });
  });
  platform.setSetting(MEETINGS_SETTING, id);
  return id;
}

/** A new meeting note: a row of the Meetings database, starting at the next half hour. */
export async function newMeetingNote(options: {
  client: DocClient;
  workspace: PageTree;
  platform: Platform;
  userId: string | null;
  now?: Date;
}): Promise<{ databaseId: PageId; rowId: string }> {
  const { client, workspace, platform, userId } = options;
  const databaseId = await meetingsDatabase(client, workspace, platform, userId);
  const start = isoMinute(nextHalfHour(options.now ?? new Date()));
  const rowId = await withDoc(client, databaseId, (doc) => {
    const date = readDatabase(doc).properties.find((p) => p.type === 'date');
    return addRow(doc, {
      actor: userId,
      title: 'Meeting notes',
      values: date ? { [date.id]: { start } } : {},
    });
  });
  await withDoc(client, rowId, (doc) => appendContent(doc, [MEETING_NOTES]));
  return { databaseId, rowId };
}
