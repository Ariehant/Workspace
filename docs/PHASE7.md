# Phase 7: Polish and release (v1.0)

**Status:** in progress. M1 (performance) is done, with two budgets not met yet (opening a
50,000-row database, and typing in a 10,000-block page). The repository's presentation (the
README, user guides and a link check in CI) was done ahead of the milestones.

## Context

Phases 0–6 are complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE6.md](PHASE6.md) for
automations and the API). The roadmap's goal for this phase ([PLAN.md](PLAN.md#4-phased-roadmap))
is **"Release v1.0"**: a Workspace that someone can install, keep up to date, use in their own
language and with a screen reader, and trust with a large workspace.

The roadmap's scope for this phase, and what earlier phases left for it:

- **Performance:** pages with 10,000 blocks and databases with 50,000 rows, with benchmarks in
  CI.
- **Accessibility:** a pass over the whole app.
- **Languages and formats:** UI translations, and date and number formats.
- **Updates and packaging:** auto-update for the AppImage, signed packages, Snap and Flatpak, and
  an apt repository.
- **More importers:** Evernote, Confluence and Trello.
- **Gaps left by earlier phases:**
  - image crop, and the optional Unsplash cover gallery (Phase 1)
  - server-side export and PDF for the web app, and offline storage in the web app (Phase 4)
  - formatting inside text property values (found by the Phase 6 conformance test)
  - the desktop E2E teardown hang (the page icon test, on every full run since Phase 6)
- **The v1.0 sign-off:** the feature inventory in [PLAN.md §3](PLAN.md#3-feature-inventory-parity-target-ai-excluded),
  side by side with Notion; a license; the first release.

The roadmap budgets "4+ weeks, then ongoing". The estimate below is about 8 weeks, in seven
steps: six milestones and the release check. If time runs short, cut these, in this order:

1. the Unsplash cover gallery (M6)
2. offline storage in the web app (M6)
3. the Confluence importer (M5)
4. Snap (M4; Flatpak and the apt repository stay)
5. translations beyond the first two languages (M3)

**Done ahead of the milestones (presentation):**

- **The README:** what Workspace is and why, screenshots, the feature overview, the three ways
  to start (desktop, server, API), architecture and the roadmap.
- **User guides** in `docs/`: [features](features.md), [the desktop app](desktop.md),
  [self-hosting](self-hosting.md) and [the API](api.md), with [an index](README.md), and
  [CONTRIBUTING.md](../CONTRIBUTING.md).
- **Screenshots** (`docs/images/`) from a Playwright spec (`apps/desktop/e2e/readme-shots.spec.ts`)
  that builds a workspace from the built-in templates. It's skipped unless asked for, so
  the screenshots can be made again after any UI change.
- **A link check** (`scripts/check-links.mjs`): every relative link and `#anchor` in the
  repository's Markdown files must resolve (GitHub's heading slugs, numbered duplicates
  included). It runs in `pnpm lint`, so in CI, and `--external` checks web links on demand.
- **Dropped:** the Phase 3 check with a real Notion export. There's no export to test with, and
  the workspace will be built from scratch rather than imported. The importer stays, tested
  against generated fixtures and our own exports.
- **Fixed on the way:** the "Tasks and projects" template's timeline now runs from Start to End
  (it showed one-day bars); the packages' description no longer calls the server "planned";
  `.env.example` says that email also sends digests.

**Already in place (reused, not rebuilt):**

- **Virtualized views:** the table, and board columns past a threshold, render only what's in
  view (`packages/app/src/database/virtual.ts`). Benchmarks will say where else it's needed.
- **Packaging:** electron-builder makes the `.deb` (with its AppArmor profile) and the AppImage
  (`apps/desktop/electron-builder.yml`); CI builds both and smoke-tests them under xvfb.
- **Importers:** `packages/importers` turns Markdown and HTML into blocks with the editor's own
  parser, and infers database types from CSV. Evernote, Confluence and Trello are new front
  ends on it.
- **Exporters:** `packages/exporters` renders Markdown, HTML and CSV without a DOM, so the server
  can export for the web app; only PDF needs a browser.
- **Dates:** reminders already follow the person's time zone (Phase 5 M6), and dates are stored
  as ISO strings, so formats are a display concern.

**Not in Phase 7:**

| Item                        | Why                                                            |
| --------------------------- | -------------------------------------------------------------- |
| Windows and macOS builds    | The target is Ubuntu; Electron makes them possible later       |
| A mobile app                | The web app works in mobile browsers; a native app is post-v1  |
| Public (OAuth) integrations | Internal integrations with tokens cover self-hosting (Phase 6) |
| A web clipper               | Optional, later (PLAN §3)                                      |
| Notion AI features          | Out of scope for the project                                   |

## Approach

### Performance

**Budgets** (on a CI runner, `ubuntu-24.04`, 4 cores):

| Case                                                   | Budget                          |
| ------------------------------------------------------ | ------------------------------- |
| Open a page with 10,000 blocks                         | First paint under 1.5 s         |
| Type in that page                                      | Under 16 ms per keystroke (p95) |
| Open a database with 50,000 rows (table view)          | Under 2 s                       |
| Filter, sort or group those rows                       | Under 300 ms                    |
| Scroll the table, board, list and gallery              | No frame over 50 ms             |
| Quick find over 50,000 pages and rows                  | Under 150 ms                    |
| A desktop's first sync of that workspace from a server | Under 30 s                      |

- **Benchmarks** as Vitest bench files for the pure code (formulas, filters, sorts, rollups,
  the search index) and Playwright traces for the UI cases, with fixtures generated by a script
  (`scripts/fixtures.mjs`).
- **In CI:** results are compared with the budgets, and with the base branch's last run; a
  regression over 20% fails the job.
