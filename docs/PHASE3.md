# Phase 3: Power features

**Status:** M1 done. M2 next.

## Context

Phases 0–2 are complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE1.md](PHASE1.md) and [PHASE2.md](PHASE2.md)): the block editor, navigation, and databases with every view type, formulas, relations, rollups, templates and linked views.

Phase 3 goal from the roadmap ([PLAN.md](PLAN.md) §4): **"A real Notion export imports with no meaningful loss."** The roadmap's scope for this phase is:

- synced blocks and buttons
- page history and backlinks
- a templates gallery
- multiple windows and tabs
- import and export, with Notion's export zip first
- Mermaid diagrams, plus polish for KaTeX and code blocks (both already exist from Phase 1)

The roadmap budgets 3–4 weeks. Import/export is the largest part and the one the exit criterion rests on, so it gets two milestones of its own. There are six milestones in all, each committed and pushed on its own with tests.

**Already in place (reused, not rebuilt):**

- **Multiple windows:** File → New Window, synced live through the main-process `DocManager`.
- **Block ids:** every block has a stable `id` (Phase 1), which synced blocks, backlinks to blocks and import link rewriting rely on.
- **KaTeX and code highlighting** (lowlight).
- **Data copying:** `copyPageContent`, `duplicatePage` and `copyDatabase`, used by templates, duplication and imports.
- **Search index:** the SQLite FTS index of pages and rows, which backlinks and imports feed.

**Not in Phase 3:**

| Item                                                 | Goes to                                        |
| ---------------------------------------------------- | ---------------------------------------------- |
| Evernote, Confluence and Trello importers            | Phase 7 (polish), after Notion import is solid |
| Web clipper                                          | Later, optional                                |
| Button actions that call webhooks or run automations | Phase 6 (automation)                           |
| History of who changed what (several users)          | Phase 5 (accounts); history here is per device |

## Milestones

### M1: synced blocks and buttons ✅

- **Synced blocks:**
  - "Copy and sync" in the block menu, or `/synced block`, makes a synced block. Pasting one elsewhere (or "Paste and sync") shows the same content in the other place, and an edit in either place edits both.
  - **Storage:** the content lives in its own Yjs doc (`kind: 'synced'`, guid = synced block id). Each place holds a `syncedBlock` node that points at it, and every node view binds a nested TipTap editor to that doc's fragment. Cross-window sync then comes for free from `DocManager`, like any other doc.
  - The original shows an outline and "Editing in N places"; a copy shows "Synced from <page>" with a link back.
  - "Unsync" turns one copy into normal blocks (its content is copied in). Deleting the original asks first and then unsyncs the copies.
  - Backlinks, search and export see the content of synced blocks.
