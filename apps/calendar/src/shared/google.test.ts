import { describe, expect, it } from 'vitest';
import { deriveEvents, meetLinkOf, occurrenceKey, type GoogleEvent } from './google';
import type { GoogleCalendar } from './types';

const calendar: GoogleCalendar = {
  id: 'g1',
  kind: 'google',
  accountId: 'acc',
  googleId: 'ada@example.com',
  accessRole: 'owner',
  timeZone: 'Europe/Berlin',
  name: 'Ada',
  colour: '#9fe1e7',
  visible: true,
  status: 'ok',
  statusMessage: null,
};

const window = { from: '2026-11-01', to: '2026-12-31' };
const derive = (items: GoogleEvent[], zone = 'Asia/Kolkata', cal = calendar) =>
  deriveEvents(cal, items, window, zone);

describe('Google events', () => {
  it('shows a timed event at this machine\'s clock time for it', () => {
    const [event] = derive([
      {
        id: 'e1',
        etag: '"1"',
        summary: 'Review',
        start: { dateTime: '2026-11-24T10:00:00+01:00', timeZone: 'Europe/Berlin' },
        end: { dateTime: '2026-11-24T11:30:00+01:00', timeZone: 'Europe/Berlin' },
        updated: '2026-11-20T08:00:00.000Z',
        htmlLink: 'https://www.google.com/calendar/event?eid=x',
        location: 'Room 4',
        description: 'Agenda:<br>one &amp; two',
      },
    ]);
    expect(event).toEqual({
      id: 'g1:e1',
      calendarId: 'g1',
      sourceId: 'e1',
      title: 'Review',
      allDay: false,
      start: '2026-11-24T14:30',
      end: '2026-11-24T16:00',
      endSet: true,
      floating: false,
      url: 'https://www.google.com/calendar/event?eid=x',
      colour: null,
      extra: [
        { name: 'Location', value: 'Room 4' },
        { name: 'Description', value: 'Agenda:\none & two' },
      ],
      lastEdited: '2026-11-20T08:00:00.000Z',
      instant: { start: '2026-11-24T09:00:00.000Z', end: '2026-11-24T10:30:00.000Z' },
      timeZone: 'Europe/Berlin',
      etag: '"1"',
      meetLink: null,
    });
  });

  it('reads all-day events, whose end Google gives as the day after', () => {
    const [event] = derive([
      { id: 'e2', summary: 'Offsite', start: { date: '2026-12-02' }, end: { date: '2026-12-05' } },
    ]);
    expect(event).toMatchObject({ allDay: true, start: '2026-12-02', end: '2026-12-04' });
    expect(event!.instant).toBeUndefined();
  });

  it('leaves out cancelled events and events outside the window', () => {
    expect(
      derive([
        { id: 'c', status: 'cancelled' },
        { id: 'old', summary: 'Old', start: { date: '2025-01-01' }, end: { date: '2025-01-02' } },
      ]),
    ).toEqual([]);
  });

  it('names events without a title, and busy blocks on free/busy calendars', () => {
    const item = { id: 'e', start: { date: '2026-11-24' }, end: { date: '2026-11-25' } };
    expect(derive([item])[0]!.title).toBe('(No title)');
    expect(derive([item], 'UTC', { ...calendar, accessRole: 'freeBusyReader' })[0]!.title).toBe(
      'Busy',
    );
  });

  it('finds the Meet link', () => {
    expect(meetLinkOf({ id: 'a', hangoutLink: 'https://meet.google.com/abc-defg-hij' })).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(
      meetLinkOf({
        id: 'b',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555' },
            { entryPointType: 'video', uri: 'https://meet.google.com/xyz' },
          ],
        },
      }),
    ).toBe('https://meet.google.com/xyz');
    expect(meetLinkOf({ id: 'c', hangoutLink: 'javascript:alert(1)' })).toBeNull();
  });

  it('keys occurrences by their original start', () => {
    expect(occurrenceKey({ dateTime: '2026-11-25T09:00:00+01:00' })).toBe(
      '2026-11-25T08:00:00.000Z',
    );
    expect(occurrenceKey({ date: '2026-11-25' })).toBe('2026-11-25');
  });
});

