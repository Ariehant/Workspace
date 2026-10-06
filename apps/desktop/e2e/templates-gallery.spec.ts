import type { Page } from '@playwright/test';
import { editor, expect, quit, test } from './helpers';

async function newPage(window: Page, title: string) {
  await window.getByRole('button', { name: 'New page', exact: true }).click();
  await window.getByLabel('Page title').fill(title);
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window).first()).toBeFocused();
}
const sidebarItems = (window: Page, title: string) =>
  window.getByRole('tree', { name: 'Pages' }).getByRole('treeitem').filter({ hasText: title });

async function openGallery(window: Page, category: string) {
  await window.getByRole('button', { name: 'Templates', exact: true }).click();
  const gallery = window.getByTestId('templates-dialog');
  await gallery.getByRole('tab', { name: category }).click();
  return gallery;
}

test('templates gallery: preview a built-in template and use it', async ({ launch }) => {
  const first = await launch();
  let { window } = first;
  let gallery = await openGallery(window, 'Projects');
  await gallery.getByTestId('template-item').filter({ hasText: 'Tasks and projects' }).click();
  const preview = gallery.getByTestId('template-preview');
  await expect(preview.getByTestId('template-preview-title')).toHaveText('Tasks and projects');
  await expect(preview.getByTestId('template-database')).toHaveCount(2);
  await expect(preview.getByTestId('template-database').nth(1)).toContainText('Print test fingers');
  await gallery.getByRole('button', { name: 'Use template' }).click();
  await expect(gallery).toHaveCount(0);

  await expect(window.getByLabel('Page title')).toHaveValue('Tasks and projects');
  const blocks = window.getByTestId('database-block');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.nth(1)).toContainText('Print test fingers');
  // The relation links the copied rows.
  await expect(blocks.nth(1).getByRole('row').filter({ hasText: 'Grip force test' })).toContainText(
    'Gripper v2',
  );

  gallery = await openGallery(window, 'Robotics lab');
  await gallery.getByTestId('template-item').filter({ hasText: 'Experiment log' }).click();
  await expect(gallery.getByTestId('template-preview')).toContainText('Protocol');
  await gallery.getByRole('button', { name: 'Use template' }).click();
  await expect(window.getByLabel('Page title')).toHaveValue('Experiment log');
  await editor(window).first().getByText('Setup and calibration').click();
  await expect(window.getByLabel('Page title')).toHaveValue('Setup and calibration');

  await quit(first.app);
  ({ window } = await launch());
  await expect(sidebarItems(window, 'Tasks and projects')).toHaveCount(1);
  await sidebarItems(window, 'Tasks and projects').click();
  await expect(window.getByTestId('database-block').nth(1)).toContainText('Print test fingers');
});

test('save as template: appears in My templates, can be used and deleted', async ({ launch }) => {
  const { window } = await launch();
  await newPage(window, 'Standup');
  await window.keyboard.type('Yesterday, today, blockers');
  await window.getByRole('button', { name: 'Page options' }).click();
  await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Save as template' }).click();

  const gallery = await openGallery(window, 'My templates');
  const item = gallery.getByTestId('template-item').filter({ hasText: 'Standup' });
  await expect(item).toHaveCount(1);
  await item.click();
  await expect(gallery.getByTestId('template-preview')).toContainText('Yesterday, today, blockers');
  await gallery.getByRole('button', { name: 'Use template' }).click();
  await expect(sidebarItems(window, 'Standup')).toHaveCount(2);
  await expect(editor(window).first()).toHaveText('Yesterday, today, blockers');

  await openGallery(window, 'My templates');
  await gallery.getByRole('button', { name: 'Delete template' }).click();
  await expect(gallery.getByTestId('template-item')).toHaveCount(0);
  await expect(gallery).toContainText('No templates yet');
});