- **Buttons:**
  - A `button` block with a label, a color, and a list of steps. Steps can insert blocks (a template of blocks under the button, like Notion's old template button), add a page to a database with property values, edit pages in a database (set properties on rows that match a filter), open a page, or show a confirmation.
  - **Button property** on databases: the same steps, run per row, plus "edit this row".
  - Steps run as one Yjs transaction per doc, so a single undo reverts them.
  - "@today" and "@me" placeholders work in step values, and in database templates too (which closes the M7 gap).

**M1 notes:**

- **Synced blocks** (`packages/editor/src/nodes/synced-block.tsx`):
  - The content lives in its own Yjs doc (guid = the synced block id) under the same content field as pages. Each `syncedBlock` node renders a nested `PageEditor` bound to that doc. Edits appear everywhere the block is shown, in every window, through `DocManager` like any other doc.
  - The doc records the page it was made in (`syncedSource`). The original's label reads "Synced block"; copies read "Synced from <page>" and link back.
  - Ways to make one: `/synced block`, or "Turn into synced block" in the block menu, which moves the block's content into a new synced doc.
  - "Copy and sync" puts the block on the clipboard as HTML, and pasting it anywhere makes another copy. A normal copy of a synced block pastes as a synced copy too, as in Notion.
  - "Unsync" replaces a copy with ordinary blocks (fresh block ids).
  - A synced block can't show itself inside itself.
  - Nested editors don't render their own block handle or find bar; the page's are used.
  - **Search:** a page's indexed text includes the content of the synced blocks it shows, and editing a synced block re-indexes the pages showing it (`DocManager.syncedHosts`).
- **Buttons:**
  - Step types (`ButtonStep` in core): insert blocks, add a page to a database, edit pages in a database (optionally only those matching a filter rule), edit this page (button property only), open a page, and show a confirmation (declining stops the rest).
  - **Button block** (`nodes/button.tsx`): its template blocks live in a doc with the button's id, edited in the button editor with a nested editor. Inserted copies get fresh block ids. `/button` opens the editor right away.
  - **Button property:** a computed property type whose cell is a button. It runs per row, and "Edit this page" sets values on that row. Its steps are edited from "Edit button" in the column menu, or right after adding it.
  - **Running steps:** database steps run in `runDatabaseStep` (database package), so relations stay two-way. The app loads the databases involved first (`runButton`).
  - **Value editor:** values are typed per property. `@today` and `@me` are accepted; options are matched by name, and new ones are created.
- **Placeholders:** `resolvePlaceholders` fills `@today` (a date's start or end) and `@me` (in a person list) when a button runs or a template is used (`addRowFromTemplate`, `applyTemplate`). While editing a template, the date editor offers "Today (when used)" and the person editor "Me (when used)". This closes the Phase 2 M7 gap.
- **Not done:**
  - The original synced block doesn't yet say "Editing in N places". It needs the links index from M2.
  - Deleting the original doesn't ask first; copies keep working because the content has its own doc.
  - Each button step runs in its own transaction per doc, so undoing a multi-step button takes more than one undo.
  - Export of synced content comes with M5.

### M2: backlinks and page history

- **Backlinks:**
  - A `links` table in SQLite (from page or row, to page or row, block id) is filled by the indexer from page mentions, link-to-page blocks, `workspace://` links and relation values. It is rebuilt incrementally whenever a doc is re-indexed.
  - A "N backlinks" control under the page title expands to the list of linking pages, each with a snippet of the block around the link. Clicking one opens that page at that block.
  - The page "…" menu gets a "Show backlinks" setting: always, as a popover, or off, as in Notion.
- **Page history:**
  - Snapshots are stored in a `doc_versions` table (doc id, time, Yjs state). A snapshot is taken after 10 minutes of editing (as one session), before compaction of the update log, and before destructive actions (applying a template, restoring a version, importing over a page).
  - Retention: everything from the last 7 days, then one snapshot per day for 90 days.
  - Page menu → "Page history" opens a dialog: a list of versions on the left, a read-only rendering of the selected version on the right, and the blocks added or removed since then highlighted.
  - "Restore" replaces the page content with the version's inside one transaction on the live doc, so it merges correctly and can be undone. It takes a snapshot first.
  - Database rows' pages have history too. Database docs (schema, views, rows) get a simpler "Restore deleted property/view" list rather than a full diff view.

### M3: tabs and the templates gallery

- **Tabs:**
  - Each window has a tab bar. Ctrl+T opens a new tab, Ctrl+W closes one, and Ctrl+Tab / Ctrl+Shift+Tab switch between them.
  - Ctrl+click (or middle-click) on a page link, a sidebar item or a quick find result opens the page in a new tab.
  - Tabs can be dragged to reorder them, or out of the window to make a new window.
  - Each tab keeps its own back/forward history and scroll position.
  - Open tabs per window are saved in settings and restored on start.
- **Templates gallery:**
  - "Templates" in the sidebar opens a gallery of built-in page templates grouped by category (Personal, Projects, Engineering, Robotics lab), each with a preview. "Use template" copies it into the workspace.
  - The built-in templates are ordinary workspace pages exported to the app's own JSON format (from M5) and bundled with the app. This includes the five Phase 2 exit-check databases (Tasks + Projects, reading list, habit tracker, CRM, content calendar) and a few page templates (meeting notes, weekly review, design doc, experiment log).
  - "Save as template" in the page menu adds a page (with its sub-pages and databases) to a local "My templates" category.

### M4: diagrams and code

- **Mermaid:** a code block in `mermaid` (or `/mermaid`) shows the rendered diagram with Code / Preview / Split modes. It renders in a sandboxed iframe with mermaid lazy-loaded, so the editor bundle doesn't grow. Render errors show the message under the code. Exports include the diagram as SVG.
- **Code blocks:**
  - line numbers (optional per block) and a caption
  - Tab and Shift+Tab indent and outdent the selected lines
  - more languages through lowlight's full set, loaded on demand
  - "Copy" keeps the plain text
- **Equations:** a KaTeX macro set per workspace (`\R`, `\vec` and so on), and better error display while typing. Block equations get a copy-as-LaTeX action.

### M5: export

- **Formats:**
  - **Markdown + CSV, in Notion's layout:** pages become `.md` files named `Title <id>.md`, sub-pages go in folders, databases become a `.csv` plus one `.md` per row, and attachments are copied next to the pages that use them. Choosing this layout lets our own importer (M6) round-trip it, and makes exports readable wherever Notion exports are.
  - **HTML:** one file per page, with styles inlined, images embedded or copied, and databases as tables.
  - **PDF:** Chromium `printToPDF` of the read-only page rendering, with A4/Letter, scale and "include sub-pages" options.
  - **Workspace backup:** a `.zip` holding the raw Yjs state of every doc, the file store and a manifest. "Restore from backup" restores into an empty data dir. This is the lossless format; the others are for people and other apps.
- **Where to start an export:** "Export" in the page menu (this page, optionally with sub-pages), and Settings → "Export all workspace content". Exports run in a worker thread in the main process, with progress and cancel.
- **Shared code:** `packages/exporters` turns blocks into Markdown and HTML and database snapshots into CSV, reusing `readBlocks` and `cellText`.

### M6: import

- **Notion export zip**, both the "Markdown & CSV" and the "HTML" variants. `packages/importers` handles it in four steps:
  1. **Read the zip** (streaming; exports can be gigabytes) and build a tree of pages from the paths and the ids in the file names.
  2. **Pages:** Markdown and HTML become blocks, using the existing Markdown paste pipeline extended for Notion's dialect. That covers callouts (`<aside>`), toggles (`<details>`), to-dos, columns, tables, equations, code with languages, bookmarks, embeds, images and files, page icons and covers (from HTML), and colors (from HTML).
  3. **Databases:** CSV plus the row `.md` files. Property types are inferred, and the HTML export's type information is used when present. Select options keep their colors from HTML. Relations are resolved by matching row titles and ids across databases; rollups and formulas come over as their last values (text) when the formula can't be read, with a note on the property. The first view is a table; the HTML variant also restores view names.
  4. **Links:** links between pages (`../Other%20page%20<id>.md`) are rewritten to `workspace://` links and mentions once every page has its new id. Attachments go into the file store.
- **Other formats:** Markdown files or folders, CSV (into a new database, with type inference), HTML, plain text.
- **How it runs:** "Import" in the sidebar shows a picker, then a progress dialog with a cancel button and a report at the end. The report lists what couldn't be mapped (unsupported blocks, unresolved relations, formulas kept as text). Imports go into a new top-level page named after the zip, so nothing existing is touched; a page snapshot is taken first if importing into an existing page.

## Exit check

"A real Notion export imports with no meaningful loss":

- **Golden fixtures:** Notion exports (both variants) of a workspace covering every block type, every property type, nested pages, inline and full-page databases, two-way relations, rollups, formulas, images, files, equations, code and colors. Each fixture comes with a checked-in description of what it must import to (block types and text per page, property types and values per database, link targets).
- **Round trip:** export our own fixture workspaces (including the Phase 2 template rebuilds) to Markdown + CSV, import that, and compare. Text, structure, property values and links must match. Losses must be the documented ones only (for example, view settings in the Markdown variant).
- **Backup round trip:** backup → restore is byte-identical at the Yjs level.
- **Real samples:** generated fixtures follow Notion's documented export layout, but Notion changes it from time to time. Before signing off, run the importer on at least one real export from a current Notion workspace and fix what it finds.

## Packages

```
packages/
  exporters/   blocks → Markdown/HTML, databases → CSV, Notion-style file layout, backup zip
  importers/   Notion zip (Markdown+CSV, HTML), Markdown, CSV, HTML; the import report
```

Both are plain TypeScript with no UI or Electron dependency, so the sync server's worker can use them later (Phase 4). Zip handling will use `yauzl`/`yazl`, CSV `papaparse` and HTML `parse5`. Markdown should reuse the editor's `@tiptap/markdown` pipeline. Running it outside the renderer (headless, in a worker) still has to be tried in M5; if that doesn't work, the conversion runs in a hidden renderer instead.

## Critical files

- **New:**
  - `packages/editor/src/nodes/{synced-block.tsx, button.tsx, mermaid.tsx}`
  - `packages/app/src/{tabs.tsx, history-dialog.tsx, backlinks.tsx, templates-gallery.tsx, import-dialog.tsx, export-dialog.tsx}`
  - `packages/exporters/*`, `packages/importers/*`
  - `apps/desktop/src/main/{export.ts, import.ts, backup.ts}`
- **Modified:**
  - `packages/core/src/{schema.ts, blocks.ts, links.ts}` (synced docs, link extraction)
  - `packages/storage-local/src/{sqlite-store.ts, doc-manager.ts}` (migration 5: `links` and `doc_versions` tables, snapshots before compaction)
  - `packages/database/src/*` (button property, template placeholders)
  - `packages/app/src/{app.tsx, navigation.tsx, sidebar.tsx, page-menu.tsx}` (tabs, history, import/export entries)
  - `apps/desktop/src/main/{ipc.ts, menu.ts, windows.ts}` (tab-aware windows, dialogs)

## Verification

- **Unit tests (Vitest):**
  - synced block docs merging from two replicas
  - button steps (each kind, and undo as one step)
  - link extraction for every kind of link
  - snapshot retention and restore merging with concurrent edits
  - Markdown, HTML and CSV export of every block and property type
  - Notion zip parsing, type inference, relation resolution and link rewriting against the golden fixtures
  - the export → import round trip
- **E2E (Playwright), one spec per milestone:**
  - copy and sync a block, edit it in both places and in two windows, then unsync it
  - a button that inserts blocks and one that adds a database row
  - backlinks appear when a page is mentioned and go away when the mention is deleted
  - restore an older version and undo the restore
  - open, switch, reorder and close tabs, restart, and check the tabs come back
  - use a gallery template
  - render a Mermaid diagram and see an error for bad syntax
  - export a page with sub-pages and a database to Markdown and PDF, then check the files
  - import a Notion zip fixture and check pages, databases, relations, links and images; restart and check again
- Before every push: `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `xvfb-run -a pnpm test:e2e`, run twice.
- Check by eye in light and dark themes. Keep the renderer bundle in check: mermaid, the gallery's template data and the import/export UI load on demand.
