import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startServer, type TestServer } from './server';

test.describe.configure({ mode: 'serial' });

/** Set WORKSPACE_SHOTS=<dir> to save screenshots. */
const shotsDir = process.env.WORKSPACE_SHOTS;
let server: TestServer;

// Invite-only, like a real team server: Bob can only sign up through Ada's invite.
test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startServer({ SIGNUP: 'invite' });
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
});
test.afterAll(async () => {
  await server?.stop();
});

async function shot(page: Page, name: string) {
  if (!shotsDir) return;
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(shotsDir, `${name}.png`) });
}

const editor = (page: Page) => page.getByTestId('page-editor');
const sidebarTitles = (page: Page) => page.getByTestId('sidebar-page-title');
const dialog = (page: Page) => page.getByTestId('members-dialog');
const memberRows = (page: Page) => dialog(page).getByTestId('member-row');
const table = (page: Page) => page.getByTestId('table-view');

/** The cell of row `rowTitle` under column `column`. */
async function cell(page: Page, rowTitle: string, column: string): Promise<Locator> {
  const headers = await table(page).getByTestId('column-header').allInnerTexts();
  const index = headers.findIndex((h) => h.trim() === column);
  expect(index, `column ${column}`).toBeGreaterThanOrEqual(0);
  return table(page)
    .getByTestId('table-row')
    .filter({ has: page.getByTestId('row-title').getByText(rowTitle, { exact: true }) })
    .getByTestId('table-cell')
    .nth(index);
}

/** A tiny PNG (a blue square), as a file to upload. */
async function picture(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 120;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#2383e2';
    g.fillRect(0, 0, 120, 120);
    g.fillStyle = '#ffffff';
    g.font = 'bold 64px sans-serif';
    g.fillText('A', 38, 84);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(base64, 'base64');
}