- **Likely work:** computed values (formulas, rollups) cached per row and invalidated by
  dependency; the remaining views virtualized; the editor's node views made lazier for long
  pages; row indexing moved off the main thread; snapshot-based first sync rather than replaying
  update logs.

### Accessibility

- **Target:** WCAG 2.1 AA in both themes.
- **Automated:** axe-core runs in the E2E suite on every main screen and dialog, with no
  violations allowed.
- **By hand:**
  - every action reachable from the keyboard, with a visible focus ring
  - menus and dialogs that trap and return focus
  - the editor, tables and boards usable with Orca on Ubuntu
- **Likely work:** roles and names on custom widgets (the page tree, database cells, the slash
  menu); live regions for sync status and notifications; contrast fixes in the dark theme;
  reduced motion.

### Languages and formats

- **Translations:** strings move into message catalogs (ICU MessageFormat, through FormatJS),
  with English as the source. Two more languages ship at v1.0, picked by contributor interest.
  A CI check finds strings left out of catalogs.
- **Formats:** a "Language and region" setting: the date format, 12- or 24-hour time, the first
  day of the week, and number formats, defaulting to the system locale. Database number and date
  formats keep their per-property settings.
- **The server** uses the person's language for emails, the form page and published pages.

### Updates and packaging

- **Versions:** semantic versions from a release tag; the app shows its version and the server's.
- **A release workflow** in CI: a tag builds the `.deb`, AppImage, Snap and Flatpak, signs them,
  and publishes a GitHub release with notes.
- **Auto-update:** `electron-updater` for the AppImage, from GitHub releases, with a setting to
  turn it off. The other formats update through their stores.
- **Signing:** packages and the apt repository signed with a project GPG key held in CI secrets;
  AppImages carry an embedded signature.
- **An apt repository** on GitHub Pages, so `apt upgrade` updates the `.deb`.
- **Snap** (strict confinement, with the home, network and desktop plugs) and **Flatpak** (a
  Flathub manifest), each tested by installing it in CI and running the smoke test.
- **The AppImage sandbox:** document the AppArmor profile Ubuntu 24.04 needs, or ship one with
  the `.deb` that covers AppImages installed through it.

### More importers

- **Evernote (`.enex`):** notes as pages, with their formatting (ENML is XHTML), attachments,
  tags (a database of notes with a multi-select), and created and updated dates.
- **Trello (board JSON export):** a database with a board view grouped by list, cards as rows
  (description as content, checklists as to-dos, labels, due dates, members as text), and
  attachments by link.
- **Confluence (HTML space export):** the page tree as pages, with their formatting,
  attachments and links between pages.
- Each is tested against a sample export kept in the repository as a fixture.

### Gaps

- **Image crop:** crop and rotate in the image block, kept as display settings (the stored file
  doesn't change).
- **The Unsplash cover gallery:** optional, enabled when a server admin sets an Unsplash API key;
  searches through the server so the key stays there.
- **Export and PDF for the web app:** the server renders Markdown, HTML and CSV exports with
  `packages/exporters`, and PDFs with a headless Chromium in a job, for the pages the person can
  read.
- **Offline storage in the web app:** the pages you open are kept in IndexedDB, with the outbox,
  so the web app reopens offline and syncs on reconnect.
- **Formatted text properties:** text property values become rich text (marks and links), in the
  app, imports, exports and the API.
- **The E2E teardown hang:** find why closing the app after the page icon test hangs late in a
  long worker, and fix it.

## Milestones

### M1: performance ✅ (two budgets not met yet)

**Changed from the plan:**

- **Fixtures** are a package, `packages/perf`, rather than a script: the same generators feed
  the unit benchmarks and the app's E2E run. They build, deterministically:
  - a page of 10,000 blocks (headings, paragraphs, bullets and to-dos)
  - a Tasks database of 50,000 rows with a select, a number, a date, a checkbox, labels, notes,
    a formula, a relation to a Projects database and a rollup through it, and four views
  - and write them as a desktop workspace (`workspace.db`, indexed).
- **Benchmarks are tests** with limits (Vitest for the pure code, Playwright for the app),
  rather than Vitest bench files, so a slow result fails like any test.
- **Each budget has a target and a limit.** The target is the budget below; the limit is what
  CI holds each run to, above today's results by the spread seen between runs (more where the
  target isn't met yet). A regression fails, and the report shows the gap to the target.
- **Two budgets aren't met yet** (see below): opening the 50,000-row database, and typing in
  the 10,000-block page. Both are bound by how the data and the editor are built, not by a
  slow function; the fixes are larger than this milestone.
- **The first-sync case found a real limit:** a doc over 8 MB couldn't sync at all (one
  update may be 8 MB at most). Large updates now go in parts; see below.

**Found and fixed** (on the 50,000-row database and the 10,000-block page):

