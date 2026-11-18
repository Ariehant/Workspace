import { addProperty, addRow, cell, header, newDatabase, popover, rows, table, titles } from './db';
import { editor, expect, quit, test, waitForIndexed } from './helpers';

test('database: every property type, edited in the table, kept after restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Parts');
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Tags']);
  await expect(window.getByRole('treeitem').filter({ hasText: 'Parts' })).toBeVisible();

  await addRow(window, 'Servo');
  await addRow(window, 'Gearbox');
  await expect(titles(window)).toHaveText(['Servo', 'Gearbox']);

  // Text-like properties are typed in place.
  await addProperty(window, 'Number', 'Qty');
  await (await cell(window, 'Servo', 'Qty')).click();
  await window.keyboard.type('4');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'Servo', 'Qty')).toHaveText('4');

  await addProperty(window, 'URL', 'Datasheet');
  await (await cell(window, 'Servo', 'Datasheet')).click();
  await window.keyboard.type('example.com/mg996r.pdf');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'Servo', 'Datasheet')).toContainText('example.com/mg996r.pdf');

  // Multi-select: create options from the search box.
  await (await cell(window, 'Servo', 'Tags')).click();
  await popover(window).getByLabel('Search for an option').fill('Actuator');
  await window.keyboard.press('Enter');
  await popover(window).getByLabel('Search for an option').fill('Metal');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect((await cell(window, 'Servo', 'Tags')).getByTestId('option')).toHaveText([
    'Actuator',
    'Metal',
  ]);
  // Existing options are offered on other rows.
  await (await cell(window, 'Gearbox', 'Tags')).click();
  await popover(window).getByTestId('option-choice').filter({ hasText: 'Metal' }).click();
  await window.keyboard.press('Escape');
  await expect((await cell(window, 'Gearbox', 'Tags')).getByTestId('option')).toHaveText(['Metal']);

  // Status starts with Notion's three options.
  await addProperty(window, 'Status', 'State');
  await (await cell(window, 'Servo', 'State')).click();
  await popover(window).getByTestId('option-choice').filter({ hasText: 'In progress' }).click();
  await expect(popover(window)).toHaveCount(0);
  await expect(await cell(window, 'Servo', 'State')).toHaveText('In progress');

  await addProperty(window, 'Date', 'Due');
  await (await cell(window, 'Servo', 'Due')).click();
  await popover(window).getByLabel('Start date').fill('2026-10-20');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Servo', 'Due')).toHaveText('Oct 20, 2026');

  await addProperty(window, 'Checkbox', 'In stock');
  await (await cell(window, 'Servo', 'In stock')).getByRole('checkbox').click();
  await expect((await cell(window, 'Servo', 'In stock')).getByRole('checkbox')).toBeChecked();

  await addProperty(window, 'Person', 'Owner');
  await (await cell(window, 'Servo', 'Owner')).click();
  await popover(window).getByRole('button').first().click();
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Servo', 'Owner')).not.toHaveText('');

  await addProperty(window, 'ID', 'Part no');
  await expect(await cell(window, 'Servo', 'Part no')).toHaveText('1');
  await expect(await cell(window, 'Gearbox', 'Part no')).toHaveText('2');
  await addProperty(window, 'Created time', 'Added');
  await expect(await cell(window, 'Servo', 'Added')).toContainText('2026');

  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Parts' }).click();
  await expect(titles(window)).toHaveText(['Servo', 'Gearbox']);
  await expect(await cell(window, 'Servo', 'Qty')).toHaveText('4');
  await expect((await cell(window, 'Servo', 'Tags')).getByTestId('option')).toHaveText([
    'Actuator',
    'Metal',
  ]);
  await expect(await cell(window, 'Servo', 'State')).toHaveText('In progress');
  await expect(await cell(window, 'Servo', 'Due')).toHaveText('Oct 20, 2026');
  await expect((await cell(window, 'Servo', 'In stock')).getByRole('checkbox')).toBeChecked();
  await expect(await cell(window, 'Servo', 'Datasheet')).toContainText('example.com');
});