describe('recurring Google events', () => {
  const master: GoogleEvent = {
    id: 'standup',
    summary: 'Standup',
    start: { dateTime: '2026-11-23T09:00:00+01:00', timeZone: 'Europe/Berlin' },
    end: { dateTime: '2026-11-23T09:15:00+01:00', timeZone: 'Europe/Berlin' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=4'],
    updated: '2026-11-20T00:00:00.000Z',
  };

  it('expands a series into occurrences with ids like Google\'s', () => {
    const events = derive([master], 'Europe/Berlin');
    expect(events.map((e) => [e.sourceId, e.start, e.end])).toEqual([
      ['standup_20261123T080000Z', '2026-11-23T09:00', '2026-11-23T09:15'],
      ['standup_20261124T080000Z', '2026-11-24T09:00', '2026-11-24T09:15'],
      ['standup_20261125T080000Z', '2026-11-25T09:00', '2026-11-25T09:15'],
      ['standup_20261126T080000Z', '2026-11-26T09:00', '2026-11-26T09:15'],
    ]);
    expect(events[1]!.series).toEqual({ id: 'standup', originalStart: '2026-11-24T08:00:00.000Z' });
  });

  it('replaces changed occurrences and drops cancelled ones', () => {
    const moved: GoogleEvent = {
      id: 'standup_20261124T080000Z',
      recurringEventId: 'standup',
      originalStartTime: { dateTime: '2026-11-24T09:00:00+01:00', timeZone: 'Europe/Berlin' },
      summary: 'Standup (late)',
      start: { dateTime: '2026-11-24T11:00:00+01:00' },
      end: { dateTime: '2026-11-24T11:15:00+01:00' },
    };
    const cancelled: GoogleEvent = {
      id: 'standup_20261125T080000Z',
      recurringEventId: 'standup',
      originalStartTime: { dateTime: '2026-11-25T08:00:00Z' },
      status: 'cancelled',
    };
    const events = derive([master, moved, cancelled], 'Europe/Berlin');
    expect(events.map((e) => [e.title, e.start]).sort()).toEqual([
      ['Standup (late)', '2026-11-24T11:00'],
      ['Standup', '2026-11-23T09:00'],
      ['Standup', '2026-11-26T09:00'],
    ]);
    expect(events.find((e) => e.title === 'Standup (late)')!.series).toEqual({
      id: 'standup',
      originalStart: '2026-11-24T08:00:00.000Z',
    });
  });

  it('shows an occurrence whose series it doesn\'t have', () => {
    const [event] = derive(
      [
        {
          id: 'theirs_20261130T100000Z',
          recurringEventId: 'theirs',
          originalStartTime: { dateTime: '2026-11-30T10:00:00Z' },
          summary: 'Invited once',
          start: { dateTime: '2026-11-30T10:00:00Z' },
          end: { dateTime: '2026-11-30T11:00:00Z' },
        },
      ],
      'UTC',
    );
    expect(event).toMatchObject({ title: 'Invited once', series: { id: 'theirs' } });
  });

  it('repeats in the series\' zone and shows at this machine\'s clock', () => {
    // 09:00 in Berlin; Berlin moves its clocks on 2026-10-25, India doesn't.
    const series: GoogleEvent = {
      ...master,
      start: { dateTime: '2026-10-19T09:00:00+02:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-10-19T10:00:00+02:00', timeZone: 'Europe/Berlin' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
    };
    const events = deriveEvents(calendar, [series], { from: '2026-10-01', to: '2026-11-30' }, 'Asia/Kolkata');
    expect(events.map((e) => e.start)).toEqual([
      '2026-10-19T12:30',
      '2026-10-26T13:30',
      '2026-11-02T13:30',
      '2026-11-09T13:30',
    ]);
  });

  it('expands all-day series', () => {
    const events = derive(
      [
        {
          id: 'bins',
          summary: 'Bins',
          start: { date: '2026-11-02' },
          end: { date: '2026-11-03' },
          recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261116'],
        },
      ],
      'UTC',
    );
    expect(events.map((e) => [e.sourceId, e.start, e.end])).toEqual([
      ['bins_20261102', '2026-11-02', '2026-11-02'],
      ['bins_20261109', '2026-11-09', '2026-11-09'],
      ['bins_20261116', '2026-11-16', '2026-11-16'],
    ]);
  });
});