test('the owner invites a teammate, who joins from the link and can be mentioned', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ada = await browser.newPage();
  ada.on('pageerror', (error) => console.error(`[ada] ${error.stack ?? error}`));

  // Ada: the server's first account, with a workspace and a picture.
  await ada.goto(server.base);
  await ada.getByLabel('Name').fill('Ada');
  await ada.getByLabel('Email').fill('ada@lab.io');
  await ada.getByLabel('Password').fill('correct horse battery');
  await ada.getByRole('button', { name: 'Create account' }).click();
  await ada.getByPlaceholder('New workspace name').fill('Robotics lab');
  await ada.getByRole('button', { name: 'Create' }).click();
  await expect(sidebarTitles(ada)).toHaveText(['Getting started']);

  await ada.getByRole('button', { name: 'Workspace menu' }).click();
  await ada.getByRole('menuitem', { name: 'Your profile…' }).click();
  const profile = ada.getByTestId('profile-dialog');
  await profile.getByLabel('Profile picture').setInputFiles({
    name: 'ada.png',
    mimeType: 'image/png',
    buffer: await picture(ada),
  });
  await expect(profile.getByText('Saved.')).toBeVisible();
  await expect(profile.locator('img')).toHaveAttribute('src', /^data:image\/(webp|png);base64,/);
  await ada.keyboard.press('Escape');

  // Invite Bob as a member: no mail server here, so Ada gets the link to send.
  await ada.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(memberRows(ada)).toHaveCount(1);
  await expect(memberRows(ada)).toContainText('Ada(you)');
  await dialog(ada).getByLabel('Emails to invite').fill('bob@lab.io, not an email');
  await dialog(ada).getByLabel('Invite as').selectOption('member');
  await dialog(ada).getByRole('button', { name: 'Invite' }).click();
  const linkField = dialog(ada).getByLabel('Invite link for bob@lab.io');
  await expect(linkField).toHaveValue(/\/invite\/[\w-]+$/);
  const link = await linkField.inputValue();
  await dialog(ada)
    .getByRole('tab', { name: /Invites/ })
    .click();
  await expect(dialog(ada).getByTestId('invite-row')).toContainText('bob@lab.io');
  await shot(ada, 'members-1-invite');
  await ada.keyboard.press('Escape');

  // Bob opens the link in his own browser and creates his account from it.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  bob.on('pageerror', (error) => console.error(`[bob] ${error.stack ?? error}`));
  await bob.goto(link);
  await expect(bob.getByRole('heading', { name: 'Join Robotics lab' })).toBeVisible();
  await expect(bob.getByTestId('invite-intro')).toHaveText(
    'Ada invited bob@lab.io to join Robotics lab as a member.',
  );
  await expect(bob.getByLabel('Email')).toHaveValue('bob@lab.io');
  await expect(bob.getByLabel('Invite code')).toHaveCount(0);
  await bob.getByLabel('Name').fill('Bob');
  await bob.getByLabel('Password').fill('another good password');
  await shot(bob, 'members-2-join');
  await bob.getByRole('button', { name: 'Create account' }).click();
  await expect(bob).toHaveURL(/\/w\/[0-9a-f-]{36}/);
  await expect(bob.getByTestId('workspace-name')).toHaveText('Robotics lab');
  await expect(sidebarTitles(bob)).toHaveText(['Getting started']);
  // The link is used up.
  const again = await browser.newContext();
  const stranger = await again.newPage();
  await stranger.goto(link);
  await expect(stranger.getByTestId('invite-status')).toHaveText(
    'This invite has already been used.',
  );
  await again.close();

  // Both see each other: Ada (with her picture) the owner, Bob a member.
  await bob.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(memberRows(bob)).toHaveCount(2);
  await expect(memberRows(bob).nth(0)).toContainText('Ada');
  await expect(memberRows(bob).nth(0).getByTestId('member-role')).toHaveText('Owner');
  await expect(memberRows(bob).nth(0).locator('img')).toBeVisible();
  await expect(memberRows(bob).nth(1)).toContainText('Bob(you)');
  // Members don't manage: no invite form, no role menus.
  await expect(dialog(bob).getByLabel('Emails to invite')).toHaveCount(0);
  await expect(dialog(bob).getByLabel('Role of Ada')).toHaveCount(0);
  await bob.keyboard.press('Escape');

  await ada.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(memberRows(ada)).toHaveCount(2);
  await expect(dialog(ada).getByLabel('Role of Bob')).toHaveValue('member');
  await dialog(ada).getByRole('tab', { name: 'Groups' }).click();
  await dialog(ada).getByLabel('New group name').fill('Hardware');
  await dialog(ada).getByRole('button', { name: 'Create group' }).click();
  const group = dialog(ada).getByTestId('group-row').filter({ hasText: 'Hardware' });
  await group.getByRole('button', { name: /^Hardware/ }).click();
  await group.getByLabel('Add to Hardware').selectOption({ label: 'Bob' });
  await expect(group).toContainText('1 person');
  await shot(ada, 'members-3-groups');
  await dialog(ada)
    .getByRole('tab', { name: /Members/ })
    .click();
  await shot(ada, 'members-4-list');
  await ada.keyboard.press('Escape');

  // Ada mentions Bob in a page of the workspace's teamspace (her "New page" is private);
  // Bob sees it live.
  await ada.getByRole('button', { name: 'Add a page to Robotics lab' }).click();
  await ada.getByLabel('Page title').fill('Design review');
  await ada.getByLabel('Page title').press('Enter');
  await expect(editor(ada)).toBeFocused();
  await ada.keyboard.type('Motor sizing: ');
  await ada.keyboard.type('@bo');
  const menu = ada.getByTestId('mention-menu');
  await expect(menu.getByRole('option').first()).toContainText('Bob');
  await shot(ada, 'members-5-mention-menu');
  await ada.keyboard.press('Enter');
  await ada.keyboard.type('please check the torque.');
  await expect(editor(ada).getByTestId('mention')).toHaveText('@Bob');

  await sidebarTitles(bob).filter({ hasText: 'Design review' }).click();
  await expect(editor(bob)).toContainText('Motor sizing: @Bob please check the torque.');

  // The person picker of a database offers the members.
  await ada.getByRole('button', { name: 'Add a page to Robotics lab' }).click();
  await ada.getByLabel('Page title').fill('Tasks');
  await ada.getByTestId('get-started').getByRole('button', { name: 'Database' }).click();
  await table(ada).getByTestId('table-new-row').last().click();
  await ada.keyboard.type('Gearbox');
  await ada.keyboard.press('Enter');
  await table(ada).getByRole('button', { name: 'Add a property' }).click();
  await ada.getByTestId('add-property-menu').getByRole('menuitem', { name: 'Person' }).click();
  const propertyName = ada.getByTestId('property-menu').getByLabel('Property name');
  await propertyName.fill('Owner');
  await propertyName.press('Enter');
  await (await cell(ada, 'Gearbox', 'Owner')).click();
  const picker = ada.getByTestId('cell-popover');
  await expect(picker.getByRole('button')).toHaveCount(2);
  await expect(picker.getByRole('button', { name: 'Ada', exact: true })).toBeVisible();
  await picker.getByRole('button', { name: 'Bob', exact: true }).click();
  await ada.keyboard.press('Escape');
  // (The text starts with the avatar's initial.)
  await expect(await cell(ada, 'Gearbox', 'Owner')).toHaveText(/^B?Bob$/);
  await shot(ada, 'members-6-person');

  // Bob renames himself: Ada's mention and person cell follow.
  await bob.getByRole('button', { name: 'Workspace menu' }).click();
  await bob.getByRole('menuitem', { name: 'Your profile…' }).click();
  await bob.getByTestId('profile-dialog').getByLabel('Name').fill('Bob Builder');
  await bob.getByTestId('profile-dialog').getByRole('button', { name: 'Save' }).click();
  await expect(bob.getByTestId('profile-dialog').getByText('Saved.')).toBeVisible();
  await expect(await cell(ada, 'Gearbox', 'Owner')).toHaveText(/^B?Bob Builder$/);
  await sidebarTitles(ada).filter({ hasText: 'Design review' }).click();
  await expect(editor(ada).getByTestId('mention')).toHaveText('@Bob Builder');
  await bobContext.close();
});
