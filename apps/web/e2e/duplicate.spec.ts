/**
 * Phase 8 #35: "Allow duplicate as template". Ada publishes a page and allows copies; the
 * published page shows Duplicate. Bob opens it, signs up from it, picks his workspace, and
 * lands on his own copy, in his private pages, to change as he likes.
 */
import { expect, test, type Page } from '@playwright/test';
import { startServer, type TestServer } from './server';

let server: TestServer;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  server = await startServer({ SIGNUP: 'open' });
});
test.afterAll(async () => {
  await server?.stop();
});

async function signUp(page: Page, name: string, email: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create account' }).click();
}

test('a published page duplicated into a visitor’s own workspace', async ({ browser }) => {
  test.setTimeout(120_000);
  const ada = await browser.newPage();
  ada.on('pageerror', (error) => console.error(`[ada] ${error.stack ?? error}`));
  await ada.goto(server.base);
  await signUp(ada, 'Ada', 'ada@lab.io');
  await ada.getByPlaceholder('New workspace name').fill('Robotics lab');
  await ada.getByRole('button', { name: 'Create' }).click();
  await expect(ada.getByTestId('sidebar-page-title')).toHaveText(['Getting started']);
  await ada.getByRole('button', { name: 'New page' }).click();
  await ada.getByLabel('Page title').fill('Robot checklist');
  await ada.getByLabel('Page title').press('Enter');
  await ada.keyboard.type('Check the battery before each run.');

  // Published, then copies allowed.
  await ada.getByRole('button', { name: 'Share', exact: true }).click();
  const publish = ada.getByTestId('share-dialog').getByTestId('publish-section');
  await publish.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(publish.getByTestId('publish-url')).toContainText('/p/');
  const url = (await publish.getByTestId('publish-url').getAttribute('href'))!;
  await publish.getByLabel('Allow duplicate as template').check();
  await publish.getByRole('button', { name: 'Save' }).click();
  await expect(publish.getByLabel('Allow duplicate as template')).toBeChecked();
  await ada.keyboard.press('Escape');

  // Bob, signed out, on the published page: Duplicate.
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  bob.on('pageerror', (error) => console.error(`[bob] ${error.stack ?? error}`));
  await bob.goto(url);
  await expect(bob.locator('article')).toContainText('Check the battery before each run.');
  await bob.getByRole('link', { name: 'Duplicate' }).click();
  await expect(bob.getByRole('heading', { name: 'Duplicate “Robot checklist”' })).toBeVisible();
  await expect(bob.getByTestId('duplicate-intro')).toContainText('goes to your private pages');
  // (No invite here: the form starts as sign in.)
  await bob.getByRole('button', { name: 'Create an account' }).click();
  await signUp(bob, 'Bob', 'bob@home.io');
  // A workspace of his own first (none yet), then back to the page.
  await expect(bob.getByText('You’re not a member of a workspace here yet')).toBeVisible();
  await bob.goto(server.base);
  await bob.getByPlaceholder('New workspace name').fill('Bob’s bench');
  await bob.getByRole('button', { name: 'Create' }).click();
  await expect(bob.getByTestId('sidebar-page-title')).toHaveText(['Getting started']);
  await bob.goto(url);
  await bob.getByRole('link', { name: 'Duplicate' }).click();
  await expect(bob.getByLabel('Workspace')).toHaveValue(/.+/);
  await bob.getByRole('button', { name: 'Duplicate', exact: true }).click();

  // His copy: in his workspace, editable.
  await expect(bob).toHaveURL(/\/w\/[0-9a-f-]{36}#page=/);
  await expect(bob.getByLabel('Page title')).toHaveValue('Robot checklist', { timeout: 15_000 });
  await expect(bob.getByTestId('page-editor')).toContainText('Check the battery before each run.');
  await expect(bob.getByTestId('sidebar-page-title')).toHaveText([
    'Getting started',
    'Robot checklist',
  ]);
  await bob.getByTestId('page-editor').click();
  await bob.keyboard.press('Control+End');
  await bob.keyboard.type(' And the wheels.');
  await expect(bob.getByTestId('page-editor')).toContainText('And the wheels.');
  // Ada's page is as it was.
  await ada.reload();
  await expect(ada.getByTestId('page-editor')).not.toContainText('And the wheels.', {
    timeout: 15_000,
  });
  await bobContext.close();
});