test('table keyboard: move, edit, clear, copy and paste, undo', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Keys');
  await addRow(window, 'Alpha');
  await addRow(window, 'Beta');
  await addProperty(window, 'Text', 'Note');

  // Typing on a selected cell edits it; Enter saves and moves down.
  await (await cell(window, 'Alpha', 'Note')).click();
  await window.keyboard.type('first');
  await window.keyboard.press('Enter');
  await expect(await cell(window, 'Beta', 'Note')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.type('second');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'Beta', 'Note')).toHaveText('second');

  // Arrows move the selection; Ctrl+C / Ctrl+V copy a value between cells.
  await window.keyboard.press('ArrowUp');
  await expect(await cell(window, 'Alpha', 'Note')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('Control+c');
  await window.keyboard.press('ArrowLeft'); // Tags
  await window.keyboard.press('ArrowLeft'); // Name
  await window.keyboard.press('ArrowDown');
  await expect(await cell(window, 'Beta', 'Name')).toHaveAttribute('aria-selected', 'true');
  await window.keyboard.press('Control+v');
  await expect(titles(window)).toHaveText(['Alpha', 'first']);

  // Undo reverts the paste; Backspace clears a cell.
  await window.keyboard.press('Control+z');
  await expect(titles(window)).toHaveText(['Alpha', 'Beta']);
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('Backspace');
  await expect(await cell(window, 'Beta', 'Note')).toHaveText('');
});

test('columns: sort, rename, change type, hide, resize, reorder, delete', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Columns');
  await addProperty(window, 'Text', 'Rank');
  // As text, "1.5" sorts before "1.10" (natural order); as numbers, after.
  for (const [title, rank] of [
    ['b', '1.5'],
    ['c', '1.10'],
    ['a', '3'],
  ] as const) {
    await addRow(window, title);
    await (await cell(window, title, 'Rank')).click();
    await window.keyboard.type(rank);
    await window.keyboard.press('Enter');
  }

  // Sorting text; then changing the type to Number sorts numerically.
  await header(window, 'Rank').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Sort ascending' })
    .click();
  await expect(titles(window)).toHaveText(['b', 'c', 'a']);
  await header(window, 'Rank').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: /^Type/ }).click();
  await window.getByRole('menuitem', { name: 'Number', exact: true }).click();
  await expect(titles(window)).toHaveText(['c', 'b', 'a']);
  await expect(await cell(window, 'c', 'Rank')).toHaveText('1.1');
  await window.getByTestId('sort-chip').click();
  await window.getByTestId('sort-editor').getByRole('button', { name: 'Delete sort' }).click();
  await window.keyboard.press('Escape');
  await expect(titles(window)).toHaveText(['b', 'c', 'a']);

  // Rename.
  await header(window, 'Rank').click();
  const name = window.getByTestId('property-menu').getByLabel('Property name');
  await name.fill('Priority');
  await name.press('Enter');
  await expect(header(window, 'Priority')).toBeVisible();

  // Resize by dragging the header edge.
  const before = (await header(window, 'Priority').boundingBox())!;
  const handle = header(window, 'Priority').getByRole('separator');
  const h = (await handle.boundingBox())!;
  await window.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await window.mouse.down();
  await window.mouse.move(h.x + h.width / 2 + 80, h.y + h.height / 2, { steps: 4 });
  await window.mouse.up();
  await expect
    .poll(async () => (await header(window, 'Priority').boundingBox())!.width)
    .toBe(before.width + 80);

  // Reorder: drag Priority before Tags.
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Tags', 'Priority']);
  await header(window, 'Priority').dragTo(header(window, 'Tags'), {
    targetPosition: { x: 10, y: 10 },
  });
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Priority', 'Tags']);

  // Hide from the view, show again from the view menu.
  await header(window, 'Tags').click();
  await window.getByTestId('property-menu').getByRole('menuitem', { name: 'Hide in view' }).click();
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Priority']);
  await window.getByRole('tab', { name: 'Table' }).click();
  await window.getByTestId('view-menu').getByRole('menuitem', { name: 'Properties' }).click();
  await window.getByRole('menuitem', { name: 'Tags' }).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Priority', 'Tags']);

  // Delete.
  await header(window, 'Priority').click();
  await window
    .getByTestId('property-menu')
    .getByRole('menuitem', { name: 'Delete property' })
    .click();
  await expect(table(window).getByTestId('column-header')).toHaveText(['Name', 'Tags']);
});

