/**
 * Google Calendar against a fake Google (test/fake-google.ts): setting up the OAuth client,
 * signing in (the "browser" follows Google's redirect back to the app), choosing calendars,
 * Google events (a series among them) beside Workspace's, changes made in Google, an access
 * token that stops working, and a restart.
 */
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { instantAt } from '../src/shared/zones';
import { googleEnv, startFakeGoogle } from '../test/fake-google';
import { closeApp, connect, expect, test } from './helpers';

const ZONE = 'Asia/Kolkata';
const week = startOfWeek(today(), 1);
const day = (i: number) => addDays(week, i);
const at = (i: number, hhmm: string, zone = ZONE) => ({
  dateTime: instantAt(`${day(i)}T${hhmm}`, zone).toISOString(),
  timeZone: zone,
});

test('signs in to Google and shows its events beside Workspace rows', async ({
  launch,
  seed,
  v1,
}) => {
  const fake = await startFakeGoogle();
  try {
    fake.addCalendar({
      id: 'ada@lab.io',
      summary: 'Ada',
      accessRole: 'owner',
      timeZone: ZONE,
      backgroundColor: '#7bd148',
      primary: true,
    });
    fake.addCalendar({
      id: 'team@group.calendar.google.com',
      summary: 'Team',
      accessRole: 'reader',
    });
    // An event made in Berlin: it shows at this computer's (Kolkata's) time for it.
    fake.put('ada@lab.io', {
      id: 'review',
      summary: 'Design review',
      start: at(1, '10:00', 'Europe/Berlin'),
      end: at(1, '11:00', 'Europe/Berlin'),
      location: 'Room 4',
    });
    fake.put('ada@lab.io', {
      id: 'standup',
      summary: 'Standup',
      start: at(2, '09:00'),
      end: at(2, '09:15'),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
    });
    // The series' second occurrence moved to 11:00.
    fake.put('ada@lab.io', {
      id: 'standup_moved',
      recurringEventId: 'standup',
      originalStartTime: at(3, '09:00'),
      summary: 'Standup',
      start: at(3, '11:00'),
      end: at(3, '11:15'),
    });
    const db = await v1.database('Beside Google');
    await v1.row(db, 'Offsite', { start: day(2) });

    // The fake's endpoints, but no client: the dialog asks for it.
    const {
      CALENDAR_GOOGLE_CLIENT_ID: _id,
      CALENDAR_GOOGLE_CLIENT_SECRET: _s,
      ...endpoints
    } = googleEnv(fake);
    const env = { ...endpoints, TZ: ZONE };
    const launched = await launch(env);
    const { window } = launched;
    await connect(launched, seed.base, seed.integration.token, 'Beside Google');

    const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
    await sidebar.getByRole('button', { name: 'Connect Google Calendar' }).click();
    const dialog = window.getByRole('dialog', { name: 'Connect Google Calendar' });
    await dialog.getByLabel('OAuth client ID').fill(fake.clientId);
    await dialog.getByLabel('Client secret').fill(fake.clientSecret);
    await dialog.getByRole('button', { name: 'Save client' }).click();
    await dialog.getByRole('button', { name: 'Sign in with Google' }).click();
    await expect(dialog.getByText('Signed in as')).toContainText('ada@lab.io');
    const list = dialog.getByRole('list', { name: 'Google calendars' });
    await expect(list.getByRole('checkbox', { name: /Ada/ })).toBeChecked();
    await list.getByRole('checkbox', { name: /Team/ }).check();
    await dialog.getByRole('button', { name: 'Add 2 calendars' }).click();
    await expect(dialog).toBeHidden();

    await expect(sidebar.getByRole('region', { name: 'ada@lab.io' })).toBeVisible();
    const grid = window.getByRole('region', { name: 'Calendar' });
    // 10:00 in Berlin (UTC+1) is 14:30 in Kolkata.
    await expect(grid.getByRole('button', { name: /^Design review, 2:30/ })).toBeVisible();
    await expect(grid.getByRole('button', { name: /^Standup, 9:00/ })).toHaveCount(2);
    await expect(grid.getByRole('button', { name: /^Standup, 11:00/ })).toHaveCount(1);
    await expect(grid.getByRole('button', { name: 'Offsite, all day' })).toBeVisible();

    // Google's events open with a link to Google (and can be changed: the account owns this one).
    await grid.getByRole('button', { name: /^Design review/ }).click();
    const panel = window.getByRole('complementary', { name: 'Event' });
    await expect(panel.getByRole('button', { name: 'Open in Google Calendar' })).toBeVisible();
    await expect(panel.getByText('Room 4')).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Delete' })).toBeVisible();
    await window.keyboard.press('Escape');

    // Changed in Google: it shows within a sync cycle (Google's sync token, not a full read).
    fake.put('ada@lab.io', {
      id: 'review',
      summary: 'Design review (moved)',
      start: at(4, '10:00'),
      end: at(4, '11:00'),
    });
    await expect(
      grid.getByRole('button', { name: /^Design review \(moved\), 10:00/ }),
    ).toBeVisible();
    expect(fake.requests.some((r) => r.includes('syncToken='))).toBe(true);

    // An hour later, the access token stops working: the app refreshes it and carries on.
    fake.expireTokens();
    const refreshes = fake.grants.filter((g) => g === 'refresh_token').length;
    fake.put('ada@lab.io', {
      id: 'lunch',
      summary: 'Lunch',
      start: at(0, '13:00'),
      end: at(0, '14:00'),
    });
    await expect(grid.getByRole('button', { name: /^Lunch, 1:00/ })).toBeVisible();
    expect(fake.grants.filter((g) => g === 'refresh_token').length).toBeGreaterThan(refreshes);
    await expect(sidebar.getByRole('alert')).toHaveCount(0);

    // After a restart, Google's events show at once, and the sign-in still works.
    await closeApp(launched.app);
    const again = await launch(env);
    const grid2 = again.window.getByRole('region', { name: 'Calendar' });
    await expect(grid2.getByRole('button', { name: /^Lunch, 1:00/ })).toBeVisible();
    fake.put('ada@lab.io', {
      id: 'late',
      summary: 'Late one',
      start: at(0, '20:00'),
      end: at(0, '21:00'),
    });
    await expect(grid2.getByRole('button', { name: /^Late one/ })).toBeVisible();
  } finally {
    await fake.close();
  }
});