| Problem                                                                                                                                     | Before              | After                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------- |
| The app's start, with this workspace                                                                                                        | 17 s                | 1.2 s                         |
| Search index work after one edit to the database (quadratic: full-text rows were updated by page id, which the full-text table can't index) | over 15 min         | 0.15 s                        |
| Opening a doc in the main process (it was decoded, then encoded again for the window)                                                       | 3.7 s               | 0.05 s                        |
| The window encoding the whole database again when it loaded (an update listener was already attached)                                       | 2.1 s               | 0                             |
| Local automations copying the database 3 s after every change, though it had none                                                           | 3.5 s               | 0                             |
| Formula and rollup values (each number formatted with a new `Intl.NumberFormat`)                                                            | 3.1 s               | 0.42 s                        |
| A sort or filter recomputing every formula and rollup (the properties were read again on any view change)                                   | 6.8 s               | 0.4 s                         |
| Leaving a long page (each menu's plugin removal re-rendered all 10,000 blocks)                                                              | 1.5 s               | 0                             |
| Code highlighting (it walked the whole page twice on every transaction, cursor moves included)                                              | every keystroke     | only code blocks that changed |
| Quick find showing a row (its whole database was loaded first)                                                                              | 2–5 s               | from the search index         |
| The first edit's page-history snapshot (the doc was encoded again)                                                                          | 0.75 s              | a copy of what's stored       |
| Syncing a doc over 8 MB (one update may be 8 MB at most, so the database stayed "Syncing 1 change")                                         | never               | in parts, 19–28 s             |
| A second device's first sync (each part of the database loaded and indexed the whole doc again)                                             | 40–54 s             | 17–26 s                       |
| The search index preparing each SQL statement again for every row                                                                           | 6 s of a first sync | prepared once                 |

**Storage** (migration 7 of the desktop's SQLite file):

- **`pages.fts_rowid`** links each index entry to its full-text row, and **`pages.props`**
  keeps a row's property text. Index entries are compared with what's stored and only the
  changed ones are written, by rowid.
- **Incremental database indexing:** the main process reads a database through
  `DatabaseHandle` (only changed rows are read again), keeps each row's index entry while the
  row is unchanged, and after an edit writes the rows that changed: their entries, relation
  links (`replaceLinksOf`) and date reminders (`updatePropertyReminders`).
- **Large updates go to the outbox in parts:** `splitUpdate` (in `packages/sync`) writes an
  update's structs again as runs of at most 4 MB per client, in clock order, then one part
  with the deletions. Each part is an ordinary update, so the server and the protocol don't
  change. An update that can't be read on its own (it builds on structs it doesn't hold) is
  replaced by the doc's whole state, in parts.
- **Docs loaded for incoming updates** stay loaded until 3 s after the last one, so a stream
  of them (a first sync, a doc arriving in parts) loads the doc once.
- **Prepared statements** are cached in `SqliteStore`.
- **Windows open docs from what's stored:** `DocManager.openUpdates` returns the stored
  updates without decoding them (`DocClient` applies a list in one transaction). The main
  process then loads the doc while the window decodes it, rather than on the first edit:
  while the main process works, windows get no input.

**App:**

- `DatabaseHandle` reads the schema, the views and the meta apart, so a view change keeps the
  properties (and the computed values made from them).
- Rollups format their values only for calculations that show text.
- Code highlighting and line numbers update only the code blocks a transaction changed.
- Quick find shows rows of databases that aren't loaded from the search index's title and
  icon.

**Tried and dropped:**

- `content-visibility: auto` on a long page's blocks: Chromium then checks every block's
  visibility each frame, which cost more than the layout it saved.
- Typing on long pages by transaction instead of letting the browser insert text: about 10%
  faster, not worth giving up the browser's own text input.
- A larger V8 young generation for the window: no difference.

**Not met yet, and why:**

- **Opening the 50,000-row database** takes 4.3 to 5.6 s on its own. Decoding its Yjs doc (29 MB,
  1.2 million items) takes about 2 s of that in the window, then the computed values and the
  first render. Options: load rows progressively (show the first screen, then the rest), or
  keep rows in their own docs. The main process also decodes it once (in parallel, about 3 s);
  moving indexing to a worker thread would remove that.
- **Typing in the 10,000-block page** takes 105 to 165 ms per keystroke (p95). It grows with the
  page: about 20 ms at 250 blocks, 25 ms at 1,000 and 41 ms at 3,000. Per keystroke, Chromium
  lays out the whole editable element (about 8 ms here), and ProseMirror's view update and
  y-prosemirror each walk the page's top-level blocks. Options: render only the blocks in view,
  or one editable element per block, as Notion does.
- **Scrolling the board** has frames up to 150 ms (the table, list and gallery stay within
  50 ms). Not profiled yet.
- **Filter, sort and group** take about 300 ms of work each, but up to 1.4 s right after the
  other cases, while the app is still busy with them.
- **Page history** stores a full copy of a doc per editing session; for this database that's
  29 MB. Storing changes between versions would fix it.

**Tests:**

- **`packages/perf`:** the fixtures (deterministic, computed values right, a written workspace
  that opens and searches), and the budget checks (limits, regressions, the report).
- **`budgets.bench.test.ts`** (`pnpm --filter @workspace/perf bench`): decode, snapshot,
  computed values, filter, sort, group and an edit on 50,000 rows; the long page's decode;
  search over 50,000 rows.
- **`apps/desktop/e2e/perf.spec.ts`** (`PERF=1`): open the long page, type, scroll; open the
  database, sort, filter, group, scroll the table, board, list and gallery; quick find; and a
  second device's first sync of the whole workspace from a server.
- **Unit tests** for each fix: an index migrated from version 6, writes limited to the rows
  that changed, docs opened without loading, the update listener attached after the stored
  state, views keeping the properties, incremental code highlighting, and updates split into
  parts that rebuild the same doc (in any order, and merged into a copy that has some of it),
  for a whole state and for a large paste while syncing.
- **CI:** a `perf` job runs both suites and compares the results with the limits and with the
  base branch's last run (more than 20% slower fails), in the job summary. Since November
  2026 the base branch's run is first scaled by the runner's speed: the median ratio of the
  pure-code benchmarks, which run the same code on both. `sync.first` is held to its limit only;
  the same code took 5.5 s to 10.7 s on shared runners.

**Results** (this machine, 4 cores; ranges are across runs, and this machine is noisy):

| Case                           | Budget       | Result                                                              |
| ------------------------------ | ------------ | ------------------------------------------------------------------- |
| Open a page with 10,000 blocks | under 1.5 s  | ✅ 70–120 ms                                                        |
| Type in that page (p95)        | under 16 ms  | ❌ 105–165 ms                                                       |
| Open the 50,000-row database   | under 2 s    | ❌ 4.3–5.6 s alone, up to 9.5 s after the other cases               |
| Filter, sort or group          | under 300 ms | about 300 ms of work each; 0.4–1.4 s measured after the other cases |
| Scroll the views (worst frame) | 50 ms        | ✅ table 50, list 33, gallery 17, the long page 33; ❌ board 150    |
| Quick find over 50,000 rows    | under 150 ms | ✅ 108–121 ms                                                       |
| A second device's first sync   | under 30 s   | ✅ 17–26 s                                                          |

The pure-code suite on the same database: decode 2.5–3.1 s (target 1 s), a snapshot and the
computed values about 0.5 s each, filter, sort and group 50–150 ms, an edit 63–85 ms (target
50 ms), the long page's decode about 0.2 s, and search about 45 ms.

**Runs:** unit tests all pass. Desktop E2E: 146 passed (3 skipped: the two perf tests and the README screenshots,
which run only when asked) on the first run; the second run, a day later, failed the
timeline drag test. That was a real bug, not timing: the axis starts two weeks before the earliest
bar (or today), so dragging the earliest bar later moved the whole axis with it, and the bar
stayed where it was on screen. The timeline now keeps what's on screen in place when its axis
moves; `dated.spec.ts` passes five runs in a row. Web E2E: 3 passed.

### M2: accessibility ✅

- **Done: zoom** (WCAG 1.4.4, resize text). The desktop app had Electron's stock View menu
  items, hidden with the menu bar, and their Zoom In shortcut is `Ctrl+Plus`, which `Ctrl+=`
  doesn't trigger on Linux. Now:
  - `Ctrl+=` (or `+`), `Ctrl+-` and `Ctrl+0`, keypad included, are handled in the main process
    before the page sees them, and `Ctrl` + wheel steps once per notch (Chromium reports each
    notch twice).
  - Levels are Chromium's, 50% to 300% (`packages/core/src/zoom.ts`). One level for every
    window, kept in the settings and across a switch to a server's workspace. Windows use the
    `isolated` zoom mode so the hidden print window, on the same origin, stays at 100%.
  - **Appearance** shows the level with Zoom in, Zoom out and Actual size; the View menu has the
    same. The web app leaves zoom to the browser.
  - **Tests:** `zoom.spec.ts` (keys and wheel sent as the system sends them, the menu, a second
    window, a restart, 50% and 125% screenshots); unit tests for the levels.
- **Fixed on the way: mention notifications cut mid-word.** The server read a workspace's changes
  1 s after the first one, so a mention typed mid-sentence notified with half the sentence
  ("Torque check by plea"). It now waits until changes pause for 1 s (5 s at most), so the
  notification shows what was written. Found by the inbox E2E; unit tests for the scheduling.
- **Runs** (zoom and the notification fix): unit tests all pass; desktop E2E 147 passed (3 skipped)
  twice, web E2E 3 passed. The zoom commit's own first desktop run failed only the inbox test,
  which the notification fix addresses (that test then passed three runs in a row).
- **axe-core in the E2E suite** (`a11y.spec.ts`): WCAG 2.1 A and AA plus axe's best practices,
  no violations allowed, on 25 screens and dialogs in each theme (pages, every menu, quick
  find, templates, trash, sync, the slash menu, page history, export, a database in all eight
  layouts with its panels, cells and row page) and, on a server workspace, sign-up, sharing,
  members, the inbox and comments. The first run found 10 kinds of problems on most screens:
  - **Contrast:** grey text was 4.2:1 on the sidebar (light) and the faint grey 2.2–2.5:1 in
    both themes; the blue was 3.6–3.9:1 under white text. New values: muted `#63625e`, faint
    `#706e6a`, accent `#1b6fc8`, danger `#c83a34`, warning `#a35f1c` (light); muted `#a8a8a8`,
    faint `#929292`, and an accent of `#5aa5f0` with dark text on it (dark), since no single
    blue reads both as text on the dark background and under white text. Danger buttons take
    a `danger-fg` colour for the same reason. Inline code uses the danger red.
  - **Names:** the editor ("Page content"), every popover (a name is now required by the
    type), the workspace button and the row page's property buttons (their names contain what
    they show, WCAG 2.5.3); the page title is the level-one heading.
  - **Roles:** the database grid's rows now hold only cells (row handle, "+ New", group
    headers, calculations and "Add a property" are cells or column headers); "Add a view" is
    outside the view tabs; the font choice in the page menu is a radio group of menu items;
    lists with no options aren't listboxes; the timeline and the template previews are
    focusable regions, so the keyboard can scroll them.
  - **Known exception:** the property and view menus start with a name field, as Notion's do,
    and ARIA menus may only hold items. Their check allows `aria-required-children`.