test('rows: reorder, duplicate, delete to trash and restore', async ({ launch }) => {
  const { window } = await launch();
  await newDatabase(window, 'Rows');
  for (const t of ['One', 'Two', 'Three']) await addRow(window, t);

  const grip = (title: string) =>
    rows(window)
      .filter({ hasText: title })
      .getByRole('button', { name: 'Drag to move, click to open menu' });
  // Drag in steps, like a hand: the grip only shows while its row is hovered.
  await rows(window).filter({ hasText: 'Three' }).hover();
  const from = (await grip('Three').boundingBox())!;
  const to = (await rows(window).filter({ hasText: 'One' }).boundingBox())!;
  await window.mouse.move(from.x + 5, from.y + 5);
  await window.mouse.down();
  await window.mouse.move(from.x + 10, from.y + 8, { steps: 3 });
  await window.mouse.move(to.x + 100, to.y + 4, { steps: 5 });
  await window.mouse.up();
  await expect(titles(window)).toHaveText(['Three', 'One', 'Two']);

  await rows(window).filter({ hasText: 'One' }).hover();
  await grip('One').click();
  await window.getByTestId('row-menu').getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(titles(window)).toHaveText(['Three', 'One', 'One', 'Two']);

  await rows(window).filter({ hasText: 'Two' }).hover();
  await grip('Two').click();
  await window.getByTestId('row-menu').getByRole('menuitem', { name: 'Delete' }).click();
  await expect(titles(window)).toHaveText(['Three', 'One', 'One']);

  await window.getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = window.getByTestId('trash');
  await expect(trash.getByTestId('trash-item')).toContainText(['Two']);
  await expect(trash.getByTestId('trash-item')).toContainText(['in Rows']);
  await trash.getByTestId('trash-item').filter({ hasText: 'Two' }).hover();
  await trash
    .getByTestId('trash-item')
    .filter({ hasText: 'Two' })
    .getByRole('button', { name: 'Restore' })
    .click();
  await window.keyboard.press('Escape');
  await expect(titles(window)).toHaveText(['Three', 'One', 'One', 'Two']);
});

test('row pages: side peek, center peek, full page, with properties and content', async ({
  launch,
}) => {
  const { window } = await launch();
  await newDatabase(window, 'Tasks');
  await addRow(window, 'Calibrate IMU');

  // Default: side peek with the title, properties and an editor for the content.
  await (await cell(window, 'Calibrate IMU', 'Name')).hover();
  await table(window).getByRole('button', { name: 'Open', exact: true }).click();
  const peek = window.getByTestId('row-peek');
  await expect(peek).toHaveAttribute('data-mode', 'sidePeek');
  await expect(peek.getByLabel('Page title')).toHaveValue('Calibrate IMU');
  await peek.getByLabel('Page title').fill('Calibrate IMU v2');
  await expect(titles(window)).toHaveText(['Calibrate IMU v2']);

  await peek.getByRole('button', { name: 'Edit Tags' }).click();
  await popover(window).getByLabel('Search for an option').fill('Sensors');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect(peek.getByTestId('option')).toHaveText(['Sensors']);
  await expect((await cell(window, 'Calibrate IMU v2', 'Tags')).getByTestId('option')).toHaveText([
    'Sensors',
  ]);

  await peek.getByLabel('Page title').press('Enter');
  await expect(peek.getByTestId('page-editor')).toBeFocused();
  await window.keyboard.type('Use the six-position tumble test.');
  await waitForIndexed(window, 'tumble');

  // Escape (outside fields) closes the peek.
  await peek.getByRole('button', { name: 'Close' }).click();
  await expect(peek).toHaveCount(0);

  // Center peek.
  await window.getByRole('tab', { name: 'Table' }).click();
  await window
    .getByTestId('view-menu')
    .getByRole('menuitem', { name: /Open pages in/ })
    .click();
  await window.getByRole('menuitemradio', { name: 'Center peek' }).click();
  await window.keyboard.press('Escape');
  await window.keyboard.press('Escape');
  await (await cell(window, 'Calibrate IMU v2', 'Name')).hover();
  await table(window).getByRole('button', { name: 'Open', exact: true }).click();
  await expect(peek).toHaveAttribute('data-mode', 'center');
  await expect(peek.getByTestId('page-editor')).toContainText('six-position');

  // Open as full page: breadcrumb shows the database, back returns to it.
  await peek.getByRole('button', { name: 'Open as full page' }).click();
  await expect(peek).toHaveCount(0);
  const page = window.getByTestId('row-page');
  await expect(page.getByLabel('Page title')).toHaveValue('Calibrate IMU v2');
  await expect(page.getByRole('list', { name: 'Breadcrumb' })).toHaveText(
    /Tasks\/Calibrate IMU v2/,
  );
  await expect(editor(window)).toContainText('six-position');
  await window.keyboard.press('Alt+ArrowLeft');
  await expect(table(window)).toBeVisible();
});

