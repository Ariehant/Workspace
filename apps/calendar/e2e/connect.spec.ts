/**
 * Connecting to a real Workspace server and seeing its rows in the week view; a row changed in
 * Workspace shows within a sync cycle; the cache shows events at once after a restart.
 */
import { addDays, startOfWeek, today } from '../src/shared/dates';
import { seedWorkspace, startTestServer } from '@workspace/server/testing';
import { closeApp, expect, test, V1, type Launched } from './helpers';

const week = startOfWeek(today(), 1);
const day = (i: number) => addDays(week, i);

async function connect({ window }: Launched, server: string, token: string, database: string) {
  await window.getByRole('main').getByRole('button', { name: 'Connect Workspace' }).click();
  const dialog = window.getByRole('dialog', { name: 'Connect Workspace' });
  await dialog.getByLabel('Server address').fill(server);
  await dialog.getByLabel('Integration token').fill(token);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await dialog.getByRole('checkbox', { name: database }).check();
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.getByLabel('Date property')).toHaveValue(/.+/);
  await dialog.getByRole('button', { name: 'Add calendar' }).click();
  await expect(dialog).toBeHidden();
}

test('connects to Workspace and shows its rows in the week', async ({ launch, seed, v1 }) => {
  const db = await v1.database('Team plans');
  await v1.row(db, 'Design review', { start: `${day(1)}T10:00`, end: `${day(1)}T11:30` });
  await v1.row(db, 'Offsite', { start: day(2), end: day(3) });
  await v1.row(db, 'Late call', { start: `${day(3)}T23:00`, end: `${day(4)}T00:30` });

  const launched = await launch();
  const { window } = launched;
  await expect(
    window.getByRole('heading', { name: 'Your Workspace dates, on a calendar' }),
  ).toBeVisible();

  await connect(launched, seed.base, seed.integration.token, 'Team plans');

  const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
  await expect(sidebar.getByText('Team plans')).toBeVisible();
  const grid = window.getByRole('region', { name: 'Calendar' });
  await expect(grid.getByRole('button', { name: /^Design review, 10:00/ })).toBeVisible();
  await expect(grid.getByRole('button', { name: 'Offsite, all day' })).toBeVisible();
  // An event across midnight shows on both days.
  await expect(grid.getByRole('button', { name: /^Late call/ })).toHaveCount(2);
  await expect(sidebar.getByRole('status')).toContainText('Synced');
  if (process.env.CALENDAR_SCREENSHOTS)
    await window.screenshot({ path: `${process.env.CALENDAR_SCREENSHOTS}/week.png` });

  // A wrong token is refused with Workspace's message, before anything is saved.
  await sidebar.getByRole('button', { name: 'Connect another Workspace' }).click();
  const dialog = window.getByRole('dialog', { name: 'Connect Workspace' });
  await dialog.getByLabel('Server address').fill(seed.base);
  await dialog.getByLabel('Integration token').fill('ntn_wrong');
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(dialog.getByRole('alert')).toContainText('token was not accepted');
  await window.keyboard.press('Escape');
});

test('shows rows changed and trashed in Workspace', async ({ launch, seed, v1 }) => {
  const db = await v1.database('Sprint');
  const row = await v1.row(db, 'Planning', { start: `${day(0)}T09:00`, end: `${day(0)}T10:00` });

  const { window, ...launched } = await launch();
  await connect({ window, ...launched }, seed.base, seed.integration.token, 'Sprint');
  const grid = window.getByRole('region', { name: 'Calendar' });
  await expect(grid.getByRole('button', { name: /^Planning, 9:00/ })).toBeVisible();

  // Edited in Workspace: renamed and moved. The calendar shows it within a sync cycle.
  await v1.call('PATCH', `/pages/${row}`, {
    properties: {
      Name: { title: [{ text: { content: 'Sprint planning' } }] },
      When: { date: { start: `${day(2)}T14:00`, end: `${day(2)}T15:00` } },
    },
  });
  await expect(grid.getByRole('button', { name: /^Sprint planning, 2:00/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(grid.getByRole('button', { name: /^Planning,/ })).toHaveCount(0);

  // Trashed in Workspace: trashed rows just stop coming back, so it goes on the next sweep,
  // which "Sync now" runs.
  await v1.call('PATCH', `/pages/${row}`, { in_trash: true });
  const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByRole('button', { name: 'Sync now' }).click();
  await expect(grid.getByRole('button', { name: /^Sprint planning/ })).toHaveCount(0);
  await expect(sidebar.getByText('Sprint')).toBeVisible();
});

test('shows the saved week offline, after a restart with the server gone', async ({ launch }) => {
  test.setTimeout(180_000);
  // A server of this test's own, to stop.
  const own = await startTestServer();
  try {
    const seed = await seedWorkspace(own.base, 'Cy');
    const v1 = new V1(seed);
    const db = await v1.database('Field work');
    await v1.row(db, 'Site visit', { start: `${day(1)}T08:00`, end: `${day(1)}T12:00` });

    const first = await launch();
    await connect(first, seed.base, seed.integration.token, 'Field work');
    await expect(
      first.window
        .getByRole('region', { name: 'Calendar' })
        .getByRole('button', { name: /^Site visit/ }),
    ).toBeVisible();
    await closeApp(first.app);
    await own.stop();

    const again = await launch();
    const sidebar = again.window.getByRole('navigation', { name: 'Sidebar' });
    await expect(sidebar.getByRole('status')).toContainText('Offline: showing saved events');
    await expect(
      again.window
        .getByRole('region', { name: 'Calendar' })
        .getByRole('button', { name: /^Site visit, 8:00/ }),
    ).toBeVisible();
  } finally {
    await own.stop();
  }
});

test('moves between weeks with the toolbar, the mini calendar and the keyboard', async ({
  launch,
  seed,
  v1,
}) => {
  const db = await v1.database('Later');
  await v1.row(db, 'Next week thing', { start: `${addDays(week, 9)}T12:00` });
  const launched = await launch();
  await connect(launched, seed.base, seed.integration.token, 'Later');
  const { window } = launched;
  const grid = window.getByRole('region', { name: 'Calendar' });
  await expect(grid.getByRole('button', { name: /^Next week thing/ })).toHaveCount(0);

  await window.getByRole('button', { name: 'Next week' }).click();
  await expect(grid.getByRole('button', { name: /^Next week thing, 12:00/ })).toBeVisible();
  await window.keyboard.press('k');
  await expect(grid.getByRole('button', { name: /^Next week thing/ })).toHaveCount(0);
  await window.keyboard.press('j');
  await expect(grid.getByRole('button', { name: /^Next week thing/ })).toBeVisible();
  await window.keyboard.press('t');
  await expect(grid.getByRole('button', { name: /^Next week thing/ })).toHaveCount(0);

  await window.getByRole('button', { name: 'Next month' }).click();
  await window.getByRole('button', { name: 'Previous month' }).click();
  await expect(window.getByRole('group', { name: 'Mini calendar' })).toBeVisible();
});
