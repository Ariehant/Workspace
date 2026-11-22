import { afterEach, describe, expect, it } from 'vitest';
import { nowWall } from '../shared/dates';
import type { Account, CalEvent, Calendar } from '../shared/types';
import { Cache } from './cache';
import { Notifier, SNOOZE_MS } from './notifier';

const account: Account = {
  id: 'acc',
  kind: 'workspace',
  name: 'Lab',
  server: 'https://notes.test',
  botId: 'bot',
  error: null,
};

const calendar: Calendar = {
  id: 'cal',
  accountId: 'acc',
  databaseId: 'db',
  viewId: null,
  name: 'Tasks',
  colour: 'blue',
  visible: true,
  dateProperty: { id: 'x1', name: 'When' },
  titleProperty: { id: 'title', name: 'Name' },
  people: null,
  colourBy: null,
  reminder: 10,
  status: 'ok',
  statusMessage: null,
};

const event = (id: string, start: string, end: string): CalEvent => ({
  id: `cal:${id}`,
  calendarId: 'cal',
  sourceId: id,
  title: id,
  allDay: false,
  start,
  end,
  endSet: true,
  floating: true,
  url: null,
  colour: null,
  extra: [],
  lastEdited: '',
});

const notifiers: Notifier[] = [];
afterEach(() => notifiers.splice(0).forEach((n) => n.stop()));

function setup(nowMs: number) {
  const cache = new Cache(':memory:');
  cache.addAccount(account, 'x');
  cache.addCalendar(calendar);
  let now = nowMs;
  const shown: string[] = [];
  const notifier = new Notifier({
    cache,
    now: () => now,
    show: (r, _c, snoozed) => shown.push(`${snoozed ? 'snoozed ' : ''}${r.event.title}`),
  });
  notifiers.push(notifier);
  return { cache, notifier, shown, advance: (ms: number) => (now += ms) };
}

describe('the notifier', () => {
  // Today at 10:00 local time.
  const base = new Date();
  base.setHours(10, 0, 0, 0);
  const at = (minutes: number) => nowWall(new Date(base.getTime() + minutes * 60_000));

  it('shows a reminder once, not again after a restart', () => {
    const s = setup(base.getTime());
    s.cache.replaceEvents('cal', [event('Standup', at(5), at(20))]);
    s.notifier.check();
    expect(s.shown).toEqual(['Standup']);
    s.notifier.check();
    expect(s.shown).toEqual(['Standup']);
    // A new notifier on the same cache (the app restarted) remembers.
    const again = new Notifier({
      cache: s.cache,
      now: () => base.getTime(),
      show: () => s.shown.push('again'),
    });
    notifiers.push(again);
    again.check();
    expect(s.shown).toEqual(['Standup']);
  });

  it('waits for a reminder that is not due yet', () => {
    const s = setup(base.getTime());
    s.cache.replaceEvents('cal', [event('Review', at(30), at(60))]);
    s.notifier.check();
    expect(s.shown).toEqual([]);
    s.advance(20 * 60_000);
    s.notifier.check();
    expect(s.shown).toEqual(['Review']);
  });

  it('reminds again after a snooze', () => {
    const s = setup(base.getTime());
    s.cache.replaceEvents('cal', [event('Call', at(5), at(30))]);
    s.notifier.check();
    s.notifier.snooze('cal:Call');
    expect(s.shown).toEqual(['Call']);
    s.advance(SNOOZE_MS);
    s.notifier.check();
    expect(s.shown).toEqual(['Call', 'snoozed Call']);
  });

  it('shows nothing for a calendar with no reminders', () => {
    const s = setup(base.getTime());
    s.cache.updateCalendar({ ...calendar, reminder: null });
    s.cache.replaceEvents('cal', [event('Quiet', at(5), at(20))]);
    s.notifier.check();
    expect(s.shown).toEqual([]);
  });
});