test('rows in quick find, links to rows, and inline databases', async ({ launch }) => {
  const { app, window } = await launch();
  await newDatabase(window, 'Robots');
  await addRow(window, 'Spot');
  await (await cell(window, 'Spot', 'Tags')).click();
  await popover(window).getByLabel('Search for an option').fill('Quadruped');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await waitForIndexed(window, 'quadruped');

  // Quick find matches property text and shows where the row is.
  await window.keyboard.press('Control+k');
  await window.getByTestId('quick-find').getByLabel('Search pages').fill('quadruped');
  const result = window.getByTestId('quick-find-result');
  await expect(result).toHaveCount(1);
  await expect(result).toContainText('Spot');
  await expect(result).toContainText('Robots');
  await window.keyboard.press('Enter');
  await expect(window.getByTestId('row-page').getByLabel('Page title')).toHaveValue('Spot');

  // Copy link from the row page, then follow it from another page.
  await app.evaluate(({ clipboard }) => clipboard.clear());
  await window.getByRole('button', { name: 'Page options' }).click();
  await window.getByRole('menuitem', { name: 'Copy link' }).click();
  // The clipboard is written asynchronously.
  await expect
    .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
    .toMatch(/^workspace:\/\/page\/[0-9a-f-]+$/);
  const link = await app.evaluate(({ clipboard }) => clipboard.readText());

  // An inline database from the slash menu, inside a normal page.
  await window.getByRole('button', { name: 'New page' }).click();
  await window.getByLabel('Page title').fill('Lab notes');
  await window.getByLabel('Page title').press('Enter');
  await expect(editor(window)).toBeFocused();
  await window.keyboard.type('/database inline');
  await expect(window.getByTestId('slash-menu').getByRole('option').first()).toContainText(
    'Database - Inline',
  );
  await window.keyboard.press('Enter');
  const inline = window.getByTestId('inline-database');
  await expect(inline).toBeVisible();
  await inline.getByLabel('Database title').fill('Experiments');
  await inline.getByRole('button', { name: 'New', exact: true }).last().click();
  await window.keyboard.type('Gait test');
  await window.keyboard.press('Enter');
  await expect(inline.getByTestId('row-title')).toHaveText(['Gait test']);
  // The inline database is a sub-page of the page in the sidebar.
  const notes = window.getByTestId('sidebar-row').filter({ hasText: 'Lab notes' });
  await notes.hover();
  await notes.getByRole('button', { name: 'Expand' }).click();
  await expect(window.getByTestId('sidebar-row').filter({ hasText: 'Experiments' })).toBeVisible();

  await window.evaluate((url) => globalThis.open(url), link);
  await expect(window.getByTestId('row-page').getByLabel('Page title')).toHaveValue('Spot');
});

test('text properties: bold, links and colour, kept after a restart and in the row page', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Specs');
  await addRow(window, 'Arm');
  await addProperty(window, 'Text', 'Notes');

  // Typed straight into the selected cell, with Ctrl+B around "2 Nm".
  await (await cell(window, 'Arm', 'Notes')).click();
  await window.keyboard.type('Torque ');
  await window.keyboard.press('Control+b');
  await window.keyboard.type('2 Nm');
  await window.keyboard.press('Control+b');
  await window.keyboard.type(', see spec');
  // "spec" becomes a link (Ctrl+K), and red.
  for (let i = 0; i < 4; i++) await window.keyboard.press('Shift+ArrowLeft');
  await window.keyboard.press('Control+k');
  await window.getByLabel('Link address').fill('https://example.org/spec');
  await window.getByLabel('Link address').press('Enter');
  await window.getByLabel('Color').selectOption('red');
  await window.getByTestId('cell-editor').press('Enter');

  const notes = async () => cell(window, 'Arm', 'Notes');
  await expect(await notes()).toHaveText('Torque 2 Nm, see spec');
  await expect((await notes()).locator('strong')).toHaveText('2 Nm');
  await expect((await notes()).getByRole('link', { name: 'spec' })).toHaveAttribute(
    'href',
    'https://example.org/spec',
  );
  await expect((await notes()).locator('[data-color="red"]')).toHaveText('spec');

  // Filters and search still read the plain text.
  await waitForIndexed(window, 'Torque');

  await quit(first.app);
  ({ window } = await launch());
  await window.getByTestId('sidebar-page-title').filter({ hasText: 'Specs' }).click();
  await expect((await notes()).locator('strong')).toHaveText('2 Nm');

  // Editing again keeps the formatting; Escape leaves it as it was.
  await (await notes()).dblclick();
  await expect(window.getByTestId('cell-editor').locator('strong')).toHaveText('2 Nm');
  await window.keyboard.press('Escape');
  await expect((await notes()).locator('strong')).toHaveText('2 Nm');

  // The row page shows it too.
  await (await cell(window, 'Arm', 'Name')).hover();
  await table(window).getByRole('button', { name: 'Open', exact: true }).click();
  const peek = window.getByTestId('row-peek');
  await expect(peek.getByTestId('rich-text').locator('strong')).toHaveText('2 Nm');
});

