/**
 * Notifications, the tray, keeping running in the tray, and start at login (HANDOFF.md 1 and 3.7).
 * Notifications and the tray menu are recorded by the app in end-to-end mode (CALENDAR_E2E).
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMinutes, nowWall } from '../src/shared/dates';
import { connect, expect, test } from './helpers';

const E2E = { CALENDAR_E2E: '1' };

test('notifies before an event, and offers to snooze when the notification is opened', async ({
  launch,
  seed,
  v1,
}) => {
  const db = await v1.database('Reminders');
  // Starts in 4 minutes: the default reminder (10 minutes before) is due now.
  const start = addMinutes(nowWall(), 4);
  await v1.row(db, 'Standup', { start, end: addMinutes(start, 15) });
  const launched = await launch(E2E);
  await connect(launched, seed.base, seed.integration.token, 'Reminders');
  const { app, window } = launched;

  const notifications = () =>
    app.evaluate(
      () => (globalThis as { __notifications?: { title: string; body: string }[] }).__notifications,
    );
  await expect
    .poll(notifications)
    .toEqual([
      { title: 'Standup', body: expect.stringMatching(/^\d\d:\d\d – \d\d:\d\d · Reminders$/) },
    ]);

  // The tray shows it as the next event.
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __trayMenu?: string[] }).__trayMenu))
    .toEqual(expect.arrayContaining([expect.stringMatching(/^Next: Standup · \d\d:\d\d$/)]));

  // Opening the notification shows the event, with snooze (as the click does).
  const id = await window
    .getByRole('region', { name: 'Calendar' })
    .getByRole('button', { name: /^Standup/ })
    .first()
    .getAttribute('data-event-id');
  await app.evaluate(({ BrowserWindow }, eventId) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('event:show', {
      eventId,
      fromNotification: true,
    });
  }, id);
  const panel = window.getByRole('complementary', { name: 'Event' });
  await expect(panel.getByLabel('Title')).toHaveValue('Standup');
  await panel.getByRole('button', { name: 'Remind me in 5 minutes' }).click();
  await expect(panel).toBeHidden();

  // It's shown once (later syncs don't show it again; a restart doesn't either: see
  // src/main/notifier.test.ts).
  await window.waitForTimeout(500);
  expect(await notifications()).toHaveLength(1);
});

test('quiet calendars send nothing', async ({ launch, seed, v1 }) => {
  const db = await v1.database('Quiet');
  const start = addMinutes(nowWall(), 3);
  await v1.row(db, 'Focus time', { start, end: addMinutes(start, 60) });
  const launched = await launch(E2E);
  await connect(launched, seed.base, seed.integration.token, 'Quiet');
  const { app, window } = launched;
  const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
  // Set to none: a new event starting in a few minutes (which the default, 10 minutes before,
  // would notify about at once) stays silent.
  await sidebar.getByRole('button', { name: 'Quiet options' }).click({ force: true });
  await window.getByRole('menuitemradio', { name: 'None' }).click();
  await v1.row(db, 'Deep work', { start: addMinutes(start, 1), end: addMinutes(start, 30) });
  await sidebar.getByRole('button', { name: 'Sync now' }).click();
  await expect(
    window
      .getByRole('region', { name: 'Calendar' })
      .getByRole('button', { name: /^Deep work/ })
      .first(),
  ).toBeVisible();
  await window.waitForTimeout(500);
  const titles = (
    (await app.evaluate(
      () => (globalThis as { __notifications?: { title: string }[] }).__notifications,
    )) ?? []
  ).map((n) => n.title);
  expect(titles).not.toContain('Deep work');
});

test('keeps running in the tray when closed, and starts at login', async ({ launch }) => {
  const config = mkdtempSync(join(tmpdir(), 'calendar-xdg-'));
  const { app, window } = await launch({ ...E2E, XDG_CONFIG_HOME: config });
  await window.getByRole('button', { name: 'Settings' }).click();
  const settings = window.getByRole('dialog', { name: 'Settings' });
  await settings.getByLabel('Keep running in the tray when the window is closed').check();
  await settings.getByLabel('Start when I log in (in the tray)').check();
  await window.keyboard.press('Escape');

  // Start at login: an autostart entry that starts it in the tray.
  const entry = join(config, 'autostart', 'workspace-calendar.desktop');
  await expect.poll(() => existsSync(entry)).toBe(true);
  expect(readFileSync(entry, 'utf8')).toMatch(/^Exec=".+" --hidden$/m);

  // Closing the window hides it; the app keeps running.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect
    .poll(() =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible())),
    )
    .toEqual([false]);

  // Turning start at login off removes the entry.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.show());
  await window.getByRole('button', { name: 'Settings' }).click();
  await settings.getByLabel('Start when I log in (in the tray)').uncheck();
  await expect.poll(() => existsSync(entry)).toBe(false);
});
