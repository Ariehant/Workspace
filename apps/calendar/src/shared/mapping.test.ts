import { describe, expect, it } from 'vitest';
import {
  newRowProperties,
  pageToEvent,
  propertyText,
  timeProperties,
  titleProperties,
  type ApiPage,
} from './mapping';
import type { Calendar } from './types';

const calendar: Calendar = {
  id: 'cal-1',
  accountId: 'acc-1',
  databaseId: 'db-1',
  viewId: null,
  name: 'Tasks',
  colour: 'blue',
  visible: true,
  dateProperty: { id: 'x1', name: 'When' },
  titleProperty: { id: 'title', name: 'Name' },
  people: null,
  colourBy: null,
  status: 'ok',
  statusMessage: null,
};

const page = (properties: ApiPage['properties'], extra: Partial<ApiPage> = {}): ApiPage => ({
  object: 'page',
  id: 'row-1',
  url: 'https://notes.example.com/w/ws-1#page=row-1',
  last_edited_time: '2026-11-20T08:12:00.000Z',
  properties,
  ...extra,
});

const title = (text: string) => ({
  id: 'title',
  type: 'title',
  title: [{ plain_text: text.slice(0, 3) }, { plain_text: text.slice(3) }],
});

describe('rows to events', () => {
  it('reads the title, the time, the link and the edit time', () => {
    const event = pageToEvent(
      page({
        Name: title('Design review'),
        When: {
          id: 'x1',
          type: 'date',
          date: {
            start: '2026-11-24T10:00:00.000+00:00',
            end: '2026-11-24T11:00:00.000+00:00',
            time_zone: null,
          },
        },
      }),
      calendar,
    );
    expect(event).toEqual({
      id: 'cal-1:row-1',
      calendarId: 'cal-1',
      sourceId: 'row-1',
      title: 'Design review',
      allDay: false,
      start: '2026-11-24T10:00',
      end: '2026-11-24T11:00',
      endSet: true,
      floating: true,
      url: 'https://notes.example.com/w/ws-1#page=row-1',
      colour: null,
      extra: [],
      lastEdited: '2026-11-20T08:12:00.000Z',
    });
  });

  it('finds properties by id, so a renamed property still works', () => {
    const event = pageToEvent(
      page({
        Title: { id: 'title', type: 'title', title: [{ plain_text: 'Renamed' }] },
        'Due date': { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
      }),
      calendar,
    );
    expect(event).toMatchObject({ title: 'Renamed', allDay: true, start: '2026-11-24' });
  });

  it('skips rows with no date, a date of another property, or in the trash', () => {
    expect(pageToEvent(page({ Name: title('No date') }), calendar)).toBeNull();
    expect(
      pageToEvent(
        page({ Name: title('Empty'), When: { id: 'x1', type: 'date', date: null } }),
        calendar,
      ),
    ).toBeNull();
    const dated = {
      Name: title('Trashed'),
      When: { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
    };
    expect(pageToEvent(page(dated, { in_trash: true }), calendar)).toBeNull();
    expect(pageToEvent(page(dated, { archived: true }), calendar)).toBeNull();
  });

  it('shows only the user\'s rows for "only mine"', () => {
    const mine = { ...calendar, people: { id: 'p1', name: 'Owner', personId: 'user-9' } };
    const row = (people: { id: string }[]) =>
      page({
        Name: title('Standup'),
        When: { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
        Owner: { id: 'p1', type: 'people', people },
      });
    expect(pageToEvent(row([{ id: 'user-2' }, { id: 'user-9' }]), mine)).not.toBeNull();
    expect(pageToEvent(row([{ id: 'user-2' }]), mine)).toBeNull();
    expect(pageToEvent(row([]), mine)).toBeNull();
  });

  it('keeps an empty title empty (the UI shows "Untitled")', () => {
    const event = pageToEvent(
      page({
        Name: { id: 'title', type: 'title', title: [] },
        When: { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
      }),
      calendar,
    );
    expect(event?.title).toBe('');
  });

  it('colours by a select option, but not by "default"', () => {
    const coloured = { ...calendar, colourBy: { id: 's1', name: 'Kind' } };
    const row = (color: string) =>
      page({
        Name: title('Meeting'),
        When: { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
        Kind: { id: 's1', type: 'select', select: { id: 'o1', name: 'Work', color } },
      });
    expect(pageToEvent(row('green'), coloured)?.colour).toBe('green');
    expect(pageToEvent(row('default'), coloured)?.colour).toBeNull();
  });

  it('lists the other properties as text for the panel', () => {
    const event = pageToEvent(
      page({
        Name: title('Plan'),
        When: { id: 'x1', type: 'date', date: { start: '2026-11-24', end: null } },
        Hours: { id: 'n1', type: 'number', number: 3 },
        Done: { id: 'c1', type: 'checkbox', checkbox: false },
        Tags: {
          id: 'm1',
          type: 'multi_select',
          multi_select: [{ name: 'Arm' }, { name: 'Leg' }],
        },
        Notes: { id: 'r1', type: 'rich_text', rich_text: [] },
      }),
      calendar,
    );
    expect(event?.extra).toEqual([
      { name: 'Hours', value: '3' },
      { name: 'Done', value: 'No' },
      { name: 'Tags', value: 'Arm, Leg' },
    ]);
  });
});

describe('property text', () => {
  it('formats the common types', () => {
    expect(propertyText({ id: 'a', type: 'status', status: { name: 'Doing' } })).toBe('Doing');
    expect(
      propertyText({
        id: 'a',
        type: 'date',
        date: { start: '2026-11-24T10:00:00.000+00:00', end: null },
      }),
    ).toBe('2026-11-24 10:00');
    expect(
      propertyText({ id: 'a', type: 'people', people: [{ id: 'u1', name: 'Ada' }, { id: 'u2' }] }),
    ).toBe('Ada, Someone');
    expect(
      propertyText({ id: 'a', type: 'unique_id', unique_id: { prefix: 'TASK', number: 7 } }),
    ).toBe('TASK-7');
    expect(
      propertyText({ id: 'a', type: 'formula', formula: { type: 'number', number: 42 } }),
    ).toBe('42');
    expect(propertyText({ id: 'a', type: 'button', button: {} })).toBe('');
  });
});

describe('edits to properties', () => {
  it('writes times by property id, with no zone', () => {
    expect(
      timeProperties(calendar, {
        allDay: false,
        start: '2026-11-24T10:00',
        end: '2026-11-24T11:00',
        endSet: true,
      }),
    ).toEqual({ x1: { date: { start: '2026-11-24T10:00', end: '2026-11-24T11:00' } } });
  });

  it('writes a title', () => {
    expect(titleProperties(calendar, 'Review')).toEqual({
      title: { title: [{ text: { content: 'Review' } }] },
    });
  });

  it('sets the person on a new row for "only mine"', () => {
    const mine = { ...calendar, people: { id: 'p1', name: 'Owner', personId: 'user-9' } };
    expect(
      newRowProperties(mine, 'Standup', {
        allDay: true,
        start: '2026-11-24',
        end: '2026-11-24',
        endSet: false,
      }),
    ).toEqual({
      title: { title: [{ text: { content: 'Standup' } }] },
      x1: { date: { start: '2026-11-24', end: null } },
      p1: { people: [{ id: 'user-9' }] },
    });
  });
});
