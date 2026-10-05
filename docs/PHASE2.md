# Phase 2: Databases

**Status:** M1–M5 done. M6 next.

## Context

Phase 1 is complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE1.md](PHASE1.md)): the full block editor, page chrome, sidebar, trash, quick find, history and deep links.

Phase 2 goal from the roadmap ([PLAN.md](PLAN.md) §4): **"Notion's own database templates can be rebuilt."** That means:

- a typed property system with every non-AI property type
- the Formula 2.0 language
- relations and rollups
- table, board, list, gallery, calendar, timeline and chart views
- filters, sorts, grouping and calculations per view
- inline and full-page databases, linked views and database templates
- row pages that open as a side peek, a center modal or a full page

The roadmap budgets 6–8 weeks, so Phase 2 is split into seven milestones. Each one is committed and pushed on its own, with tests.

**Not in Phase 2:**

| Item                                                | Goes to                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Form view, database automations, "repeat" templates | Phase 6 (automation)                                                                               |
| Button property                                     | Phase 3, together with button blocks                                                               |
| Real people                                         | Phase 5 (accounts). Until then, the person property and created/edited by use a single local user. |
| CSV import and export                               | Phase 3 (import/export)                                                                            |

## Data model

### Where a database lives

**A database is a page.** Its entry in the workspace doc gets a new field, `kind: 'page' | 'database'`. A missing field means `page`, so existing workspaces need no migration. Because of this, databases can do everything pages already do, with no extra code: the sidebar, trash, move, duplicate, favorites, quick find, links and mentions.

- **Full-page database:** a database page in the tree.
- **Inline database:** a database page whose `parentId` is the host page, plus a `database` block in the host page's content that points at it (`databaseId`). Deleting the block trashes the database, as in Notion.

**The database doc** has the same guid as the database page. It holds three top-level structures:

- **`schema`** (Y.Map): `propertyId → Y.Map { name, type, config, sortKey }`. The title property always exists and can't be deleted.
- **`views`** (Y.Map): `viewId → Y.Map { viewSet, name, type, sortKey, filter, sorts, groupBy, subGroupBy, properties, calculations, layout }`. Each value is plain JSON, written last-writer-wins one field at a time.
- **`rows`** (Y.Map): `rowId → Y.Map`. Each row holds:
  - `title` (Y.Text, so two people can edit a title together, like page titles)
  - `sortKey` (the manual order)
  - `createdAt`, `createdBy`, `updatedAt`, `updatedBy`
  - `uid` (for the unique ID property)
  - `trashedAt`, `icon`, `cover`
  - one key per property, holding that property's value

**Row bodies.** A row's page content is an ordinary page doc with guid = row id. The editor, files, mentions and reminders all work in row pages unchanged.

**Why rows live in the database doc.** [PLAN.md](PLAN.md) §6 suggested one Yjs subdocument per row. This plan deliberately does something else. Filters, sorts, groups, calculations, formulas and rollups need every row's values anyway. With one doc per row, a view of 5,000 rows would mean loading 5,000 docs, or keeping a second index that has to stay consistent with them. Keeping the values in one doc gives:

- atomic multi-row edits, with one undo stack
- one sync unit per database for Phase 4
- simple queries over plain objects

Row content, which is the bulk of the data, still lives in per-row docs.

The scale target is 50,000 rows (Phase 7). If that doc turns out too big, rows can be split across bucket docs behind the same `DatabaseHandle` API later. M1 includes a benchmark that keeps this risk in view.

**Linked views.** A linked database block stores `{ databaseId, viewSet }`. Views are grouped into view sets, so a linked block's own views live in the source database doc under the block's id. The database's own view set is its id. This keeps every view next to the data it queries. It also means unrelated pages never have to load another page's doc to render a linked view.

**Values** are stored as JSON per property type:

