/**
 * Phase 8 N8 (#34): share links. On an invite-only server, Ada makes a "can comment" link for
 * a page; Carol, who has no account, opens it, signs up from it, and lands on that page: she
 * can read and comment, not edit, and sees nothing else. Turning the link off ends it.
 */
import { expect, test } from '@playwright/test';
import { startServer, type TestServer } from './server';

let server: TestServer;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startServer({ SIGNUP: 'invite' });
});
test.afterAll(async () => {
  await server?.stop();
});

test('a share link: sign up from it, and get that page alone, to comment on', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ada = await browser.newPage();
  ada.on('pageerror', (error) => console.error(`[ada] ${error.stack ?? error}`));
  await ada.goto(server.base);
  await ada.getByLabel('Name').fill('Ada');
  await ada.getByLabel('Email').fill('ada@lab.io');
  await ada.getByLabel('Password').fill('correct horse battery');
  await ada.getByRole('button', { name: 'Create account' }).click();
  await ada.getByPlaceholder('New workspace name').fill('Robotics lab');
  await ada.getByRole('button', { name: 'Create' }).click();
  const sidebarTitles = ada.getByTestId('sidebar-page-title');
  await expect(sidebarTitles).toHaveText(['Getting started']);

  // A page of her own, then its link.
  await ada.getByRole('button', { name: 'New page' }).click();
  await ada.getByLabel('Page title').fill('Client brief');
  await ada.getByLabel('Page title').press('Enter');
  await ada.keyboard.type('Two grippers, delivered in March.');
  await ada.getByRole('button', { name: 'Share', exact: true }).click();
  const share = ada.getByTestId('share-dialog');
  const section = share.getByTestId('share-link');
  // Its controls don't take the invite form's labels ("Role" is one control).
  await expect(section).toBeVisible();
  await expect(share.getByLabel('Role')).toHaveCount(1);
  await section.getByLabel('Anyone with the link can').selectOption('comment');
  await section.getByLabel('Link ends').selectOption({ label: 'Ends in 7 days' });
  await section.getByRole('button', { name: 'Make a link' }).click();
  const address = section.getByLabel('Share link address');
  await expect(address).toHaveValue(/\/s\/[\w-]{20,}$/);
  await expect(section.getByTestId('share-link-summary')).toContainText('Can comment · ends');
  const link = await address.inputValue();
  await ada.keyboard.press('Escape');

  // Carol: no account. The link says what it opens, and lets her sign up.
  const carolContext = await browser.newContext();
  const carol = await carolContext.newPage();
  carol.on('pageerror', (error) => console.error(`[carol] ${error.stack ?? error}`));
  await carol.goto(link);
  await expect(carol.getByRole('heading', { name: 'Open “Client brief”' })).toBeVisible();
  await expect(carol.getByTestId('share-link-intro')).toHaveText(
    'Someone in Robotics lab shared Client brief with anyone who has the link. Sign in to comment on it.',
  );
  await carol.getByLabel('Name').fill('Carol');
  await carol.getByLabel('Email').fill('carol@client.io');
  await carol.getByLabel('Password').fill('a long password here');
  await carol.getByRole('button', { name: 'Create account' }).click();

  // She lands on the page: to read and comment, not to edit; nothing else of Ada's.
  await expect(carol).toHaveURL(/\/w\/[0-9a-f-]{36}/);
  await expect(carol.getByLabel('Page title')).toHaveValue('Client brief', { timeout: 15_000 });
  await expect(carol.getByTestId('page-editor')).toContainText('Two grippers, delivered in March.');
  await expect(carol.getByTestId('access-badge')).toHaveText('Can comment');
  // (Commenters suggest edits in the text; the title stays as it is.)
  await expect(carol.getByLabel('Page title')).toHaveAttribute('readonly', '');
  await expect(carol.getByTestId('sidebar-page-title')).toHaveText(['Client brief']);

  // Turned off: the link stops working (Carol keeps her access).
  await ada.getByRole('button', { name: 'Share', exact: true }).click();
  await share.getByTestId('share-link').getByRole('button', { name: 'Turn off' }).click();
  await expect(share.getByTestId('share-link').getByLabel('Share link address')).toHaveCount(0);
  await ada.keyboard.press('Escape');
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(link);
  await expect(stranger.getByTestId('share-link-problem')).toContainText('isn’t valid');
  await carol.reload();
  await expect(carol.getByLabel('Page title')).toHaveValue('Client brief', { timeout: 15_000 });
  await carolContext.close();
});
