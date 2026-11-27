/**
 * Phase 8 N6 (#26): Home. The pages visited last, the reminders still to come and the pages
 * edited last, each opening its page.
 */
import type { Page } from '@playwright/test';
import { editor, expect, test, waitForIndexed } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
}

test('home: recently visited, upcoming reminders, recently edited', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Wrist joint');
  await window.keyboard.type('Range of motion.');
  await newPage(window, 'Gripper');
  await window.keyboard.type('Order servos @remind tomorrow');
  await expect(window.getByTestId('mention-menu').getByRole('option').first()).toHaveText(
    /Remind me/,
  );
  await window.keyboard.press('Enter');
  await waitForIndexed(window, 'servos');

  const homeButton = window.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', {
    name: 'Home',
  });
  await homeButton.click();
  const home = window.getByTestId('home');
  await expect(home).toBeVisible();
  await expect(homeButton).toHaveAttribute('aria-current', 'page');
  await expect(home.getByRole('heading', { level: 1 })).toHaveText(
    /^Good (morning|afternoon|evening)/,
  );
  await expect(home.getByTestId('home-recent-page')).toHaveText([
    /Gripper/,
    /Wrist joint/,
    /Getting started/,
  ]);
  const reminder = home.getByTestId('home-reminder');
  await expect(reminder).toHaveCount(1);
  await expect(reminder).toHaveText(/^Tomorrow .*Order servos.*Gripper$/);
  await expect(home.getByTestId('home-edited-page').first()).toHaveText(/^Gripper/);

  // A card opens its page; Back from Home is the page it was opened over.
  await home.getByTestId('home-recent-page').filter({ hasText: 'Wrist joint' }).click();
  await expect(home).toBeHidden();
  await expect(window.getByLabel('Page title')).toHaveValue('Wrist joint');
  await expect(homeButton).not.toHaveAttribute('aria-current');
  await homeButton.click();
  await expect(home).toBeVisible();
  await window.getByRole('button', { name: 'Go back (Alt+←)' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Wrist joint');

  // A reminder opens its page.
  await homeButton.click();
  await reminder.click();
  await expect(window.getByLabel('Page title')).toHaveValue('Gripper');
  await expect(editor(window).getByTestId('mention')).toHaveText('@Tomorrow');
});

test('people: you, the pages you made, and opening one', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Wrist joint');
  await newPage(window, 'Gripper');

  const peopleButton = window.getByRole('navigation', { name: 'Sidebar' }).getByRole('button', {
    name: 'People',
  });
  await peopleButton.click();
  const people = window.getByTestId('people');
  await expect(people).toBeVisible();
  await expect(peopleButton).toHaveAttribute('aria-current', 'page');
  const person = people.getByTestId('person');
  await expect(person).toHaveCount(1);
  await expect(person).toContainText('(you)');
  await expect(person).toHaveAttribute('aria-pressed', 'true');
  // A local workspace has no roles or emails.
  await expect(people.getByTestId('person-role')).toHaveCount(0);

  // Newest first.
  const pages = people.getByTestId('person-page');
  await expect(pages).toHaveText([/Gripper/, /Wrist joint/]);
  await pages.filter({ hasText: 'Wrist joint' }).click();
  await expect(people).toBeHidden();
  await expect(window.getByLabel('Page title')).toHaveValue('Wrist joint');
  await expect(peopleButton).not.toHaveAttribute('aria-current', 'page');

  // People again: Back is the page it was opened over.
  await peopleButton.click();
  await window.getByRole('button', { name: 'Go back (Alt+←)' }).click();
  await expect(people).toBeHidden();
  await expect(window.getByLabel('Page title')).toHaveValue('Wrist joint');
});

test('meetings: a new meeting note is a dated row of a Meetings database, listed as upcoming', async ({
  launch,
}) => {
  const { window } = await launch();
  const sidebar = window.getByRole('navigation', { name: 'Sidebar' });
  await sidebar.getByRole('button', { name: 'Meetings' }).click();
  const meetings = window.getByTestId('meetings');
  await expect(meetings).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Meetings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(meetings.getByText('No upcoming events in the next two weeks.')).toBeVisible();

  // The note opens as a row page, with the meeting template.
  await meetings.getByRole('button', { name: 'New meeting note' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Meeting notes');
  await expect(editor(window)).toContainText('Agenda');
  await expect(editor(window)).toContainText('Action items');
  // The Meetings database is in the sidebar.
  await expect(
    window.getByRole('tree', { name: 'Pages' }).getByTestId('sidebar-row').filter({
      hasText: 'Meetings',
    }),
  ).toBeVisible();

  // Back in Meetings, it's coming up (within the next half hour).
  await sidebar.getByRole('button', { name: 'Meetings' }).click();
  const event = meetings.getByTestId('meetings-event').filter({ hasText: 'Meeting notes' });
  await expect(event).toBeVisible({ timeout: 15_000 });
  await expect(event).toContainText('Meetings');
  await expect(meetings.getByTestId('meetings-day').first()).toHaveText(/Today|Tomorrow/);

  // A second note makes a second row in the same database; Home lists them too.
  await meetings.getByRole('button', { name: 'New meeting note' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Meeting notes');
  await sidebar.getByRole('button', { name: 'Home' }).click();
  await expect(window.getByTestId('home-event')).toHaveCount(2, { timeout: 15_000 });
  await expect(
    window.getByRole('tree', { name: 'Pages' }).getByTestId('sidebar-row').filter({
      hasText: 'Meetings',
    }),
  ).toHaveCount(1);

  // Opening one from Home opens its page.
  await window.getByTestId('home-event').first().click();
  await expect(window.getByLabel('Page title')).toHaveValue('Meeting notes');
});
