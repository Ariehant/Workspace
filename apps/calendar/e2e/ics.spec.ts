/**
 * Subscribing to an iCalendar feed (a fake feed server, test/fake-ics.ts): the feed's events
 * show read-only beside nothing else, a change published to the feed shows after Sync now, and
 * an address that isn't a calendar is refused.
 */
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { feedWith, startFakeFeeds } from '../test/fake-ics';
import { expect, test } from './helpers';

const week = startOfWeek(today(), 1);
const day = (i: number) => addDays(week, i);

test('subscribes to a calendar feed and follows its changes', async ({ launch }) => {
  const feeds = await startFakeFeeds();
  try {
    feeds.feeds.set(
      '/holidays.ics',
      feedWith(
        [
          { uid: 'h1@holidays.example', summary: 'Founders Day', start: day(2) },
          { uid: 'h2', summary: 'Team offsite', start: `${day(3)}T10:00`, end: `${day(3)}T12:00` },
        ],
        'Lab holidays',
      ),
    );
    feeds.feeds.set('/page.html', '<!doctype html><title>Not a calendar</title>');

    const { window } = await launch({ TZ: 'Asia/Kolkata' });
    await window.getByRole('main').getByRole('button', { name: 'Subscribe to a calendar' }).click();
    const dialog = window.getByRole('dialog', { name: 'Subscribe to a calendar' });

    // Not a calendar: refused, nothing added.
    await dialog.getByLabel('Calendar address').fill(`${feeds.origin}/page.html`);
    await dialog.getByRole('button', { name: 'Subscribe' }).click();
    await expect(dialog.getByRole('alert')).toContainText("isn't a calendar");

    await dialog.getByLabel('Calendar address').fill(`${feeds.origin}/holidays.ics`);
    await dialog.getByRole('button', { name: 'Subscribe' }).click();
    await expect(dialog).toBeHidden();

    const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
    await expect(sidebar.getByRole('region', { name: 'Subscriptions' })).toContainText(
      'Lab holidays',
    );
    const grid = window.getByRole('region', { name: 'Calendar' });
    await expect(grid.getByRole('button', { name: 'Founders Day, all day' })).toBeVisible();
    // A floating time shows as written.
    await expect(grid.getByRole('button', { name: /^Team offsite, 10:00/ })).toBeVisible();

    // Read-only: no Delete in the panel, and the title can't be changed.
    await grid.getByRole('button', { name: /^Team offsite/ }).click();
    const panel = window.getByRole('complementary', { name: 'Event' });
    await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(panel.getByLabel('Title')).toHaveAttribute('readonly', '');
    await window.keyboard.press('Escape');

    // Published again: Sync now reads it (a refresh that only asks for changes otherwise).
    feeds.feeds.set(
      '/holidays.ics',
      feedWith(
        [{ uid: 'h1@holidays.example', summary: 'Founders Day (observed)', start: day(4) }],
        'Lab holidays',
      ),
    );
    await sidebar.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      grid.getByRole('button', { name: 'Founders Day (observed), all day' }),
    ).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Team offsite/ })).toHaveCount(0);
  } finally {
    await feeds.close();
  }
});
