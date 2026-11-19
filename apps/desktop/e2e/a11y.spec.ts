/**
 * Phase 7 M2: axe-core on every main screen and dialog, in both themes, with no violations
 * allowed (WCAG 2.1 A and AA, and axe's best practices). The second test does the screens a
 * server workspace adds: sharing, members, the inbox and comments.
 */
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addProperty, addRow, newDatabase } from './db';
import { editor, expect, launchApp, test } from './helpers';
import { startSyncServer } from './server';

/** A 4×3 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP4z8AARwzEcQwDAH2gC/UmQhvLAAAAAElFTkSuQmCC',
  'base64',
);

const THEMES = ['Light', 'Dark'] as const;

/**
 * No axe violations on what the window shows now. `modal`: a menu or dialog is open, and it
 * hides the rest of the app from assistive technology (`aria-hidden` on the app, focus kept
 * in the menu), which axe reads as hidden-but-focusable content and a page without its
 * main landmark or heading; those rules are for the page underneath, checked without it.
 */
async function expectAccessible(
  window: Page,
  screen: string,
  { modal = false, allow = [] as string[] } = {},
) {
  await window.waitForTimeout(250); // menus and dialogs finish opening
  const result = await new AxeBuilder({ page: window })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
    // Menus and popovers render outside the app's landmarks, at the end of <body>.
    .disableRules([
      'region',
      ...(modal ? ['aria-hidden-focus', 'landmark-one-main', 'page-has-heading-one'] : []),
      ...allow,
    ])
    .analyze();
  const found = result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n` +
      v.nodes
        .slice(0, 4)
        .map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.replace(/\n/g, ' ')}`)
        .join('\n'),
  );
  expect(found, `axe on ${screen}`).toEqual([]);
}