| Type                    | Value                                                |
| ----------------------- | ---------------------------------------------------- |
| text, url, email, phone | `string`                                             |
| number                  | `number`                                             |
| checkbox                | `boolean`                                            |
| select, status          | `optionId`                                           |
| multi-select            | `optionId[]`                                         |
| date                    | `{ start, end?, time: boolean, tz?, reminder? }`     |
| person                  | `userId[]`                                           |
| files                   | `FileRef[]` (from the Phase 1 file store) or URLs    |
| relation                | `rowId[]` (plus `databaseId` in the property config) |

Formula, rollup, created/edited time and by, and unique ID are computed and never stored. Options (`{ id, name, color }`) live in the property config. Status options also have a group: To-do, In progress or Complete.

**The local user.** A `users` map in the workspace doc holds one profile, created on first run (the name comes from the OS user and can be renamed in settings). Phase 5 replaces it with real accounts. The ids it stores stay valid.

### Packages

- **`packages/database`** (new, no UI, unit tested):
  - `properties/` is the type registry. For each type it defines: default config, value validation and coercion when a property's type changes, display text, sort comparator, filter operators, calculations and grouping.
  - `query.ts`: `runView(snapshot, view, ctx) → { groups, rows, calculations }`. The snapshot is the decoded doc plus the related databases it needs. It is a pure function, memoized per view on the doc version.
  - `formula/`: lexer, Pratt parser, type checker, evaluator, standard library and dependency graph.
  - `dates.ts`: date buckets, relative dates and time zones (`date-fns` + `@date-fns/tz`).
- **`packages/core`:**
  - `database.ts` holds the doc-level operations: create a database, add/rename/retype/reorder/delete properties, row CRUD, `setCell`, view CRUD and option management.
  - A `DatabaseHandle` class wraps a loaded doc for the UI: snapshot, subscribe and undo.
- **`packages/app/src/database/`** holds the view components, property editors, the row peek and the view toolbar. It is shared with the future web build.
- **`packages/editor`:** `database` (inline) and `linkedDatabase` block nodes, with slash commands `/table view`, `/board view`, `/database inline`, `/database full page` and `/linked view`.
- **`packages/storage-local`:**
  - Migration 4 adds `pages.database_id`.
  - `DocManager` indexes rows from database docs into `pages` and `page_fts`: the title and the text of the row's properties. Quick find, @-mentions and links then reach rows.
  - Reminders on date properties go through the existing `ReminderScheduler`.

**Libraries (all MIT):**

| Library                               | Used for                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `@tanstack/react-virtual`             | row and card virtualization                                          |
| `@dnd-kit/core` + `@dnd-kit/sortable` | board cards across columns, column and row reorder, with auto-scroll |
| `recharts`                            | chart view, lazy-loaded                                              |
| `date-fns` + `@date-fns/tz`           | date math and time zones                                             |

The table is a custom grid rather than TanStack Table: the query engine already does sorting and filtering, and the grid needs Notion's own keyboard model.

## Milestones

### M1: database model and table view ✅

- **Core model:**
  - the database doc layout and `kind` on pages; create full-page and inline databases (slash commands, "New database" in the sidebar menu)
  - `DatabaseHandle` with undo (`Y.UndoManager` on local origins; Ctrl+Z while focus is in a view)
- **Property types:** text, number, select, multi-select, status, date (with end date and time), checkbox, URL, email, phone, files and media, person (local user), created time, created by, last edited time, last edited by, and unique ID (with a prefix).
- **Table view:**
  - **Columns:** header menu to rename, change type, hide, duplicate, delete, insert left or right, sort, filter and wrap; drag to reorder; drag to resize.
  - **Rows:** "+ New", inline editing of every type, row handle (drag to reorder, menu with open, duplicate, delete, copy link).
  - **Keyboard:** arrow keys move between cells, Enter edits, Esc leaves; copy and paste between cells.
  - **Large databases:** rows are virtualized.
- **Row pages:**
  - open as a side peek, a center modal or a full page, set per view
  - the properties panel sits above the body editor, with hide-empty and "add a property"
  - back and forward history and `workspace://` links work for rows
