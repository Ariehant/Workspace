/** Workspace rows (Notion page objects) to events, and edits back to page properties. */
import { readApiDate, writeApiDate, type ApiDate, type EventTime } from './dates';
import type { CalEvent, Calendar } from './types';

/** A page object, as much of it as the calendar reads. */
export interface ApiPage {
  object: 'page';
  id: string;
  url?: string;
  last_edited_time: string;
  in_trash?: boolean;
  archived?: boolean;
  properties: Record<string, ApiPropertyValue>;
}

export interface ApiPropertyValue {
  id: string;
  type: string;
  [key: string]: unknown;
}

type RichText = { plain_text?: string }[];

const plain = (rich: unknown): string =>
  Array.isArray(rich) ? (rich as RichText).map((t) => t.plain_text ?? '').join('') : '';

/** The value of a property by its id, with the name it has now. */
export function propertyById(
  page: ApiPage,
  id: string,
): { name: string; value: ApiPropertyValue } | null {
  for (const [name, value] of Object.entries(page.properties)) {
    if (value?.id === id) return { name, value };
  }
  return null;
}

/** A property value as one line of text (for the event panel), or '' when empty. */
export function propertyText(value: ApiPropertyValue): string {
  const v = value[value.type];
  switch (value.type) {
    case 'title':
    case 'rich_text':
      return plain(v);
    case 'number':
      return typeof v === 'number' ? String(v) : '';
    case 'select':
    case 'status':
      return (v as { name?: string } | null)?.name ?? '';
    case 'multi_select':
      return Array.isArray(v) ? v.map((o: { name?: string }) => o.name ?? '').join(', ') : '';
    case 'checkbox':
      return v === true ? 'Yes' : 'No';
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof v === 'string' ? v : '';
    case 'date': {
      const d = v as ApiDate | null;
      if (!d?.start) return '';
      const start = d.start.slice(0, d.start.length > 10 ? 16 : 10).replace('T', ' ');
      const end = d.end ? d.end.slice(0, d.end.length > 10 ? 16 : 10).replace('T', ' ') : '';
      return end ? `${start} → ${end}` : start;
    }
    case 'people':
      return Array.isArray(v)
        ? v.map((p: { name?: string; id: string }) => p.name ?? 'Someone').join(', ')
        : '';
    case 'created_by':
    case 'last_edited_by':
      return (v as { name?: string } | null)?.name ?? '';
    case 'created_time':
    case 'last_edited_time':
      return typeof v === 'string' ? v.slice(0, 16).replace('T', ' ') + ' UTC' : '';
    case 'unique_id': {
      const u = v as { prefix?: string | null; number?: number | null } | null;
      if (u?.number === null || u?.number === undefined) return '';
      return u.prefix ? `${u.prefix}-${u.number}` : String(u.number);
    }
    case 'files':
      return Array.isArray(v) ? v.map((f: { name?: string }) => f.name ?? 'File').join(', ') : '';
    case 'relation':
      return Array.isArray(v) ? `${v.length} linked` : '';
    case 'formula': {
      const f = v as { type?: string; [k: string]: unknown } | null;
      if (!f?.type) return '';
      const inner = f[f.type];
      if (f.type === 'date') return propertyText({ id: '', type: 'date', date: inner });
      if (f.type === 'boolean') return inner ? 'Yes' : 'No';
      return inner === null || inner === undefined ? '' : String(inner);
    }
    case 'rollup': {
      const r = v as { type?: string; [k: string]: unknown } | null;
      if (!r?.type) return '';
      const inner = r[r.type];
      if (r.type === 'array' && Array.isArray(inner))
        return inner.map((x) => propertyText(x as ApiPropertyValue)).join(', ');
      if (r.type === 'date') return propertyText({ id: '', type: 'date', date: inner });
      return inner === null || inner === undefined ? '' : String(inner);
    }
    default:
      return '';
  }
}

/**
 * A row as an event in a calendar, or null when it has no date in the calendar's date
 * property (rows without a date aren't shown) or is in the trash.
 */
export function pageToEvent(page: ApiPage, calendar: Calendar): CalEvent | null {
  if (page.in_trash || page.archived) return null;
  const date = propertyById(page, calendar.dateProperty.id);
  if (!date || date.value.type !== 'date') return null;
  const time = readApiDate(date.value.date as ApiDate | null);
  if (!time) return null;
  if (calendar.people) {
    // "Only mine": rows whose people property doesn't have the user aren't shown (so a row
    // the user was taken off leaves the calendar on the next sync).
    const people = propertyById(page, calendar.people.id)?.value.people;
    const personId = calendar.people.personId;
    if (!Array.isArray(people) || !people.some((p: { id?: string }) => p.id === personId))
      return null;
  }
  const title = propertyById(page, calendar.titleProperty.id);
  let colour: string | null = null;
  if (calendar.colourBy) {
    const by = propertyById(page, calendar.colourBy.id)?.value;
    const option = by ? (by[by.type] as { color?: string } | null) : null;
    colour = option?.color && option.color !== 'default' ? option.color : null;
  }
  const extra: CalEvent['extra'] = [];
  for (const [name, value] of Object.entries(page.properties)) {
    if (!value || value.id === calendar.titleProperty.id || value.id === calendar.dateProperty.id)
      continue;
    const text = propertyText(value);
    if (text) extra.push({ name, value: text });
  }
  return {
    id: `${calendar.id}:${page.id}`,
    calendarId: calendar.id,
    sourceId: page.id,
    title: (title && plain(title.value.title)) || '',
    ...time,
    floating: !time.allDay,
    url: page.url ?? null,
    colour,
    extra,
    lastEdited: page.last_edited_time,
  };
}

/** The `properties` that set an event's time. */
export function timeProperties(calendar: Calendar, time: EventTime): Record<string, unknown> {
  return { [calendar.dateProperty.id]: { date: writeApiDate(time) } };
}

/** The `properties` that set an event's title. */
export function titleProperties(calendar: Calendar, title: string): Record<string, unknown> {
  return { [calendar.titleProperty.id]: { title: [{ text: { content: title } }] } };
}

/** The `properties` of a new row: its title, its time, and the user for "only mine". */
export function newRowProperties(
  calendar: Calendar,
  title: string,
  time: EventTime,
): Record<string, unknown> {
  return {
    ...titleProperties(calendar, title),
    ...timeProperties(calendar, time),
    ...(calendar.people && {
      [calendar.people.id]: { people: [{ id: calendar.people.personId }] },
    }),
  };
}