test('bulk edit: pick rows with Shift, set a status for all, undo once; duplicate and delete', async ({
  launch,
}) => {
  const { window } = await launch();
  await newDatabase(window, 'Bulk');
  for (let i = 1; i <= 8; i++) await addRow(window, `R${i}`);
  await addProperty(window, 'Status', 'State');
  const check = async (title: string, shift = false) => {
    const row = rows(window).filter({ has: window.getByText(title, { exact: true }) });
    await row.hover();
    await row.getByTestId('row-check').click({ modifiers: shift ? ['Shift'] : [] });
  };
  const bar = window.getByTestId('bulk-bar');

  // R2, then Shift+R6: five rows.
  await check('R2');
  await check('R6', true);
  await expect(bar.getByTestId('bulk-count')).toHaveText('5 selected');

  // Their State, all at once.
  await bar.getByRole('button', { name: 'Edit property' }).click();
  await window.getByTestId('bulk-properties').getByRole('menuitem', { name: 'State' }).click();
  await popover(window).getByRole('option', { name: 'Done' }).click();
  await expect(popover(window)).toHaveCount(0);
  for (const title of ['R2', 'R3', 'R4', 'R5', 'R6']) {
    await expect(await cell(window, title, 'State')).toHaveText('Done');
  }
  await expect(await cell(window, 'R1', 'State')).toHaveText('');
  await expect(await cell(window, 'R7', 'State')).toHaveText('');

  // One undo puts them all back.
  await table(window).focus();
  await window.keyboard.press('Control+z');
  for (const title of ['R2', 'R3', 'R4', 'R5', 'R6']) {
    await expect(await cell(window, title, 'State')).toHaveText('');
  }

  // A text property for all: typed once.
  await bar.getByRole('button', { name: 'Edit property' }).click();
  await window.getByTestId('bulk-properties').getByRole('menuitem', { name: 'Tags' }).click();
  await popover(window).getByLabel('Search for an option').fill('Arm');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await expect(await cell(window, 'R4', 'Tags')).toHaveText('Arm');

  // Duplicate two; then all of them (Ctrl+A) to the trash, and back with undo.
  await bar.getByRole('button', { name: 'Clear selection' }).click();
  await expect(bar).toHaveCount(0);
  await check('R7');
  await check('R8');
  await bar.getByRole('button', { name: 'Duplicate' }).click();
  await expect(rows(window)).toHaveCount(10);
  await table(window).focus();
  await window.keyboard.press('Control+a');
  await expect(bar.getByTestId('bulk-count')).toHaveText('10 selected');
  await bar.getByRole('button', { name: 'Delete' }).click();
  await expect(rows(window)).toHaveCount(0);
  await table(window).focus();
  await window.keyboard.press('Control+z');
  await expect(rows(window)).toHaveCount(10);
});