async function setTheme(window: Page, theme: (typeof THEMES)[number]) {
  await window.getByRole('button', { name: 'Appearance' }).click();
  await window.getByRole('menuitemradio', { name: theme }).click();
  await window.keyboard.press('Escape');
  await expect(window.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
}

/** Open a menu or dialog with `open`, check it, and close it with Escape. */
async function checkOpen(
  window: Page,
  screen: string,
  open: () => Promise<void>,
  allow: string[] = [],
) {
  await open();
  await expectAccessible(window, screen, { modal: true, allow });
  await window.keyboard.press('Escape');
}

for (const theme of THEMES) {
  test(`the main screens and dialogs, ${theme.toLowerCase()} theme`, async ({ launch }) => {
    test.setTimeout(180_000);
    const { window } = await launch();
    await setTheme(window, theme);
    const s = (name: string) => `${name} (${theme})`;
    const sidebarButton = (name: string) => window.getByRole('button', { name, exact: true });

    await expectAccessible(window, s('a page'));
    await checkOpen(window, s('the appearance menu'), () => sidebarButton('Appearance').click());
    await checkOpen(window, s('the workspace menu'), () =>
      window.getByRole('button', { name: /workspace menu/i }).click(),
    );
    await checkOpen(window, s('the page menu'), () =>
      window.getByRole('button', { name: 'Page options' }).click(),
    );
    await checkOpen(window, s('quick find'), () => window.keyboard.press('Control+k'));
    // Its filters: a menu open over it, then the results of a filter.
    await window.keyboard.press('Control+k');
    await window
      .getByTestId('quick-find-filters')
      .getByRole('button', { name: 'Edited: Any time' })
      .click();
    await expectAccessible(window, s('a quick find filter'), { modal: true });
    await window.getByRole('menuitemradio', { name: 'Today' }).click();
    await expect(window.getByTestId('quick-find-result').first()).toBeVisible();
    await expectAccessible(window, s('quick find, filtered'), { modal: true });
    await window.keyboard.press('Escape');
    // A link to a page that isn't here.
    await window.evaluate(
      () => void globalThis.open('workspace://page/00000000-0000-4000-8000-000000000000'),
    );
    await expect(window.getByTestId('no-access')).toContainText('This page doesn’t exist');
    await expectAccessible(window, s('a page that doesn’t exist'));
    // Back is the page it was opened over.
    await window.keyboard.press('Alt+ArrowLeft');
    await expect(window.getByTestId('no-access')).toBeHidden();
    await sidebarButton('Home').click();
    await expect(window.getByTestId('home-recent-page').first()).toBeVisible();
    await expectAccessible(window, s('home'));
    await window.keyboard.press('Alt+ArrowLeft');
    await expect(window.getByTestId('home')).toBeHidden();
    await checkOpen(window, s('presenting a page'), async () => {
      await window.getByRole('button', { name: 'Page options' }).click();
      await window.getByRole('menuitem', { name: 'Present' }).click();
      await expect(window.getByTestId('slide-count')).toBeVisible();
    });
    await expect(window.getByTestId('presentation')).toBeHidden();
    await checkOpen(window, s('templates'), () => sidebarButton('Templates').click());
    await checkOpen(window, s('the trash'), () => sidebarButton('Trash').click());
    await checkOpen(window, s('sync settings'), () => window.getByTestId('sync-indicator').click());

    await checkOpen(window, s('language and region'), async () => {
      await window.getByRole('button', { name: /workspace menu/i }).click();
      await window.getByRole('menuitem', { name: 'Language and region…' }).click();
      await expect(window.getByTestId('region-dialog')).toBeVisible();
    });

    await checkOpen(window, s('about'), async () => {
      await window.getByRole('button', { name: /workspace menu/i }).click();
      await window.getByRole('menuitem', { name: 'About Workspace' }).click();
      await expect(window.getByTestId('about-dialog')).toBeVisible();
    });

    await checkOpen(window, s('keyboard shortcuts'), async () => {
      await window.getByRole('button', { name: /workspace menu/i }).click();
      await window.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
      await expect(window.getByTestId('shortcuts-dialog')).toBeVisible();
    });

    // A page of its own: the slash menu, page history and export.
    await window.getByRole('button', { name: 'New page' }).click();
    await window.getByLabel('Page title').fill('Checked');
    await window.getByLabel('Page title').press('Enter');
    await window.keyboard.type('Some text, then ');
    await window.keyboard.type('/');
    await expect(window.getByTestId('slash-menu')).toBeVisible();
    await expectAccessible(window, s('the slash menu'));
    await window.keyboard.press('Escape');
    await checkOpen(window, s('page history'), async () => {
      await window.getByRole('button', { name: 'Page options' }).click();
      await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Page history' }).click();
      await expect(window.getByTestId('history-dialog')).toBeVisible();
    });
    await checkOpen(window, s('export'), async () => {
      await window.getByRole('button', { name: 'Page options' }).click();
      await window.getByTestId('page-menu').getByRole('menuitem', { name: 'Export…' }).click();
      await expect(window.getByTestId('export-dialog')).toBeVisible();
    });

    // A tabs block.
    await editor(window).first().click();
    await window.keyboard.press('Control+End');
    await window.keyboard.press('Enter');
    await window.keyboard.type('/tabs');
    await window.getByTestId('slash-menu').getByRole('option', { name: /^Tabs/ }).click();
    await window.keyboard.type('In the first tab');
    await expectAccessible(window, s('a tabs block'));

    // An image and its crop dialog, on the line after the tabs.
    await editor(window).first().locator(':scope > p').last().click();
    await window.keyboard.type('/image');
    await window
      .getByTestId('slash-menu')
      .getByRole('option', { name: /^Image/ })
      .click();
    await window.getByTestId('media-placeholder').getByLabel('Upload file').setInputFiles({
      name: 'arm.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await editor(window).first().locator('.ws-image').hover();
    await checkOpen(window, s('the image crop'), async () => {
      await editor(window).first().getByRole('button', { name: 'Crop' }).click();
      await expect(window.getByTestId('image-crop-dialog').getByTestId('crop-frame')).toBeVisible();
    });

    // A database in every layout, and its toolbar's panels.
    await newDatabase(window, 'Tasks');
    await addProperty(window, 'Select', 'Status');
    await addProperty(window, 'Date', 'When');
    await addRow(window, 'One');
    await addRow(window, 'Two');
    await window.keyboard.press('Escape');
    const database = window.getByTestId('database-view');
    await expectAccessible(window, s('a table'));
    for (const layout of [
      'Board',
      'List',
      'Gallery',
      'Feed',
      'Calendar',
      'Timeline',
      'Chart',
      'Form',
    ]) {
      await database.getByRole('button', { name: 'Add a view' }).click();
      await window.getByTestId('add-view-menu').getByRole('menuitem', { name: layout }).click();
      await expect(database.getByRole('tab', { name: layout, selected: true })).toBeVisible();
      await expectAccessible(window, s(`a ${layout.toLowerCase()}`));
    }
    await database.getByRole('tab', { name: 'Table' }).click();
    for (const panel of ['Filter', 'Sort', 'Group']) {
      await checkOpen(window, s(`the ${panel.toLowerCase()} panel`), () =>
        database.getByRole('button', { name: panel, exact: true }).click(),
      );
    }
    // Known exception: the property and view menus start with a name field, as Notion's do,
    // and a menu may only hold items (docs/PHASE7.md, M2).
    await checkOpen(
      window,
      s('a property menu'),
      () =>
        window
          .getByTestId('table-view')
          .getByRole('columnheader', { name: /Status/ })
          .click(),
      ['aria-required-children'],
    );
    await checkOpen(window, s('a select cell'), async () => {
      await window.getByTestId('table-row').first().getByRole('gridcell').nth(1).click();
      await expect(window.getByTestId('cell-popover')).toBeVisible();
    });
    // A relation (to the database itself), shown below as a section of the row page.
    await window.getByTestId('table-view').getByRole('button', { name: 'Add a property' }).click();
    await window
      .getByTestId('add-property-menu')
      .getByRole('menuitem', { name: 'Relation', exact: true })
      .click();
    await window
      .getByTestId('relation-setup')
      .getByLabel('Related to')
      .selectOption({ label: 'This database (Tasks)' });
    await window
      .getByTestId('relation-setup')
      .getByRole('button', { name: 'Add relation' })
      .click();
    // A row opened as a page.
    await window.getByTestId('row-title').first().hover();
    await window
      .getByTestId('table-row')
      .first()
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await expect(window.getByTestId('row-peek')).toBeVisible();
    await expectAccessible(window, s('a row page'), { modal: true });
    const peek = window.getByTestId('row-peek');
    await checkOpen(window, s('the layout dialog'), () =>
      peek.getByRole('button', { name: 'Customize layout' }).click(),
    );
    // Its layout: Status pinned, the rest in a side panel, the relation as a section.
    await peek.getByRole('button', { name: 'Customize layout' }).click();
    const layout = window.getByTestId('layout-dialog');
    await layout
      .getByRole('group', { name: /Pinned under the title/ })
      .getByLabel('Status')
      .check();
    await layout.getByLabel('In a side panel (wide windows)').check();
    await layout
      .getByRole('group', { name: 'Relations as sections of the page' })
      .getByLabel('Related')
      .check();
    await layout.getByTestId('layout-save').click();
    await expect(peek.getByTestId('relation-section')).toBeVisible();
    await expectAccessible(window, s('a row page with a custom layout'), { modal: true });
    // Back to the default for the next theme's run (a new app, but the same steps).
    await peek
      .getByTestId('properties-side')
      .getByRole('button', { name: 'Customize layout' })
      .click();
    await window.getByTestId('layout-dialog').getByRole('button', { name: 'Reset' }).click();
  });
}

/** Bob joins Ada's workspace and asks for her page `title` (found with her search). */
async function requestAsBob(base: string, title: string) {
  const call = async (method: string, path: string, token: string | null, body?: object) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-workspace-client': 'desktop',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (await res.json()) as any;
  };
  const ada = (
    await call('POST', '/api/auth/login', null, {
      email: 'ada@lab.io',
      password: 'correct horse battery',
      client: 'desktop',
    })
  ).token as string;
  const ws = (await call('GET', '/api/workspaces', ada)).workspaces[0].id as string;
  const { invites } = await call('POST', `/api/workspaces/${ws}/invites`, ada, {
    emails: ['bob@lab.io'],
    role: 'member',
  });
  const bob = (
    await call('POST', '/api/auth/signup', null, {
      email: 'bob@lab.io',
      name: 'Bob',
      password: 'correct horse battery',
      client: 'desktop',
      invite: (invites[0].link as string).split('/invite/')[1],
    })
  ).token as string;
  let pageId: string | undefined;
  await expect
    .poll(
      async () => {
        const { results } = await call(
          'GET',
          `/api/workspaces/${ws}/search?q=${encodeURIComponent(title)}`,
          ada,
        );
        pageId = results?.[0]?.id;
        return pageId;
      },
      { timeout: 20_000 },
    )
    .toBeTruthy();
  const asked = await call('POST', `/api/workspaces/${ws}/pages/${pageId}/access-requests`, bob, {
    role: 'view',
    message: 'For the review',
  });
  expect(asked, JSON.stringify(asked)).toHaveProperty('request');
}

test('the screens of a server workspace: sharing, members, the inbox and comments', async () => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'workspace-a11y-'));
  const server = await startSyncServer(root);
  const ada = await launchApp(join(root, 'ada'));
  try {
    const A = ada.window;
    await A.getByTestId('sync-indicator').click();
    const dialog = A.getByTestId('sync-dialog');
    await dialog.getByTestId('sync-server').fill(server.base);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expectAccessible(A, 'signing up', { modal: true });
    await dialog.getByTestId('sync-name').fill('Ada');
    await dialog.getByTestId('sync-email').fill('ada@lab.io');
    await dialog.getByTestId('sync-password').fill('correct horse battery');
    await dialog.getByTestId('sync-sign-in').click();
    await dialog.getByTestId('sync-workspace-name').fill('Robotics lab');
    await expectAccessible(A, 'choosing a workspace', { modal: true });
    await dialog.getByTestId('sync-start').click();
    await expect(A.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });

    await A.getByRole('button', { name: 'New page' }).click();
    await A.getByLabel('Page title').fill('Gearbox');
    await A.getByLabel('Page title').press('Enter');
    await expect(editor(A)).toBeFocused();
    await A.keyboard.type('Planetary, three stages.');

    // Bob (over the API) asks for Ada's private page: a request in her inbox, with buttons.
    await A.getByRole('button', { name: 'Add a page to Private' }).click();
    await A.getByLabel('Page title').fill('Budget');
    await A.getByLabel('Page title').press('Enter');
    await expect(A.getByTestId('sync-indicator')).toHaveText('Synced', { timeout: 20_000 });
    await requestAsBob(server.base, 'Budget');
    await expect(A.getByTestId('inbox-unread')).toHaveText('1', { timeout: 20_000 });

    for (const theme of THEMES) {
      await setTheme(A, theme);
      const s = (name: string) => `${name} (${theme}, server)`;
      await expectAccessible(A, s('a page'));
      await checkOpen(A, s('the share menu'), () =>
        A.getByRole('button', { name: 'Share', exact: true }).click(),
      );
      await checkOpen(A, s('members'), async () => {
        await A.getByRole('button', { name: 'Members', exact: true }).click();
        await expect(A.getByTestId('members-dialog')).toBeVisible();
      });
      await checkOpen(A, s('the inbox, with a request'), async () => {
        await A.getByTestId('inbox-button').click();
        await expect(A.getByTestId('request-actions')).toBeVisible();
      });
      await A.getByRole('button', { name: 'Comments' }).first().click();
      await expect(A.getByTestId('comments-panel')).toBeVisible();
      await expectAccessible(A, s('comments'));
      await A.getByRole('button', { name: 'Comments' }).first().click();
    }
  } finally {
    await ada.app.close().catch(() => {});
    await server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