- **Keyboard** (`keyboard.spec.ts`: pages, a database and sharing, from the keyboard alone):
  - The page tree follows the ARIA tree pattern: one Tab stop (the open page), ↑ ↓ Home End
    to move, → ← to expand and collapse, Enter or Space to open. Before, Tab only reached each
    row's small buttons.
  - Buttons that appear on hover also appear when they have the focus.
  - Tabbing into a database table selects its first cell; the selected cell is the grid's
    `aria-activedescendant`. Tab moves along a row as before, and now leaves the grid past
    either end (it was a keyboard trap).
  - Dialogs give the focus back to what opened them, or to the control that replaced it (the
    Share button is drawn anew once a page has its own access).
  - Enter in a new page's title moves the focus at once: keys typed straight after it went
    into the title while the editor waited a frame to focus.
  - Enter in Settings → Sync's workspace name starts syncing.
- **Screen readers:** sync state changes (not every change counted) and new notifications are
  announced through polite live regions; the unread count is part of the inbox button's name.
- **Focus and motion:** a visible focus ring wherever a control doesn't draw its own; with the
  system's reduced motion setting, no transitions, animations or smooth scrolling (JS scrolling
  included).
- **Not automated:** the check with Orca on Ubuntu, by hand, is part of the release check.
- **Runs:** unit tests all pass; desktop E2E 153 passed (3 skipped) twice, web E2E 3 passed.
  The first full runs caught two regressions from this work, both fixed: a click into a wide
  table selected its first cell (for the keyboard) and scrolled the clicked one away, and a
  dialog's focus return pulled the focus out of a dialog opened straight after it. The README
  screenshots are new (the colours changed).