- **Indexing:** rows appear in quick find and @-mentions (migration 4).
- **Benchmark:** a unit test opens a database of 50,000 rows and times decode, snapshot and `runView`. The numbers are recorded in this doc.

**M1 notes:**

- **Where the code went:** doc operations and `DatabaseHandle` live in `packages/database` with the property registry (they need it), not in `packages/core`. Core only gained `kind` on pages, the users map and helpers for page-shaped maps.
- **Creating databases:**
  - an empty page offers "Get started with: Database", which turns the page itself into a full-page database
  - `/database inline` and `/database full page` in the slash menu
  - there is no "New database" item in the sidebar menu
- **Rows look like pages.** A row's map uses the page field names, so the page chrome (title, icon, cover, page options, page menu, word count) is shared. `PageDirectory` in the app resolves ids across pages and rows, so breadcrumbs, links, history, quick find and mentions treat rows like pages. Rows that aren't loaded are found through the index (`Platform.locatePage`), then their database is loaded.
- **Keyboard and clipboard:**
  - copy and paste between cells use the `copy`/`paste` events, because the Electron Edit menu owns Ctrl+C and Ctrl+V
  - every cell edit, paste or new row is its own undo step
- **Benchmark** (`packages/database/src/bench.test.ts`, run on the dev container):

  | Step                       | Result                                 |
  | -------------------------- | -------------------------------------- |
  | Doc size                   | 18.8 MB for 50,000 rows × 4 properties |
  | Encode                     | 0.6 s                                  |
  | Decode (load)              | 2.3 s                                  |
  | First snapshot             | 0.2 s                                  |
  | Sort by a number           | 85 ms                                  |
  | Snapshot after a cell edit | 22 ms                                  |

  Edits stay fast because only the changed row is re-read. Loading is the cost to watch; splitting rows across bucket docs remains the fallback (Phase 7).

- **Changed or deferred from the M1 list:**
  - Filter from the column menu moves to M2, with filters. Wrap is a per-view switch in the view menu.
  - "Hide empty properties" on row pages moves to M2.
  - Reminders on date properties move to M2.
  - The @-mention picker lists rows only from databases already loaded in the window; quick find covers every row.
  - A row's "last edited" time follows content edits only while its database is open somewhere.
  - Rows can't be favorited or moved to another database yet.
  - Unique IDs can repeat if two devices add rows offline at the same time; sync (Phase 4) will fix this.
  - Databases stay loaded for the rest of the session once shown.

### M2: views, filters, sorts, groups and calculations ✅

- View tabs: add, rename, duplicate, delete and reorder views; per-view property visibility and order.
- **Filters:**
  - simple filter chips, plus advanced filters with nested AND/OR groups
  - operators per type (contains, is, starts with, is empty; number comparisons; date is / before / after / on or before / within the past or next N days, weeks or months, relative to today; checkbox; select is / is any of; person "me")
- **Sorts:** multiple, drag to reorder. With no sort, the manual order applies.
- **Grouping and sub-grouping** by select, status (in its groups), multi-select, checkbox, person, date (by day, week, month or year; relative buckets), text, number ranges, relation and formula. Groups can be hidden, collapsed and reordered, and show their counts.
- **Calculations** under each column:
  - **any type:** count all, count values, count unique, empty, not empty, and their percentages
  - **numbers:** sum, average, median, min, max, range
  - **dates:** earliest, latest, date range
  - **checkboxes:** checked and unchecked
- Search inside a view; number formats (number, comma, percent, currencies); date formats and 12/24-hour time.

**M2 notes:**