test('row page layout: pinned, folded and side properties, relations as sections, kept after a restart', async ({
  launch,
}) => {
  const first = await launch();
  let { window } = first;
  await newDatabase(window, 'Parts');
  await addProperty(window, 'Number', 'Stock');
  await addRow(window, 'Bearing');
  await (await cell(window, 'Bearing', 'Stock')).click();
  await window.keyboard.type('12');
  await window.keyboard.press('Enter');
  await window.keyboard.press('Escape');
  await addRow(window, 'Gear');

  await newDatabase(window, 'Robots');
  await addRow(window, 'Rover');
  await addRow(window, 'Arm');
  await table(window).getByRole('button', { name: 'Add a property' }).click();
  await window
    .getByTestId('add-property-menu')
    .getByRole('menuitem', { name: 'Relation', exact: true })
    .click();
  const setup = window.getByTestId('relation-setup');
  await setup.getByLabel('Related to').selectOption({ label: 'Parts' });
  await setup.getByRole('button', { name: 'Add relation' }).click();
  await expect(header(window, 'Parts')).toBeVisible();

  // Customize the layout from a row page: Tags pinned, the rest folded, Parts as a section.
  const open = async (title: string) => {
    await (await cell(window, title, 'Name')).hover();
    await table(window).getByRole('button', { name: 'Open', exact: true }).click();
    await expect(window.getByTestId('row-peek').getByLabel('Page title')).toHaveValue(title);
    return window.getByTestId('row-peek');
  };
  let peek = await open('Rover');
  await peek.getByRole('button', { name: 'Customize layout' }).click();
  const dialog = window.getByTestId('layout-dialog');
  await dialog
    .getByRole('group', { name: /Pinned under the title/ })
    .getByLabel('Tags')
    .check();
  await dialog.getByLabel('Folded behind “Properties”').check();
  await dialog
    .getByRole('group', { name: 'Relations as sections of the page' })
    .getByLabel('Parts')
    .check();
  await dialog.getByTestId('layout-save').click();
  await expect(dialog).toHaveCount(0);

  await expect(peek.getByTestId('pinned').getByRole('button', { name: 'Edit Tags' })).toBeVisible();
  const fold = peek.getByRole('button', { name: /^Properties/ });
  await expect(fold).toHaveAttribute('aria-expanded', 'false');
  await fold.click();
  await expect(fold).toHaveAttribute('aria-expanded', 'true');
  await expect(
    peek.getByTestId('row-properties').getByRole('button', { name: 'Edit Parts' }),
  ).toHaveCount(0);

  // The section: add a linked page, which shows its Stock, then open it.
  const section = peek.getByTestId('relation-section');
  await expect(section).toContainText('No linked pages');
  await section.getByRole('button', { name: 'Add a page' }).click();
  await window.getByTestId('relation-editor').getByRole('option', { name: 'Bearing' }).click();
  await window.keyboard.press('Escape');
  await expect(section.getByTestId('relation-section-page')).toHaveText(/Bearing.*12/);
  await expect((await cell(window, 'Rover', 'Parts')).getByTestId('relation-page')).toHaveText([
    'Bearing',
  ]);
  await section.getByRole('button', { name: 'Bearing', exact: true }).click();
  await expect(window.getByTestId('row-peek').getByLabel('Page title')).toHaveValue('Bearing');

  // Every page of the database has the layout, side panel included, after a restart.
  await window.getByRole('treeitem').filter({ hasText: 'Robots' }).first().click();
  peek = await open('Arm');
  await expect(peek.getByTestId('relation-section')).toBeVisible();
  await expect(peek.getByRole('button', { name: /^Properties/ })).toBeVisible();
  await quit(first.app);
  ({ window } = await launch());
  await window.getByRole('treeitem').filter({ hasText: 'Robots' }).first().click();
  peek = await open('Rover');
  await expect(peek.getByTestId('relation-section-page')).toHaveText(/Bearing/);
  await expect(peek.getByTestId('pinned')).toBeVisible();

  // The rest of the properties in a side panel instead.
  await peek.getByRole('button', { name: /^Properties/ }).click();
  await peek.getByRole('button', { name: 'Customize layout' }).click();
  await window.getByTestId('layout-dialog').getByLabel('In a side panel (wide windows)').check();
  await window.getByTestId('layout-dialog').getByTestId('layout-save').click();
  const side = peek.getByTestId('properties-side');
  await expect(side.getByRole('button', { name: 'Customize layout' })).toBeVisible();
  await expect(
    peek.getByTestId('pinned-properties').getByRole('button', { name: 'Edit Tags' }),
  ).toBeVisible();
  await expect(side.getByRole('button', { name: 'Edit Tags' })).toHaveCount(0);
});