### M3: languages and formats ✅ (formats; the string catalogs wait for a translation)

- **Language and region** (workspace menu → Language and region…): the language (English, the
  only one so far) and the region, which sets how dates, times and numbers look and the first
  day of the week. The date format, the clock (12- or 24-hour) and the week start can each be
  chosen on their own; "Automatic" follows the region, and the region defaults to the
  system's. A preview shows the result.
- **How:** formats use the locale `en-<region>`, English as written there (`packages/core/src/
region.ts`): `en-GB` gives 17 Nov 2026 and 15:05, `en-DE` 1.234,5, `en-IN` 12,34,567. The
  week start comes from `Intl.Locale` week info, with a CLDR table where a runtime lacks it.
  Everything that showed a date or a number in US English now reads the region: database
  cells (a property's own date, time or number format still wins), formula results, date
  groups, @-dates, page history, comments, the inbox, the page menu's counts, members,
  integrations, automations and sync. A calendar view starts its weeks on the region's day
  unless the view sets its own. The setting is per device on the desktop and per account on
  the web.
- **The server** has no person to ask on a published page or a form, so it uses its own
  region, `FORMATS_REGION` (default `US`). Its emails show no dates.
- **Not done: message catalogs.** Moving every string into catalogs (FormatJS) with a CI check
  touches every component and changes nothing while English is the only language (your call).
  It is the first step when a translation is wanted; the formats above don't depend on it.
- **Tests:** unit tests for the regions (US, UK, Germany, India; each format on its own; the
  system default); `region.spec.ts` (US by default, UK, Germany, formats chosen one by one, a
  calendar's week, kept after a restart, back to automatic); the dialog in the axe checks. Unit
  tests pin the US formats (`vitest.setup.ts`), so they pass on machines in other locales
  (they failed in core, database and importers under a German locale).
- **Runs:** unit tests all pass (also under a German locale); web E2E 3 passed. Desktop E2E:
  154 passed (3 skipped) on the first run of each round. The second runs found:
  - **A real bug, fixed:** publishing a page right after naming it suggested `/p/page`. The
    address came from the server's search index, which can be a moment behind; the app now
    makes it from the title it shows (`slugFromTitle`, shared with the server). The publish
    test failed two runs in four before, and passes five in five now.
  - **Not reproduced:** two tests ran into the one-minute timeout while starting (the page
    cover, and once the page icon test, each as a run's first test of the app), and
    synced blocks once read the system clipboard while it changed. They passed in 16 runs
    together and in five cold starts each. The timeouts look like the E2E hang M6 is to look
    into, and go there.

### M4: updates and packaging ✅ (Snap and Flatpak checked in CI only)

- **Versions:** one version for the desktop, server and web app, set from the release tag
  (`scripts/version.mjs set`; `pnpm lint` checks they agree). The server's comes from its
  package.json at build time (it was hard-coded), and `/api/auth/config` reports it.
  **Workspace menu → About Workspace** shows the app's version and, when on a server, the
  server's.
- **Auto-update for the AppImage** (`electron-updater`, from GitHub releases): it checks 15 s
  after starting and every 6 hours, downloads in the background, and the sidebar offers
  **Restart to update**. About has "Download updates automatically" and "Check for updates".
  The `.deb`, Snap and Flatpak update through apt and their stores, and About says so.
- **The release workflow** (`.github/workflows/release.yml`), on a `v*` tag: builds the `.deb`,
  AppImage, Snap and Flatpak; checks that the AppImage updates itself to the next version;
  installs each package in a clean system and starts it (the `.deb` in Ubuntu 24.04 and 26.04
  containers, 26.04 since the release check as 25.04 reached its end of life; the AppImage in a
  container; the Snap and the Flatpak on the runner); then
  publishes the GitHub release (checksums, signatures), the apt repository on GitHub Pages and
  the Snap Store upload. A tag with a `-` (`v1.0.0-rc.1`) is a pre-release on GitHub only.
- **Signing** with the project's GPG key from the `GPG_PRIVATE_KEY` secret: `SHA256SUMS.asc`,
  `.asc` signatures for the `.deb` and the AppImage, and the apt repository's `InRelease` and
  `Release.gpg`. Without the secret the workflow skips signing and says so. (electron-builder's
  embedded AppImage signature is left out: AppImageUpdate tooling is the only thing that reads
  it, and the `.asc` covers the same.)
- **The apt repository** (`scripts/apt-repo.sh`): `pool/` keeps every release, `dists/stable`
  is made again from it each time.
- **The AppImage sandbox:** the desktop guide gives the AppArmor profile Ubuntu 24.04 needs
  (`userns` for the AppImage's mount path), to check by hand at the release check.
- **Checked here:** the `.deb` installs in a clean Ubuntu 24.04 container and starts; a signed
  apt repository built from it installs in another clean container with `apt`; the AppImage
  0.1.0 finds 0.1.1 on a local feed, downloads it and replaces itself (and the new file reports
  0.1.1). CI's package job now runs that update test on every change.
- **Not checked here:** the Snap and the Flatpak need snapd and flatpak-builder, which this
  environment can't run; their build and install steps run in the release workflow on GitHub's
  runners, the first time on a tag. The Snap Store upload and the Flathub listing need the
  accounts (decisions, below).
- **Tests:** `about.spec.ts` (the version, no update controls on a build that isn't an
  AppImage); About in the axe checks; `scripts/test-appimage-update.sh`; `pnpm lint` checks the
  apps' versions agree.
- **Runs:** unit tests all pass; desktop E2E 155 passed (3 skipped) twice, web E2E 3 passed. The
  first round's second run caught a real bug, fixed: after picking a mention in a comment, or
  a suggestion in the formula editor, the caret moved a frame later, so a key typed in that
  frame was pushed behind the rest ("@Bob please?" became "@Bob lease?p"). The caret now
  moves with the text.

### M5: more importers ✅

- **One Import, by what the files are:** `.enex` files go to the Evernote importer, Trello
  board `.json` files to the Trello one, a zip of Confluence pages to the Confluence one, and
  anything else to the Notion / Markdown / HTML / CSV importer as before (so an `.enex` or a
  board inside a Notion export stays an attachment). The dialog takes `.enex` and `.json`
  too. All three share a builder (`packages/importers/src/build.ts`) for pages, databases with
  typed columns, rows and attachments.
- **Evernote (`.enex`):** each file is a notebook, imported as a database named after it, with
  one row per note: Title, Tags (multi-select), Created and Updated (dates; the row's own
  created time is the note's), and Source (the note's web address). The note's ENML becomes
  its content: formatting, lists, tables, both kinds of checklists (older `<en-todo>` and
  Evernote 10's), and attachments matched by their MD5 (images, PDFs, audio and video as their
  blocks; attachments the note doesn't show are added at its end). Encrypted text can't be
  read, and the report says so.
- **Trello (board JSON):** a database with a **Board** view grouped by List and an **All cards**
  table. Columns: Card, List (in the board's order), Labels (with Trello's colours), Due, Done,
  Members (as text). A card's page has its description (Markdown), checklists as to-dos, its
  web attachments as links and its comments with who and when. Archived lists and cards stay
  behind, and the report counts them. A card's created time comes from its id.
- **Confluence (HTML space export):** a page for the space with the page tree under it (from
  the export's index, else each page's breadcrumbs). Content keeps its formatting; info, note,
  warning and tip panels become callouts, code macros code blocks with their language, task
  lists to-dos, and embedded images image blocks. Attachments are stored under their real
  names (the export numbers them), those the page doesn't show are added at its end, and
  links between pages point at the new pages.
- **Fixtures** in `packages/importers/fixtures`: a notebook with tags, both checklist kinds, an
  image, a PDF and encrypted text; a board with lists out of order, labels, a checklist,
  members, attachments, a comment and archived cards; and a three-level Confluence space with
  a panel, code, tasks, a table, an image, a PDF and links both ways.
- **Tests:** `formats.test.ts` imports each fixture and checks the pages, columns, values,
  blocks, files and links (and MD5 against RFC 1321's vectors), passing in four time zones;
  `import.spec.ts` imports all three in the app and opens what came across.
- **Found on the way, for M6:** quick find asks the search index once per change to the query,
  and the index takes 750 ms to catch up with an import, so a search typed in that moment says
  "No results" until the query changes. Pages are found by title regardless; rows wait for the
  index.
- **Runs:** unit tests all pass (also in four time zones); desktop E2E 156 passed (3 skipped)
  twice, web E2E 3 passed. After the runs, the importer choice was narrowed (an `.enex` or a
  board inside a Notion export stays an attachment); the import tests passed again on that
  build. The first try of the new E2E showed the quick-find lag above: rows searched for right
  after an import weren't found. The test now opens them from their board and table, as a
  person would.

### M6: gaps ✅

- **Image crop and rotate:** the image block's **Crop** button opens a dialog with the image
  turned as it will show, a frame to drag (or move with the arrow keys, Shift to resize),
  shapes to keep (original, square, 4:3, 16:9, 3:4) and quarter turns. The crop (fractions of
  the image), the turn and the shown aspect are kept on the block; the file doesn't change.
  The editor, published pages and HTML / PDF exports draw it with the same CSS
  (`packages/core/src/image-view.ts`), without loading the image first.
- **Formatted text properties:** a text property's value stays its plain text, so filters,
  sorting, search, formulas and CSV work as before; its formatting is kept beside it on the
  row (bold, italic, underline, strikethrough, code, colour, link) and counts only while it
  still matches the value, so any plain write (an older client, a paste, a CSV import) simply
  drops it. Cells, cards and row pages show it; editing uses a one-paragraph editor with
  Ctrl+B, I, U, E, K and a toolbar with colours. Rows, properties and templates copy it; HTML
  and PDF exports keep it (Markdown and CSV stay plain, as Notion's do); Notion HTML imports
  bring cells' formatting; the API reads and writes annotations and links.
- **Export for the web app:** the server makes Markdown & CSV and HTML exports with the
  desktop's exporter, for a page with its sub-pages or everything the person can read, and
  streams the zip; Mermaid diagrams are drawn by the browser first.
- **Offline web app:** the pages it opens are kept in IndexedDB as they change, with the
  edits the server hasn't acknowledged and what it needs to start (the account, the workspace,
  its scopes and settings); a service worker keeps the app's own files. Reloaded without the
  server, it opens where it was, with the edits; when the server is back they're sent. Signing
  out deletes it all from the browser.
- **Unsplash covers:** with `UNSPLASH_ACCESS_KEY` set, the cover picker has an Unsplash tab, in
  the web app and on desktops that sync with that server. Searches go through the server (the
  key stays there), a pick is reported to Unsplash, and the photo is shown from Unsplash with
  the photographer credited on the cover, as Unsplash's API guidelines ask. Covers gained a
  web-address kind for it (the API already gave those as `external`).
- **Quick find** asks the index again (after 1, 2.5 and 5 s) while a query is on screen, so
  rows just imported or edited show up without retyping.
- **The E2E teardown hang:** not seen in any full run since M1 (12 runs), whose fixes took
  away the heaviest background work (local automations copying the database after every
  change, formulas recomputed on any view change), the likely cause of a slow close late in a
  long worker. Should it come back, it can't pass unseen or cost a run: an app that takes over
  20 s to close, or 40 s to show its sidebar, fails its test with the processes still running
  (state and wait channel) and the main process's last output, and is ended so the next test
  starts clean.

**Changed from the plan:**

- **PDFs in the web app** come from the browser's print (the page's print view in a new tab;
  every browser's print saves PDFs), not a headless Chromium on the server: the same pages,
  without a browser to install, update and sandbox on every server.

**Found on the way, fixed:**

- Typing straight into a selected text cell lost the letters after the first: the new editor
  took the focus a frame late. It now takes it as it appears.
- Enter in the link box clicked its button (the browser's way of submitting a form), which
  the cell took as a click on itself and closed the editor.
- Ctrl+K right after Shift+Arrow linked a shorter selection: the browser tells the editor
  about a selection a moment later. It now reads the selection first.
- `PHASE7.md` itself: an M5 edit had repeated half the document.

- **Tests:** `image-view.test.ts` (crop geometry), `rich-text.test.ts` (database),
  `rich-text-input.test.ts`, the exporters', importers' and API model's tests for formatting,
  the server's export, Unsplash and API tests; desktop E2E for crop (and its dialog in the axe
  checks), formatted text and quick find after an import; web E2E for export and PDF, offline
  (the server stopped, the tab reloaded, the server back) and Unsplash covers.
- **Runs:** unit tests all pass. Web E2E 6 passed (export, offline and Unsplash included).
  Desktop E2E, nine full runs on the builds along the way: four all passed (158, 3 skipped);
  twice the page cover test stalled for its minute right after the page icon test, late in the
  worker, the old teardown hang (below, under the release check); twice the formatted text
  test ran against a build from before it. The others: the
  table keyboard test failed 3 runs in 10 on a real bug (Escape and Enter in a text cell typed
  into at once were dropped: the editor was only known after a timer), fixed and 15 in 15
  since; and the synced blocks test read the clipboard twice, which X11 can refuse ("Clipboard
  data has changed"), now once.

### Release check (≈ 0.5 weeks)

- **Parity:** go through the feature inventory in PLAN §3 next to Notion, and record the result
  for each line in this document.
- **The release candidate:** tag `v1.0.0-rc.1`, install each package on a clean Ubuntu 24.04
  and 26.04 (25.04 reached its end of life in January 2026), upgrade a server from the Phase 6
  schema, and run the scenario tests against it.
- **The release:** `v1.0.0`, with release notes, the license, and the README's install section
  pointing at the published packages.

#### So far

- **License:** `LICENSE` (the AGPL-3.0 text, from SPDX), `AGPL-3.0-or-later` in every
  package.json (the `.deb` carries it). About shows the license and links to the source; a
  server names its own with `SOURCE_URL`, as the AGPL asks of a modified server.
- **Server upgrade** (`scripts/test-server-upgrade.sh`): the Phase 6 server (built from its
  commit in a worktree) writes a workspace (a desktop syncing pages, content and a database;
  an integration with access), then this server starts on the same database and files. The
  schema didn't change since Phase 6 (no migrations), nor the sync protocol (version 5). The
  session, the desktop's sync, the integration's token and access, the API, database values
  and search all carry over, and formatted text and exports work on the old data. It found a
  bug in the new web export (a page whose own doc was never written, so has no scope yet, was
  refused), fixed.
- **Packages:** the `.deb` installs in a clean Ubuntu 24.04 container and starts (its smoke
  test). Ubuntu 25.04 reached its end of life in January 2026 (its archive moved, so apt in it
  fails): the release workflow now tests the `.deb` on 24.04 and 26.04, the supported LTS
  releases. 26.04 can't be pulled here (Docker Hub's rate limit, and its mirror isn't
  reachable from this environment), so it's checked in CI, on the tag.
- **Release notes:** `docs/releases/v1.0.0.md`; the release workflow uses a version's notes
  (GitHub's generated ones list pull requests, and this repository has none).
- **The E2E hang**, twice in nine full runs since M6 started: the page cover test, right
  after the page icon test with about 110 tests in the worker, stalls for its minute, and the
  worker's teardown times out. None of the guards spoke: not the launch, not the start, not
  the teardown's close. The test restarts the app mid-way with `quit()`, a plain
  `app.close()` with no limit, so that's where it stalls: closing the app, as in Phase 6.
  `quit()` now closes through the same guard, so the next time names the processes still
  running and what they're waiting on. Two full runs since: no hang (one all passed, 158; the
  other had one failure, the mention notification test, below).
  - **Found (Phase 8 N2):** the guard caught it, and logging each step of quitting showed
    where it is. The app's own cleanup all finishes, up to Electron's `quit` event; then
    Chromium doesn't end the process. The window's process has exited and the main process
    waits. Saving a cover image's position and quitting at once brings it on, in up to half of
    the runs of that test. A watchdog thread now ends the process 4 s after quitting if it's
    still running (see [PHASE8.md](PHASE8.md#n2-tabs-embeds-of-any-site-link-mentions)).
- **The mention notification test** failed once (Bob's inbox never showed Ada's mention in
  20 s) in eleven full runs, and passed 40 times in a row after, on its own and alongside a
  full run. Not understood yet: it now checks the mention is on Ada's page first, so the next
  time says whether it never went in or the server never delivered it.
- **Left for a person:** a pass with Orca on a real desktop, and the AppImage's AppArmor
  profile on a real Ubuntu 24.04 (neither runs in a container).

#### Parity (PLAN §3, line by line)

✅ there; ◐ there with a difference; ✗ not there.

| Inventory line                                                                                    |     | Notes                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------- |
| Text blocks: headings (and toggle headings), lists, to-dos, toggle, quote, callout, divider       | ✅  |                                                                                                                           |
| Code (highlighting, language picker), equations, Mermaid                                          | ◐   | Highlighting is highlight.js (lowlight), not Shiki, for bundle size (Phase 1)                                             |
| Simple table, columns, table of contents, breadcrumb, link to page, synced blocks                 | ✅  |                                                                                                                           |
| Buttons and template buttons                                                                      | ✅  |                                                                                                                           |
| Media: images (resize, caption, crop), video, audio, PDF, files, bookmarks, embeds                | ◐   | Embeds from YouTube, Vimeo, Loom, Figma, CodePen and Google Maps; no GitHub gists or other sites yet (a bookmark instead) |
| Inline formatting, mentions (page, person, date, reminder), emoji, inline equations               | ✅  |                                                                                                                           |
| Slash menu, Markdown shortcuts, turn into, drag handle, multi-block selection, paste, undo, find  | ✅  | Find and replace in a page                                                                                                |
| Page settings: icons, covers (upload, gallery, Unsplash), full width, small text, fonts, lock     | ✅  | Unsplash with a server key (M6)                                                                                           |
| Views: table, board, list, gallery, calendar, timeline, chart, form                               | ✅  |                                                                                                                           |
| Properties, formulas (Formula 2.0), relations, rollups, created / edited, unique ID, button       | ✅  | Text properties keep formatting (M6)                                                                                      |
| Filters (nested), sorts, groups, sub-groups, calculations, hidden properties, card preview / size | ✅  |                                                                                                                           |
| Inline / full-page databases, linked views, templates, sub-items, dependencies, row locking       | ✅  |                                                                                                                           |
| Row pages: side peek, center peek, full page                                                      | ✅  |                                                                                                                           |
| Automations: property and schedule triggers; set property, add page, notify, webhook              | ✅  |                                                                                                                           |
| Sidebar: tree, drag and drop, favorites, private pages, teamspaces, recently viewed, trash        | ◐   | Recently viewed pages are quick find's list before you type, not a sidebar section                                        |
| Quick find with filters and full text                                                             | ◐   | Full text over titles, content and rows; no filters (by teamspace, author or date) yet                                    |
| Backlinks, history, templates gallery, duplicate, move to, windows and tabs, keyboard shortcuts   | ✅  | The common shortcuts (the [desktop guide](desktop.md#keyboard-shortcuts) lists them)                                      |
| Themes; language and date formats                                                                 | ◐   | Formats follow the region (M3); the UI is English only until a translation comes (your call)                              |
| Accounts, workspaces, members, groups, guests                                                     | ✅  |                                                                                                                           |
| Sharing per page and teamspace with four levels, inherited                                        | ✅  |                                                                                                                           |
| Real-time co-editing, cursors, presence                                                           | ✅  |                                                                                                                           |
| Comments (inline and page, resolve), suggested edits                                              | ✅  |                                                                                                                           |
| Inbox: mentions, comments, reminders; desktop notifications                                       | ✅  |                                                                                                                           |
| Publish to web with SEO options, custom domain, analytics                                         | ◐   | No custom domains (left out in Phase 5); published at `/p/<slug>` on the server                                           |
| Import: Notion, Markdown, CSV, HTML, text, Evernote, Confluence, Trello                           | ✅  | M5                                                                                                                        |
| Export: Markdown & CSV, HTML, PDF, backup                                                         | ✅  | The web app exports too (M6); backups are the desktop's                                                                   |
| REST API in Notion's shape, tokens, webhooks                                                      | ✅  | Differences in the [API guide](api.md#differences-from-notion)                                                            |
| Web clipper (later, optional)                                                                     | ✗   | Optional in the plan; not started                                                                                         |

The gaps that would take days, not weeks: embeds from any site (a sandboxed frame, as Notion's
"Embed" block does), and quick find filters. Custom domains need the server's Caddy to issue
certificates on demand, and a check that it only does so for domains a workspace has added.

## Decisions needed

These are yours to make; the milestones that need them say so when they start.

- **Decided:**
  - the license: AGPL-3.0, added at the release check
  - translations: none for v1.0
  - the two M1 budgets not met (a 50,000-row database, a 10,000-block page): after v1.0
- **Still open:**
  - **Signing keys** (M4): a GPG key for packages and the apt repository, added to the CI
    secrets.
  - **Store accounts** (M4): a Snap Store publisher and a Flathub submission in the project's
    name.
  - **An Unsplash API key** (M6), if the gallery should be on by default for your server.

## Verification

As in every phase: `pnpm format:check`, `pnpm lint` (with the link check), `pnpm typecheck` and
`pnpm test`; the desktop E2E twice under xvfb and `pnpm test:e2e:web`; then the notes in this
document, the README's status, a commit and a push. From M1 on, the benchmarks run too, and from
M4 on, the packages are installed and smoke-tested in CI.