- **Where it lives:** `packages/database` gained `filter.ts` (operators per type, nested AND/OR evaluation, relative dates, "me"), `group.ts` (buckets per type), `calc.ts`, `format.ts` (number, date and time formats) and `reminders.ts`. `runView` now filters, searches, sorts, then groups and sub-groups. All of it is unit tested.
- **Toolbar:**
  - Filter, Sort and Group buttons, plus a search box (search isn't saved, as in Notion).
  - Filters show as chips, one per rule. Choosing "Advanced", or adding OR or a group, turns them into one "N rules" chip that opens the nested editor (groups nest one level, like Notion).
  - Incomplete rules are ignored. Inside an OR group they drop out instead of matching every row.
- **Grouped tables:** the body is a flat list of lines (group header, rows, "+ New", calculations), so grouping, collapsing and virtualization share one path.
  - "+ New" in a group gives the row that group's value.
  - Dragging a row into another group changes its value.
  - A multi-select row appears in each of its groups.
- **Calculations** are saved per view and per column, and shown for each group.
- **Formats:** number format, date format and time format live in the property config. Table cells, calculations and row pages all use them.
- **Carried over from M1, now done:**
  - Filter from the column menu.
  - "Hide empty properties" on row pages (a per-database setting, with "N more properties").
  - Reminders on date properties. They are indexed with the rows and notify like `@remind`.
- **Not done or changed:**
  - Groups follow the property's order, ascending or descending. They can't be dragged into a custom order.
  - Grouping by relation and formula comes with those property types (M3, M4).
  - Number formats don't include Notion's "bar" and "ring" displays.
- **Fixed along the way:** a race in the editor's selection toolbar, present since Phase 1. TipTap hid the toolbar at once but showed it after a 250 ms debounce, which sometimes left it out of step with the selection. It now updates without the delay.

### M3: formula engine (Formula 2.0) ✅

- **Language:**
  - a lexer and Pratt parser for the syntax: operators, `prop("Name")` and dot access (`prop("Tags").length()`), lists, `let` and `lets`, lambdas with `current` and `index`, comments
  - a static type checker for text, number, boolean, date, person, page and list types, with errors placed at the right position
- **Standard library**, Notion's whole function set:
  - **logic:** `if`, `ifs`, `empty`, `and`, `or`, `not`
  - **text:** `length`, `substring`, `contains`, `test`, `match`, `replace`, `replaceAll`, `lower`, `upper`, `repeat`, `padStart`, `padEnd`, `split`, `join`, `trim`, `format`, `link`, `style`, `unstyle`
  - **math:** `abs`, `ceil`, `floor`, `round`, `sqrt`, `cbrt`, `exp`, `ln`, `log10`, `log2`, `sign`, `pi`, `e`, `min`, `max`, `sum`, `mean`, `median`, `toNumber`
  - **dates:** `now`, `today`, `minute`, `hour`, `day`, `date`, `week`, `month`, `year`, `dateAdd`, `dateSubtract`, `dateBetween`, `dateRange`, `dateStart`, `dateEnd`, `timestamp`, `fromTimestamp`, `formatDate`, `parseDate`
  - **lists:** `at`, `first`, `last`, `slice`, `concat`, `sort`, `reverse`, `includes`, `find`, `findIndex`, `filter`, `some`, `every`, `map`, `flat`, `unique`
  - **people and pages:** `name`, `email`, `id`
- **Evaluation:**
  - a dependency graph across formula, rollup and relation properties, with cycle errors
  - results cached per row and invalidated by the doc changes that affect them
  - `now()` re-evaluates every minute
- **Formula editor:**
  - syntax highlighting, autocomplete of properties and functions, inline docs for each function, a live preview against the current row, and the type of the result
- **Formula results** can be filtered, sorted, grouped and calculated on according to their result type.
- A fixture suite of Notion formulas with expected results (inline JSON fixtures, around 300 cases).

**M3 notes:**

- **Engine** (`packages/database/src/formula/`):
  - a lexer (comments, curly quotes and escapes) and a Pratt parser (operator precedence, right-associative `^` and `? :`, `value.fn()` method calls, lists, `let`/`lets`)
  - a static type checker whose errors carry the exact position
  - an evaluator with lazy `if`, `ifs`, `and` and `or`, and lambdas that bind `current` and `index`
  - 95 functions (plus `prop`, `let` and `lets`) across logic, text, math, dates, lists and people/pages, each with a signature, description and example for the editor
- **Formula properties:**
  - stored as text, with properties referenced as `prop("Name")`; renaming a property rewrites the formulas that use it
  - `compileFormulas` orders formulas by their dependencies and flags circular references
  - `FormulaCache` adds results to the snapshot, reusing them for rows that didn't change (the handle keeps unchanged `Row` objects)
  - a formula's result type (number, text, checkbox, date) decides how it is shown, sorted, filtered, grouped and calculated, and which number and date formats apply
  - formulas that use `now()`/`today()` refresh every minute
- **Editor:**
  - syntax highlighting, with the error range underlined
  - autocomplete of property names (inside `prop("…`), functions and keywords, with Tab/Enter to accept, plus docs for the selected suggestion
  - a live preview of the result and its type for a row
  - a formula can't be saved while it has an error
  - opens from the column menu ("Edit formula"), when adding a formula property, when changing a property's type to formula, and from the value on a row page
  - columns whose formula is broken (e.g. a deleted property) show an error icon
- **Semantics:** follows Formula 2.0: `day()` is 1 (Monday) to 7, `month()` is 1–12, `+` joins text, `empty()` is true for "", 0, false and [], and empty numbers count as 0 in arithmetic.
- **Tests:** about 360 fixture cases plus error and engine tests in `formula/formula.test.ts`. I wrote the expected values from Notion's documentation and behaviour as I understand it, not from exports of real Notion results, so parity checks against a real Notion workspace are still to do (with the importer, Phase 3).
- **Not done:**
  - `style()` and `link()` return plain text; styled formula output isn't rendered.
  - Lists, people and pages show as text (and filter as text).
  - Formula values aren't in the search index.
  - Formulas over relations and rollups come with M4.

### M4: relations and rollups ✅

- **Relations:**
  - one-way and two-way relations, to another database or to the same one
  - two-way edits update both sides in one operation per doc; both docs are loaded through `DocClient`
  - a relation picker with search and "create new"; limit to one page or allow many
- **Rollups** of any property through a relation, with the full set of calculations (show original, count, unique, sum, average, min, max, range, earliest, latest, percent checked and so on).
- **Sub-items:** a self-relation pair "Parent item" / "Sub-items". The table shows nested rows with toggles, and filters can include parents or sub-items.
- **Dependencies:** a self-relation pair "Blocked by" / "Blocking", used by the timeline in M6.
- **Integrity:** a trashed row disappears from relations and rollups and comes back when restored. Permanently deleting a database turns the relations that point at it into a "deleted database" state instead of crashing.

**M4 notes:**

- **Storage:** a relation value is a nested `Y.Map` of linked row id → time added. It works as a set CRDT, so links added on two replicas at the same time both survive, and links keep the order they were added in. Older plain-array values are converted the first time they are written.
- **Operations** (`packages/database/src/relations.ts`): `createRelation`, `updateRelation` (limit; turning two-way on links existing values back, turning it off leaves the other side as a one-way relation), `setRelation`, `deleteRelation`, `syncTwoWayLinks` (after duplicating a row), and enable/disable for sub-items and dependencies.
  - Every write goes through `setRelation`, which updates both sides of a two-way relation. A one-page limit on the other side moves that page away from its old link, like Notion.
  - The app sends cell clears, pastes, duplicates and property deletes through these operations (`packages/app/src/database/actions.ts`).
- **Computed snapshots** (`ComputedCache` in `computed.ts`): relation values become arrays of live (not trashed) page ids, rollups are computed, and then formulas run.
  - A row is only recomputed when it, the rows it links to, or the related pages' titles change. When nothing changed, the previous snapshot object is returned, so views don't re-run.
  - `DatabaseRegistry.computed` loads related databases on demand. It reads the other database's stored values, or its computed values when a rollup reads a formula, rollup or relation there. Cycles fall back to stored values.
- **Rollups:** 22 calculations (show original or unique values, five counts, two percentages, sum, average, median, min, max, range, earliest, latest, date range, and checked/unchecked counts and percentages). Results are numbers, text or dates. They take the target property's number or date format, and percentages show as percent.
- **Formulas:** a relation is a `list of page` (`format()` gives titles) and a rollup has its result type.
- **Filters and groups:** relation filters match related page titles (contains, does not contain, empty). Grouping by relation puts a row in one group per linked page. Rollups sort, filter and group by their result type.
- **UI:**
  - A setup dialog for relations: the related database (or this one), the limit, and the name on the other side. It opens when adding a relation, when changing a type to relation (text values link to pages with the same title), and from "Edit relation".
  - A rollup dialog with the relation, property and calculation.
  - Relation cells show page chips that open the page. The picker searches, adds and removes pages, and can create a page from what you typed.
  - Columns pointing at a deleted database show a warning.
- **Sub-items and dependencies:** turned on from the view menu. Turning them off can keep or delete the two properties.
  - The table nests sub-items under their parent, with expand/collapse toggles and a count, plus "Add sub-item" in the row menu.
  - A row whose parent is filtered out shows at the top level.
- **Copies:** duplicating a database remaps self-relations to the new rows and makes relations to other databases one-way. A duplicated relation property is one-way.
- **Not done:**
  - Undo is per database, so undoing a two-way edit only reverts the side it was made from.
  - Nesting only applies to ungrouped tables.
  - There's no "include sub-items/parents" filter option.
  - Formulas can't read other properties of related pages (`current.prop("…")`).

### M5: board, list and gallery views ✅

- **Board:**
  - grouped by select, status, person, checkbox, relation and the other groupable types; sub-groups as swimlanes
  - drag cards between columns (this changes the property) and within a column (manual order, when no sort is set)
  - hide groups, color columns, and "+ New" per column, pre-filled with that column's value
- **Card settings**, shared by board and gallery:
  - card preview: none, the page cover, the first image in the page content, or a files property; fit or crop
  - card size: small, medium or large
  - which properties show on the card, and whether to wrap them
- **List view:** a compact list showing the title and the properties you choose.
- **Gallery view:** a responsive grid of cards.
- All three are virtualized for large databases.

**M5 notes:**

- **Model:** a view's `type` is table, board, list or gallery. Views now also store `cardPreview` (none, page cover, page content, or a files property), `fitImage`, `cardSize` and `colorColumns`.
  - New boards, lists and galleries show only the title at first. Properties added later stay off their cards until picked under Properties.
  - A new board (or a view switched to board) groups by the first status, select, multi-select, person or checkbox property. If there is none, it adds a Status property.
  - Galleries start with the page content as the preview.
- **Board** (`board.tsx`, with `boardLayout` in the database package):
  - columns are the view's groups and swimlanes are its sub-groups
  - dragging a card to another column sets the property with `groupMoveValue`, which swaps only the dragged-from value on multi-select and person
  - with no sort set, dropping also reorders the card (`moveRow` / the new `moveRowAfter`)
  - columns can be collapsed or hidden (hidden ones are listed under "Hidden groups") and tinted with their option color
  - "+ New" per column (and lane) adds a card with that value and starts typing its title
  - long columns render only the cards in view
- **List and gallery** (`list.tsx`, `gallery.tsx`): they share a line model (group headers, content, "+ New" per group) that is virtualized from 100 lines.
  - The gallery is a responsive grid whose column count follows the card size.
  - Both support groups and sub-groups.
- **Cards** (`cards.tsx`):
  - the preview shows the cover, the first image in the page (`firstImage` in core; a page's content is only loaded while its card is rendered) or the first image of a files property, either cropped or fitted
  - below it come the icon and title, then the non-empty picked properties
- **View menu:**
  - Layout (switch the type)
  - Card preview, Fit image and Card size for boards and galleries, and Color columns for boards
  - "Add a view" asks which type to add
- **Not done:**
  - board columns can't be reordered by dragging
  - cards can't be edited in place (they open the page)
  - gallery and list rows can't be reordered by dragging
  - virtualization is only exercised by hand, not by an E2E test with hundreds of cards

### M6: calendar, timeline and chart views

- **Calendar:**
  - month and week layouts, shown by any date property (multi-day ranges span days)
  - drag to reschedule or to resize a range; click a day to create a row on it
  - a "No date" panel; start the week on Sunday or Monday
- **Timeline:**
  - zoom levels from hours up to years
  - bars from start/end date properties, or from a single date-range property
  - drag to move bars, drag their edges to resize, draw dependency arrows (from M4)
  - an optional table on the left, grouping, and "Today" and "Jump to" controls
- **Chart:**
  - bar (vertical, horizontal, stacked), line, pie and donut
  - the X axis groups by a property; the Y axis is a count or a calculation over a property
  - sorting, colors, legend and data labels; built on recharts, lazy-loaded
  - charts embed inline like any view

### M7: templates, linked views and the rest of the database surface

- **Database templates:**
  - create and edit templates (property values plus body content)
  - a default template per database or per view
  - the "New" button dropdown; applying a template to an existing empty row
- **Linked views:** `/linked view`, then pick a source database. The linked block has its own views, filters and sorts, which can be changed without affecting the source.
- **"Turn into database"** converts a simple table block into a database, and the reverse.
- **Lock database:** locks views, properties or both.
- Duplicate a database, with its rows and their bodies.
- Database page settings: title, description, icon, full width, and the default "Open pages in" mode.
- **Exit check:** rebuild Notion's own templates as E2E fixtures: Tasks + Projects (relations, rollups, status, board, timeline), a reading list (gallery, select, rating formula), a habit tracker (checkboxes, calculations, chart), a simple CRM (relations, rollups, calendar) and a content calendar (calendar, person, status). Restart, and check that every view renders the same data.

## Critical files

- **New:**
  - `packages/database/src/{properties/*, query.ts, formula/*, dates.ts}`
  - `packages/core/src/database.ts`
  - `packages/app/src/database/{database-view.tsx, table/*, board/*, list.tsx, gallery.tsx, calendar/*, timeline/*, chart.tsx, toolbar/*, filters/*, property-editors/*, row-peek.tsx, templates.tsx}`
  - `packages/editor/src/nodes/database.tsx`
- **Modified:**
  - `packages/core/src/{schema.ts, workspace.ts, index.ts}` (`kind`, users)
  - `packages/storage-local/src/{sqlite-store.ts, doc-manager.ts}` (migration 4, row indexing, date reminders)
  - `packages/app/src/{app.tsx, page-view.tsx, sidebar.tsx, quick-find.tsx}`
  - `packages/editor/src/{extensions.ts, blocks/registry.ts}`

## Verification

- **Unit tests (Vitest)** for every property type:
  - value coercion when the type changes
  - filter operators
  - sort order, including empties last and locale-aware text
  - group buckets
  - calculations
- **Query engine:** `runView` over fixture databases, combining nested filters, multiple sorts, groups, sub-groups and calculations.
- **Formula engine:** parser round-trips, type errors with positions, the ~300-case Notion fixture suite, dependency cycles and cache invalidation.
- **Relations:** two-way consistency after concurrent edits on two doc replicas (Yjs merge tests), and rollups after trash and restore.
- **Scale:** the 50,000-row benchmark from M1 runs in CI as a smoke test with a time limit.
- **E2E (Playwright), one spec per milestone:**
  - create a database, add every property type, edit cells, restart and check the values
  - filters, sorts and groups, then restart
  - write a formula in the editor
  - a two-way relation and a rollup
  - drag a board card between columns
  - drag on the calendar and the timeline
  - render a chart
  - apply a template
  - a linked view with its own filter
  - the M7 template rebuilds
- Before every push: `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `xvfb-run -a pnpm test:e2e`, run twice.
- Check each view by eye in light and dark themes.
- Keep the renderer bundle in check: lazy-load the database views and recharts, so the editor doesn't pay for them.