/** The grid's hour height (`HOUR_PX` in src/renderer/week.tsx). */
const HOUR_PX = 48;

test('changes Google events, recurring ones by the occurrences chosen, and joins Meet', async ({
  launch,
}) => {
  const fake = await startFakeGoogle();
  try {
    fake.addCalendar({
      id: 'bea@lab.io',
      summary: 'Bea',
      accessRole: 'owner',
      timeZone: ZONE,
      primary: true,
    });
    fake.addCalendar({ id: 'team@lab.io', summary: 'Team', accessRole: 'reader', timeZone: ZONE });
    fake.put('bea@lab.io', {
      id: 'sync',
      summary: 'Sync',
      start: at(1, '09:00'),
      end: at(1, '10:00'),
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    });
    fake.put('bea@lab.io', {
      id: 'standup',
      summary: 'Standup',
      start: at(2, '09:00'),
      end: at(2, '09:30'),
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
    });
    fake.put('team@lab.io', {
      id: 'all',
      summary: 'All hands',
      start: at(0, '16:00'),
      end: at(0, '17:00'),
    });
    const events = () => [...fake.calendars.get('bea@lab.io')!.events.values()].map((s) => s.event);

    const launched = await launch({ ...googleEnv(fake), TZ: ZONE });
    const { app, window } = launched;
    await window.getByRole('main').getByRole('button', { name: 'Connect Google Calendar' }).click();
    const dialog = window.getByRole('dialog', { name: 'Connect Google Calendar' });
    await dialog.getByRole('button', { name: 'Sign in with Google' }).click();
    await dialog
      .getByRole('list', { name: 'Google calendars' })
      .getByRole('checkbox', { name: /Team/ })
      .check();
    await dialog.getByRole('button', { name: 'Add 2 calendars' }).click();
    await expect(dialog).toBeHidden();
    const grid = window.getByRole('region', { name: 'Calendar' });
    await expect(grid.getByRole('button', { name: /^Sync, 9:00/ })).toBeVisible();
    await window.getByTestId('time-grid').evaluate((el, px) => (el.scrollTop = px), 8 * HOUR_PX);

    // Join Google Meet opens the call in the browser.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        (globalThis as { __opened?: string }).__opened = url;
      };
    });
    await grid.getByRole('button', { name: /^Sync, 9:00/ }).click();
    const panel = window.getByRole('complementary', { name: 'Event' });
    await panel.getByRole('button', { name: 'Join Google Meet' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string }).__opened))
      .toBe('https://meet.google.com/abc-defg-hij');

    // Rename and move in the panel: Google gets the instant shown here.
    await panel.getByLabel('Title').fill('Weekly sync');
    await window.keyboard.press('Enter');
    await panel.getByLabel('Starts time').fill('11:00');
    await expect(
      grid.getByRole('button', { name: /^Weekly sync, 11:00 AM – 12:00 PM/ }),
    ).toBeVisible();
    await expect
      .poll(() => events().find((e) => e.id === 'sync'))
      .toMatchObject({ summary: 'Weekly sync', start: { dateTime: at(1, '11:00').dateTime } });
    await window.keyboard.press('Escape');

    // One occurrence of the series moved: "This event" changes only that one in Google.
    const second = grid.getByRole('button', { name: /^Standup, 9:00/ }).nth(1);
    const box = (await second.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + 8);
    await window.mouse.down();
    await window.mouse.move(box.x + box.width / 2, box.y + 8 + HOUR_PX, { steps: 12 });
    await window.mouse.up();
    const scope = window.getByRole('dialog', { name: 'Change recurring event' });
    await scope.getByRole('button', { name: 'This event' }).click();
    await expect(grid.getByRole('button', { name: /^Standup, 10:00/ })).toHaveCount(1);
    await expect(grid.getByRole('button', { name: /^Standup, 9:00/ })).toHaveCount(2);
    await expect
      .poll(() =>
        events()
          .filter((e) => e.recurringEventId === 'standup')
          .map((e) => e.start?.dateTime),
      )
      .toEqual([at(3, '10:00').dateTime]);

    // Delete the series ("All events"): gone here, and in Google once Undo's seconds are up.
    await grid
      .getByRole('button', { name: /^Standup, 9:00/ })
      .first()
      .click();
    await panel.getByRole('button', { name: 'Delete' }).click();
    await window
      .getByRole('dialog', { name: 'Delete recurring event' })
      .getByRole('button', { name: 'All events' })
      .click();
    await expect(grid.getByRole('button', { name: /^Standup/ })).toHaveCount(0);
    await expect
      .poll(() => events().find((e) => e.id === 'standup')?.status, { timeout: 15_000 })
      .toBe('cancelled');

    // A calendar the account may only see: no Delete, and the title can't be changed.
    await grid.getByRole('button', { name: /^All hands/ }).click();
    await expect(panel.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await expect(panel.getByLabel('Title')).toHaveAttribute('readonly', '');
  } finally {
    await fake.close();
  }
});
