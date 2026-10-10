# Phase 7: Polish and release (v1.0)

**Status:** in progress: M1 (performance). The repository's presentation (the README, user
guides and a link check in CI) was done ahead of the milestones.

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

### M1: performance (in progress)

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
  CI holds each run to. They're equal where the target is met. Where it isn't yet, the limit
  sits above today's result: a regression still fails, and the report shows the gap.
- **Two budgets aren't met yet** (see below): opening the 50,000-row database, and typing in
  the 10,000-block page. Both are bound by how the data and the editor are built, not by a
  slow function; the fixes are larger than this milestone.
- **Found by the first-sync case, and being fixed:** a doc whose state is over 8 MB can't
  sync. One update may be at most 8 MB, so the 50,000-row database (29 MB) stays in the
  outbox ("Syncing 1 change"). Large updates will go in chunks.

**Found and fixed** (on the 50,000-row database and the 10,000-block page):

| Problem                                                                                                                                     | Before          | After                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------- |
| The app's start, with this workspace                                                                                                        | 17 s            | 1.2 s                         |
| Search index work after one edit to the database (quadratic: full-text rows were updated by page id, which the full-text table can't index) | over 15 min     | 0.15 s                        |
| Opening a doc in the main process (it was decoded, then encoded again for the window)                                                       | 3.7 s           | 0.05 s                        |
| The window encoding the whole database again when it loaded (an update listener was already attached)                                       | 2.1 s           | 0                             |
| Local automations copying the database 3 s after every change, though it had none                                                           | 3.5 s           | 0                             |
| Formula and rollup values (each number formatted with a new `Intl.NumberFormat`)                                                            | 3.1 s           | 0.42 s                        |
| A sort or filter recomputing every formula and rollup (the properties were read again on any view change)                                   | 6.8 s           | 0.4 s                         |
| Leaving a long page (each menu's plugin removal re-rendered all 10,000 blocks)                                                              | 1.5 s           | 0                             |
| Code highlighting (it walked the whole page twice on every transaction, cursor moves included)                                              | every keystroke | only code blocks that changed |
| Quick find showing a row (its whole database was loaded first)                                                                              | 2–5 s           | from the search index         |
| The first edit's page-history snapshot (the doc was encoded again)                                                                          | 0.75 s          | a copy of what's stored       |

**Storage** (migration 7 of the desktop's SQLite file):

- **`pages.fts_rowid`** links each index entry to its full-text row, and **`pages.props`**
  keeps a row's property text. Index entries are compared with what's stored and only the
  changed ones are written, by rowid.
- **Incremental database indexing:** the main process reads a database through
  `DatabaseHandle` (only changed rows are read again), keeps each row's index entry while the
  row is unchanged, and after an edit writes the rows that changed: their entries, relation
  links (`replaceLinksOf`) and date reminders (`updatePropertyReminders`).
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

- **Opening the 50,000-row database** takes 4.3 to 5.6 s. Decoding its Yjs doc (29 MB,
  1.2 million items) takes about 2 s on its own in the window, then the computed values and the
  first render. Options: load rows progressively (show the first screen, then the rest), or
  keep rows in their own docs. The main process also decodes it once (in parallel, about 3 s);
  moving indexing to a worker thread would remove that.
- **Typing in the 10,000-block page** takes 115 to 185 ms per keystroke (p95). It grows with the
  page: about 20 ms at 250 blocks, 25 ms at 1,000 and 41 ms at 3,000. Per keystroke, Chromium
  lays out the whole editable element (about 8 ms here), and ProseMirror's view update and
  y-prosemirror each walk the page's top-level blocks. Options: render only the blocks in view,
  or one editable element per block, as Notion does.
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
  state, views keeping the properties, incremental code highlighting.
- **CI:** a `perf` job runs both suites and compares the results with the limits and with the
  base branch's last run (more than 20% slower fails), in the job summary.

**Results so far** (this machine, 4 cores): the pure-code suite all within its limits
(decode 2.8 s and an edit 67 ms over target); in the app, the long page opens in 0.12 s and
scrolls at 50 ms frames at worst. The full table comes with the sync fix.

**Runs so far:** unit tests all pass; desktop E2E 146 of 146 (one helper updated for the new
open API, then re-run); web E2E 3 of 3.

### M2: accessibility (≈ 1 week)

- axe-core in the E2E suite; keyboard paths for every action; focus management; roles and names;
  contrast; reduced motion.
- **Tests:** axe on every main screen and dialog in both themes; keyboard-only E2E for creating a
  page, editing a database and sharing a page.

### M3: languages and formats (≈ 1 week)

- Message catalogs and the extraction check; two translations; the "Language and region"
  setting; formats in the app, emails, forms and published pages.
- **Tests:** formatting units per locale; E2E switching the language and the date format.

### M4: updates and packaging (≈ 1.5 weeks)

- The release workflow, versions, signing, the apt repository, auto-update for the AppImage,
  Snap and Flatpak.
- **Tests:** in CI, each package installed in a clean container and smoke-tested; an AppImage
  updating from a test release to a newer one.

### M5: more importers (≈ 1 week)

- Evernote, Trello and Confluence importers, in the import dialog.
- **Tests:** each against its fixture (pages, databases, attachments, links), and E2E for one.

### M6: gaps (≈ 1.5 weeks)

- Image crop, the Unsplash gallery, export and PDF for the web app, offline storage in the web
  app, formatted text properties and the E2E teardown hang.
- **Tests:** per item; the full desktop E2E passing every test, twice.

### Release check (≈ 0.5 weeks)

- **Parity:** go through the feature inventory in PLAN §3 next to Notion, and record the result
  for each line in this document.
- **The release candidate:** tag `v1.0.0-rc.1`, install each package on a clean Ubuntu 24.04
  and 25.04, upgrade a server from the Phase 6 schema, and run the scenario tests against it.
- **The release:** `v1.0.0`, with release notes, the license, and the README's install section
  pointing at the published packages.

## Decisions needed

These are yours to make; the milestones that need them say so when they start.

- **The license** (before the release check): for example MIT or Apache-2.0 for the most reuse,
  or AGPL-3.0 to require that changes to a hosted server are shared.
- **Signing keys** (M4): a GPG key for packages and the apt repository, added to the CI
  secrets.
- **Store accounts** (M4): a Snap Store publisher and a Flathub submission are in the project's
  name.
- **The first two translations** (M3).
- **An Unsplash API key** (M6), if the gallery should be on by default for your server.

## Verification

As in every phase: `pnpm format:check`, `pnpm lint` (with the link check), `pnpm typecheck` and
`pnpm test`; the desktop E2E twice under xvfb and `pnpm test:e2e:web`; then the notes in this
document, the README's status, a commit and a push. From M1 on, the benchmarks run too, and from
M4 on, the packages are installed and smoke-tested in CI.
