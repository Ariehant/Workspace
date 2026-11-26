/**
 * CalDAV against a real Radicale server (test/radicale.ts): connecting an account and choosing
 * a calendar, its events shown, changes made here reaching the server (a move, one occurrence of
 * a series, a delete after Undo's seconds), and a change made on the server shown here.
 */
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { instantAt } from '../src/shared/zones';
import { startRadicale } from '../test/radicale';
import { expect, test } from './helpers';

const ZONE = 'Asia/Kolkata';
const week = startOfWeek(today(), 1);
const day = (i: number) => addDays(week, i);
const utc = (i: number, hhmm: string) =>
  instantAt(`${day(i)}T${hhmm}`, ZONE)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const ics = (uid: string, lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Another client//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

test('connects a CalDAV account, and changes made here reach the server', async ({ launch }) => {
  const radicale = await startRadicale();
  try {
    const calendar = await radicale.makeCalendar('Lab', { colour: '#9FE1E7FF', id: 'lab' });
    await radicale.put(
      calendar,
      'review.ics',
      ics('review', ['SUMMARY:Review', `DTSTART:${utc(1, '10:00')}`, `DTEND:${utc(1, '11:00')}`]),
    );
    await radicale.put(
      calendar,
      'standup.ics',
      ics('standup', [
        'SUMMARY:Standup',
        `DTSTART:${utc(2, '09:00')}`,
        `DTEND:${utc(2, '09:30')}`,
        'RRULE:FREQ=DAILY;COUNT=3',
      ]),
    );

    const { window } = await launch({ TZ: ZONE });
    await window.getByRole('main').getByRole('button', { name: 'Connect CalDAV' }).click();
    const dialog = window.getByRole('dialog', { name: 'Connect CalDAV' });
    await dialog.getByLabel('Server address').fill(radicale.url);
    await dialog.getByLabel('Username').fill(radicale.username);
    await dialog.getByLabel('App password').fill('wrong');
    await dialog.getByRole('button', { name: 'Connect' }).click();
    await expect(dialog.getByRole('alert')).toContainText('username or app password');
    await dialog.getByLabel('App password').fill(radicale.password);
    await dialog.getByRole('button', { name: 'Connect' }).click();
    const list = dialog.getByRole('list', { name: 'CalDAV calendars' });
    await expect(list.getByRole('checkbox', { name: /Lab/ })).toBeChecked();
    await dialog.getByRole('button', { name: 'Add calendar' }).click();
    await expect(dialog).toBeHidden();

    const grid = window.getByRole('region', { name: 'Calendar' });
    await expect(grid.getByRole('button', { name: /^Review, 10:00/ })).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Standup, 9:00/ })).toHaveCount(3);

    // Moved in the panel: the server has the new time.
    await grid.getByRole('button', { name: /^Review, 10:00/ }).click();
    const panel = window.getByRole('complementary', { name: 'Event' });
    await panel.getByLabel('Starts time').fill('14:00');
    await expect(grid.getByRole('button', { name: /^Review, 2:00 PM – 3:00 PM/ })).toBeVisible();
    await expect
      .poll(async () => (await radicale.get(`${calendar}review.ics`))?.ics)
      .toContain(`DTSTART:${utc(1, '14:00')}`);
    await window.keyboard.press('Escape');

    // One occurrence of the series, renamed: "This event" makes an exception on the server.
    await grid
      .getByRole('button', { name: /^Standup, 9:00/ })
      .nth(1)
      .click();
    await panel.getByLabel('Title').fill('Standup (demo day)');
    await window.keyboard.press('Enter');
    await window
      .getByRole('dialog', { name: 'Change recurring event' })
      .getByRole('button', { name: 'This event' })
      .click();
    await expect(grid.getByRole('button', { name: /^Standup \(demo day\)/ })).toHaveCount(1);
    await expect(grid.getByRole('button', { name: /^Standup, 9:00/ })).toHaveCount(2);
    await expect
      .poll(async () => (await radicale.get(`${calendar}standup.ics`))?.ics)
      .toContain(`RECURRENCE-ID:${utc(3, '09:00')}`);
    await window.keyboard.press('Escape');

    // Deleted here: gone from the server once Undo's few seconds are up.
    await grid.getByRole('button', { name: /^Review/ }).focus();
    await window.keyboard.press('Delete');
    await expect(grid.getByRole('button', { name: /^Review/ })).toHaveCount(0);
    await expect.poll(() => radicale.get(`${calendar}review.ics`), { timeout: 20_000 }).toBeNull();

    // Changed on the server by another client: shown here after a sync.
    await radicale.put(
      calendar,
      'lunch.ics',
      ics('lunch@other', [
        'SUMMARY:Lunch',
        `DTSTART:${utc(4, '13:00')}`,
        `DTEND:${utc(4, '14:00')}`,
      ]),
    );
    await window
      .getByRole('navigation', { name: 'Sidebar' })
      .getByRole('button', { name: 'Sync now' })
      .click();
    await expect(grid.getByRole('button', { name: /^Lunch, 1:00/ })).toBeVisible();
  } finally {
    await radicale.stop();
  }
});
