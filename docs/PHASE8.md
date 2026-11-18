# Phase 8: What Notion has that Workspace didn't

**Status:** in progress. N1 (the slash menu and keyboard) and N2 (tabs, embeds, link mentions)
are done.

## Context

After the Phase 7 release check, the question was whether Workspace now does everything Notion
does. It didn't: `/relation` in a database row's page, for one, does nothing. The Phase 7
parity pass had compared the app with our own feature inventory
([PLAN.md §3](PLAN.md#3-feature-inventory-parity-target-ai-excluded)), not with Notion as it
is in late 2026.

So this phase starts from a fresh comparison:

- **Our side:** read from the code (the slash menu, the block types, the database engine, the
  server and the apps), not from our docs.
- **Notion's side:** its releases up to November 2026 (3.0 to 3.8, and the 2024–2025 database
  and Sites updates) and its help pages.

**Left out on purpose:** Notion AI and everything built on it (agents, AI meeting notes, AI
autofill, AI search, MCP connections), Notion Calendar and calendar connections, Notion Mail,
and the template marketplace.

## The gap list

Each feature Notion has and Workspace didn't, with what it's for, the effort (S: a day or two,
M: about a week, L: two weeks or more) and a suggestion: ✅ worth adding soon, 🤔 useful for
some people, ❌ too big for what it gives, or needs outside services. The ✅ items are the
milestones below; the others wait for a decision, by number.

### A. Pages and blocks

| #   | Notion feature                                                                                                                                                                | What it's for (how you use it)                                                                                                                        | Effort | Suggest      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| 1   | **Property commands in `/`** (`/relation`, `/rollup`, `/date`, `/select`, `/formula`…)                                                                                        | On a database row's page, type `/relation` to add that kind of property to the database without going to the table header. Faster setup of databases. | S      | ✅ Done (N1) |
| 2   | **Other quick `/` commands**: `/red`, `/blue background` (colour the block), `/comment`, `/date` or `/today`, `/mention`, `/emoji`, `/duplicate`, `/delete`, `/turn into`     | Do the block menu's actions from the keyboard without the mouse.                                                                                      | S      | ✅ Done (N1) |
| 3   | **Tabs block** (`/tabs`, Notion 3.4, March 2026)                                                                                                                              | Put content in clickable tabs on one page (e.g. "Specs / Tests / Notes") instead of making sub-pages.                                                 | M      | ✅ Done (N2) |
| 4   | **Embed any website** (generic embed) and more providers: GitHub Gist, Google Docs/Sheets/Slides/Drive, Miro, X/Twitter, Spotify, SoundCloud, Typeform, Airtable, Excalidraw… | Paste any link and see it live in the page. Today only YouTube, Vimeo, Loom, Figma, CodePen and Google Maps work; everything else becomes a bookmark. | M      | ✅ Done (N2) |
| 5   | **Link mentions** (paste a URL → "Mention" chip with the site's icon and title)                                                                                               | A small inline link that shows what it points to (a GitHub PR, a Figma file, a web page), instead of a bare URL.                                      | S–M    | ✅ Done (N2) |
| 6   | **Presentation mode** (Notion 3.4, beta)                                                                                                                                      | Turn a page into a slideshow (each divider = new slide), full-screen, arrow keys to move. For meetings and demos.                                     | M      | 🤔           |
| 7   | **Custom emoji** (upload your own, used anywhere `:` works)                                                                                                                   | Team logos, project icons as emoji.                                                                                                                   | M      | 🤔           |
| 8   | **Simple table colours** (colour a row or a column)                                                                                                                           | Highlight a header row or a total column in a plain table.                                                                                            | S      | 🤔           |
| 9   | **Office file previews** (Word, Excel, PowerPoint shown in the page, Notion 3.6)                                                                                              | See a `.docx` / `.xlsx` attachment without downloading it.                                                                                            | M      | 🤔           |
| 10  | **Interactive HTML block** (Notion 3.6)                                                                                                                                       | Small custom widgets (a calculator, a chart) written in HTML inside a page. Mostly made by Notion's AI there; a security risk to run arbitrary HTML.  | M      | ❌           |

### B. Databases

| #   | Notion feature                                                                                                                                                              | What it's for (how you use it)                                                                                                                                   | Effort | Suggest      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------ |
| 11  | **Row page layouts** ("Customize layout": pinned properties under the title, property sections, a tabbed layout; relations shown **as a page section**)                     | Make every row page of a database look the same and tidy: the 3 important properties at the top, the rest folded, related tasks shown as a list inside the page. | M–L    | ✅ Done (N3) |
| 12  | **Number shown as a bar or ring** (progress), checkbox / status **"show as"** options                                                                                       | A "% done" column drawn as a progress bar; ratings as stars-like bars.                                                                                           | S      | ✅ Done (N3) |
| 13  | **Freeze columns, row height, load limit** per view                                                                                                                         | Keep the title column visible while scrolling sideways; compact or tall rows; show 25/50/100 rows then "Load more" in big tables.                                | S      | ✅ Done (N3) |
| 14  | **Bulk edit** (select many rows → set a property, duplicate, delete, move)                                                                                                  | Change the status of 30 tasks at once. (Needs checking: our table has row selection for copy/delete, not "edit property for all".)                               | M      | ✅ Done (N3) |
| 15  | **Recurring templates** (a template that creates a page every day/week/month)                                                                                               | "Weekly review" or "Daily standup" pages appear by themselves on schedule.                                                                                       | M      | ✅ Done (N3) |
| 16  | **Form conditional logic** (show a question only if an earlier answer was X) and **file upload questions**                                                                  | Smarter forms: "If bug → ask for steps"; let people attach a screenshot.                                                                                         | M      | ✅ Done (N3) |
| 17  | **Map view + Place property** (Notion 3.0/3.1)                                                                                                                              | Store addresses/places; see rows as pins on a map. For travel, field work, sites, customers. Needs a map tile source (OpenStreetMap).                            | L      | 🤔           |
| 18  | **Feed view**                                                                                                                                                               | Rows shown as a scrolling feed of full pages (like a blog/updates stream), not cards.                                                                            | M      | 🤔           |
| 19  | **Dashboard view** (Notion 3.4: up to 12 widgets — views, charts, KPI numbers — in one database view)                                                                       | One overview screen for a project: open tasks count, a chart, "my tasks", in one place.                                                                          | L      | 🤔           |
| 20  | **Several data sources in one database** ("databases reimagined", 2025)                                                                                                     | One database block holding e.g. Projects + Tasks + Sprints as tabs, set up as one system/template. Complex; integrations must support it.                        | L      | ❌           |
| 21  | **More automation actions and triggers**: edit pages in another (related) database, use formulas/variables in values, "when a button is pressed", send email, post to Slack | Bigger workflows: "when a project is Done, mark all its tasks Done". (Slack/email need those services set up.)                                                   | M      | 🤔           |
| 22  | **"Can create pages" database permission** (Notion 3.4)                                                                                                                     | Let someone add rows without being able to edit others' rows (e.g. a request tracker).                                                                           | S–M    | 🤔           |
| 23  | **Synced databases from GitHub/Jira/external APIs**                                                                                                                         | Issues from GitHub or Jira show up as a live database. Needs each service's API and accounts.                                                                    | L      | ❌           |
| 24  | **Wiki / verified pages** (mark a page "verified until date", owners, a wiki database of pages)                                                                             | Company handbooks: shows which docs are up to date and who owns them.                                                                                            | M      | 🤔           |

### C. Navigation and workspace

| #   | Notion feature                                                                                                                                                                                                                                              | What it's for (how you use it)                                                            | Effort         | Suggest      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------- | ------------ |
| 25  | **Quick find filters and sorting** (only titles, created by, in teamspace, date range; sort by last edited / best match)                                                                                                                                    | Find the right page fast in a big workspace.                                              | M              | ✅ Done (N4) |
| 26  | **Home page** (recently visited, upcoming reminders, "my tasks" across databases) + **Recents** in the sidebar                                                                                                                                              | A start screen that shows what you were doing and what's due.                             | M              | 🤔           |
| 27  | **One Settings window** (account, appearance, region, notifications, members, teamspaces, integrations, sync, offline, import/export, in one place with a left menu)                                                                                        | Today they're separate dialogs spread over menus; one window is easier to find things in. | M              | 🤔           |
| 28  | **People directory** (Notion 3.2: everyone in the workspace with profile, team, what they work on)                                                                                                                                                          | See who's who; click a person to see their pages.                                         | S–M            | 🤔           |
| 29  | **Full keyboard shortcut set** (move blocks with `Ctrl+Shift+↑/↓`, `Ctrl+Alt+0–9` turn into, `Ctrl+D` duplicate, `Ctrl+Shift+H` last colour, `Ctrl+Shift+L` dark mode, `Ctrl+[`/`]` back/forward, `Ctrl+Shift+U` go to parent…) and a shortcuts help screen | Faster work for keyboard users; people coming from Notion expect the same keys.           | S              | ✅ Done (N1) |
| 30  | **Comments display setting** (show comments on the page, minimized, or hidden)                                                                                                                                                                              | Keep busy pages clean.                                                                    | S              | 🤔           |
| 31  | **Move a page to another workspace**                                                                                                                                                                                                                        | Reorganise between personal and team workspaces.                                          | S–M            | 🤔           |
| 32  | **Other languages** for the interface (Hindi etc.)                                                                                                                                                                                                          | Left for later in Phase 7; listed so it isn't forgotten.                                  | M per language | 🤔           |

### D. Sharing and publishing (need the server)

| #   | Notion feature                                                                                          | What it's for (how you use it)                                                            | Effort                     | Suggest                        |
| --- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------- | ------------------------------ |
| 33  | **Request access** (someone without access clicks "Request", the owner gets it in the inbox, approves)  | Today they just see "no access" and must ask the owner outside the app.                   | S–M                        | ✅ Done (N4)                   |
| 34  | **Share link for anyone with the link** (view/comment/edit, optionally with expiry), without publishing | Send a page to a client without making it public on the web.                              | M                          | 🤔                             |
| 35  | **Published sites: custom domain**, site theme/nav bar, "Allow duplicate as template"                   | `notes.yourcompany.com` instead of the server address; let visitors copy a template page. | L (domain) / S (duplicate) | 🤔                             |
| 36  | **Admin tools**: audit log, admin content search, disable export/download, SAML SSO, SCIM user sync     | Company security and compliance. We already have OIDC single sign-on.                     | M–L each                   | ❌ (unless a company needs it) |
| 37  | **Slack notifications** (and Slack link previews)                                                       | Mentions and updates go to Slack. Needs a Slack app per server.                           | M                          | ❌                             |
| 38  | **Workspace analytics** (who's active, popular pages)                                                   | For admins of big workspaces. We already have per-page views.                             | M                          | ❌                             |

### E. Import, export, developer platform

| #   | Notion feature                                                                                 | What it's for (how you use it)                                               | Effort | Suggest      |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ------------ |
| 39  | **Import from Word (`.docx`)** and **Google Docs** (as `.docx`)                                | Bring existing documents in with their formatting.                           | M      | ✅ Done (N5) |
| 40  | **Import from Asana, Jira, Monday** (their CSV/JSON exports)                                   | Move project boards in, like Trello today.                                   | M each | 🤔           |
| 41  | **Import from Dropbox Paper, Quip, Coda, Workflowy**                                           | Less common tools.                                                           | M each | ❌           |
| 42  | **PDF export of a page with all sub-pages / the whole workspace** (ours is one page at a time) | One PDF of a whole handbook.                                                 | S–M    | 🤔           |
| 43  | **API: file uploads, views endpoints, Markdown API** (Notion 3.5)                              | Integrations that attach files, read views, or read/write pages as Markdown. | M      | 🤔           |
| 44  | **Notion CLI and Workers** (hosted custom code)                                                | Developer tooling; heavy, and Notion-specific.                               | L      | ❌           |

### F. Platforms and apps

| #   | Notion feature                                                         | What it's for (how you use it)                                                                                                   | Effort | Suggest                                  |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| 45  | **Windows and macOS desktop apps**                                     | Use the app on non-Linux computers. Electron builds them; needs testing, signing and (for macOS) a paid Apple developer account. | M      | 🤔                                       |
| 46  | **Mobile apps (Android, iOS)**                                         | Phone access. Today the web app works in a phone browser (not optimised). A real app is a large project.                         | L      | 🤔 (start with a phone-friendly web app) |
| 47  | **Web clipper** (browser extension to save a web page into a database) | Save articles/research in one click.                                                                                             | M      | 🤔                                       |

## Milestones

| Milestone | Items                                                                      | Estimate  |
| --------- | -------------------------------------------------------------------------- | --------- |
| N1        | The slash menu and keyboard (#1, #2, #29)                                  | 1 week    |
| N2        | Blocks: tabs, embedding any site, link mentions (#3, #4, #5)               | 1.5 weeks |
| N3        | Databases: layouts, show as, freeze, bulk edit, recurring templates, forms | 3 weeks   |
| N4        | Quick find filters, request access (#25, #33)                              | 1.5 weeks |
| N5        | Import from Word and Google Docs (#39)                                     | 1 week    |

Each milestone is committed and pushed with its tests, after the full checks: formatting, lint,
types, unit tests, both builds, the desktop E2E suite twice and the web E2E suite.

## N1: The slash menu and keyboard

**Built:**

- **Property commands** (#1): on a database row's page, the slash menu has a "Page properties"
  group, one command per property type (`/relation`, `/select`, `/formula`…). Each adds that
  property to the database, as **Add a property** in the properties panel does: a relation
  opens its setup first, a rollup and a formula open theirs, and anything else opens for a
  value. The commands are there only for someone who may change the database's properties.
  - The editor asks for them through a new optional service, `rowProperties`
    (`packages/editor/src/services.ts`). The row page provides it, and the properties panel
    does the work (`packages/app/src/database/row-page.tsx`), so the menu and the panel add
    properties the same way.
- **Commands on the block** (#2), found by searching the slash menu and kept out of its
  unfiltered list (`searchOnly`): a colour (`/red`, `/blue background`, `/default`), turn into
  (`/turn into h2`, `/turnh2`), `/duplicate`, `/delete`, `/comment` (on the block's text, where
  the page has comments), `/today` (a date mention), `/reminder`, `/mention a person` or
  `/mention a page` (opens the mention menu), and `/emoji` (opens the emoji menu straight away,
  without a letter). They're in `packages/editor/src/blocks/actions.ts`. Like Notion, they act
  on the block the cursor is in, and what was typed after the `/` goes.
- **Keyboard shortcuts** (#29), in `packages/editor/src/shortcuts.ts` and the app's key
  handler:
  - **Blocks:** move up or down (`Ctrl+Shift+↑/↓`, also for the selected blocks), duplicate
    (`Ctrl+D`), turn into (`Ctrl+Alt+0`–`8`), a new sub-page (`Ctrl+Alt+9`).
  - **Writing:** the colour used last (`Ctrl+Shift+H`), an inline equation (`Ctrl+Shift+E`).
    `Ctrl+Enter` checks a to-do or opens and closes a toggle (elsewhere it is still a line
    break).
  - **App:** back and forward (`Ctrl+[`/`]`), the parent page (`Ctrl+Shift+U`), dark or light
    mode (`Ctrl+Shift+L`), and the list of shortcuts (`Ctrl+?`, or **Keyboard shortcuts** in
    the workspace menu).
- The shortcuts list is one table in the app (`packages/app/src/shortcuts-dialog.tsx`); the
  [desktop guide](desktop.md#keyboard-shortcuts) has the same list.

**Found on the way:**

- **A click just before a key.** A block shortcut pressed straight after a click acted on the
  block the cursor had been in: the browser tells ProseMirror about the click's new selection
  a moment later. The shortcuts read the selection from the page first, as `Ctrl+K` in text
  cells already did (Phase 7 M6).
- **The shortcuts list didn't scroll from the keyboard.** The accessibility test found this
  (axe's `scrollable-region-focusable`), so the list can now take the focus.

**Tests:**

- **Unit:** the slash menu's lists (`packages/editor/src/blocks/registry.test.ts`):
  - property commands only on a row page, and only when properties can be changed
  - commands on the block only when searched for, and found by name
  - Comment only where there are comments and the block has text
  - turn into for each block that converts
- **Desktop E2E:**
  - `relations.spec.ts`: `/relation` sets up a relation from a row's page; `/select` adds a
    select and takes a value; neither exists on an ordinary page.
  - `blocks.spec.ts`: colour, turn into, duplicate, delete, comment, today, emoji and the
    mention menu, from the slash menu.
  - `keyboard.spec.ts`: moving and duplicating, turn into, a to-do checked with `Ctrl+Enter`,
    the last colour, a sub-page with `Ctrl+Alt+9`, the parent page, back and forward, dark
    mode, and the shortcuts list.
  - `a11y.spec.ts`: the shortcuts list, in both themes.

**After the full run:** the desktop suite found two things, fixed in a follow-up commit:

- `/h2` also listed "Turn into heading 2": the commands on the block matched scattered letters
  (as blocks do). They now need a word to match, and "Turn into" items come up when the search
  starts with "turn" or "convert".
- The `/relation` test typed before a new page's editor had the focus.

## N2: Tabs, embeds of any site, link mentions

**Built:**

- **Tabs** (#3, `packages/editor/src/nodes/tabs.ts`): a `tabs` block of `tab` blocks, each with
  a title and blocks of its own.
  - **The bar:** click a tab to open it (the cursor goes into it), click the open tab to rename
    it, `+` to add one, `×` to delete the open one. The arrow keys, Home and End move between
    tabs.
  - **Which tab is open** is per view, like a toggle's open state: it isn't saved in the page or
    synced. Moving the cursor into a hidden tab (with the keyboard, or a link to a block) opens
    it.
  - **Elsewhere:** tab titles are searchable. Markdown and HTML exports write the tabs one after
    another, each under its title. The API reads tabs as `unsupported`, as it does buttons.
  - Inserting tabs at the end of a page leaves a line after them to go on writing.
- **Embeds** (#4, `packages/editor/src/nodes/embeds.ts`):
  - **Any https page** embeds as it is, in the sandboxed frame embeds already used. A bar above
    it names the site and links to it, because some sites refuse to be shown in a frame and
    show nothing.
  - **The app's content security policy** now allows frames from any https origin, instead of
    the providers' list.
  - **Plain http pages** still can't be embedded, and offer a bookmark instead.
  - **New providers:** Google Docs, Sheets, Slides, Forms and Drive files, Google Maps places,
    GitHub Gists, Miro, X posts, Spotify, SoundCloud, Typeform, Airtable and Excalidraw. Their
    links turn into the provider's player.
- **Link mentions** (#5): pasting a link offers **Mention**.
  - **What it shows:** the site's icon and the page's title, as a link. It's a new kind of
    mention (`kind: 'link'`), so search, copying, exports and the API carry it like other
    mentions.
  - **The title and icon** are looked up once by whoever first has the mention open with edit
    access, through the link preview bookmarks already use. They are then kept in the page and
    work offline.
  - **In the API:** reads and writes as Notion's `link_mention`.

**Found on the way:**

- **Person mentions and the API.** The API read and wrote person mentions as
  `kind: 'user'`, while the editor stores `kind: 'person'`. So people mentioned in the app were
  left out of the API's rich text, and a person mentioned through the API showed in the app as
  a broken date. The API now uses `person`. Mentions it wrote before still read as people
  everywhere: in the editor, the exports, the API and comments.
- **The tab bar and screen readers.** The accessibility test found that the tab list held the
  add and delete buttons, while a tab list may hold only tabs. They now sit beside it.
- **Known limit:** after clicking a tab, `Ctrl+End` stays at the end of that tab instead of going
  to the end of the page.
- **The E2E teardown hang (Phase 7), found.**
  - **Where it stops:** the page cover test stopped closing again, and the guard reported it:
    the window's process gone, the main process waiting. In E2E runs the main process now logs
    each step of quitting, and the report includes them. Every step finished, up to Electron's
    `quit` event; then Chromium didn't end the process.
  - **What brings it on:** narrowed test by test, it was saving a cover image's position and
    quitting at once. A plain drag didn't, nor did the cover upload alone, the cursor, or how
    the file is served.
  - **For people, not just tests:** a process left like this would keep the app from starting
    again (one instance at a time).
  - **The fix:** after the app's own cleanup, a watchdog on a thread of its own (the main
    thread's timers stop once quitting begins) ends the process if it's still there 4 s later.
    Nothing is open by then. In twelve runs of that test, all passed, and the watchdog ended
    seven stuck exits.
  - **Still open:** why Chromium stops there.

**Tests:**

- **Unit:**
  - each new provider's link, any https page, and the unsafe ones (http, localhost, passwords
    in the address, `javascript:`, `data:`, a malformed escape)
  - the API's `link_mention` both ways, refusing a non-web address, and old `user` mentions
  - Markdown and HTML for tabs and link mentions
- **Desktop E2E:**
  - `blocks.spec.ts`: tabs. Switch, rename, add with an image in it, delete, arrow keys, and kept
    after a restart.
  - `media.spec.ts`: an https site embedded with its bar; the paste menu's Mention looks up the
    page's title.
  - `a11y.spec.ts`: a tabs block, in both themes.

**Runs:**

- **The full desktop suite,** before the watchdog: 161 passed, 3 skipped, 1 failed (the
  teardown hang, above).
- **With the watchdog, twice:** 162 passed and 3 skipped each time. The watchdog ended one
  stuck exit in the first run and none in the second.
- **The web suite:** 6 passed.

## N3: Databases

N3 is in five parts (the [plan](#milestones) has them as one milestone): show as, freeze and
load limit (N3a); bulk edit (N3b); repeating templates (N3c); form conditions and file
questions (N3d); row page layouts (N3e). They went in together: they share the schema, the
row page and the docs.

### N3a: Show as, frozen columns, load limit (#12, #13)

**Built:**

- **Number "Show as"** (`PropertyConfig.showAs`): a number, a bar or a ring, with its colour,
  the value that fills it (`divideBy`, 100 by default) and the number beside it or not. It
  applies to number formulas and rollups too. Exports and the API still give the number.
- **Status "Show as checkbox"** (`statusShowAs`): ticked when the status is in the Complete
  group; ticking sets the first Complete option, unticking the first To-do one. The helpers
  (`isTicked`, `toggledValue`, `numberFill`) are in `packages/database/src/properties.ts`, so
  the table and the row page toggle the same way.
- **Frozen columns** (`ViewConfig.frozenColumns`): "Freeze up to this column" in a column's
  menu keeps those columns in place (`position: sticky`, each at the widths before it) while
  the table scrolls sideways.
- **Load limit** (`ViewConfig.loadLimit`, null by default so existing views are unchanged): a
  table, list or gallery shows 10 to 500 pages, then "Load N more"; per group when grouped.
  Calculations still cover every row. How many are loaded is kept while the view is open.
- **Row height:** "Wrap all content" already gives compact or tall rows, so nothing new.

### N3b: Bulk edit (#14)

**Built:**

- **Picking rows:** a checkbox beside each table row (a wider row gutter makes room), Shift+click
  for a range, Ctrl+A for all the rows in the view, Escape to let go.
- **The selection bar** above the table: "N selected", **Edit property** (a property's usual
  editor, on the first picked row, its value then copied to the others; text, numbers and
  links are typed once and read as pasting would; checkboxes as "checked" or "unchecked"),
  **Duplicate** (with content), **Copy links**, **Delete**.
- **One undo step:** `DatabaseHandle.beginUndoGroup` and `endUndoGroup` make everything between
  them one step of the database's undo stack (`packages/database/src/handle.ts`), so the first
  row's edit and the copies undo together.

### N3c: Repeating templates (#15)

**Built:**

- **Repeat…** in a template's menu: every day, on chosen weekdays, or monthly on a day, at a
  time in the person's time zone. It's stored as a scheduled automation of the database, one
  per template (`repeat-<template id>`), so it shows in the automations dialog too and runs
  where automations run: on the server while the workspace syncs (once per run: its jobs are
  keyed by the time), else on the desktop.
- **Several weekdays:** `Schedule.weekdays` (with `weekday` still read for older schedules);
  the schedule editor picks days with toggle buttons.
- **From a template:** the `addPage` action takes a `templateId`. The server's and the
  desktop's runners make the page with `addRowFromTemplate` (values, icon, cover), then copy
  the template's content into the new page's doc. On the server the page is placed with its
  database.

### N3d: Form conditions and file questions (#16)

**Built:**

- **Conditions** (`FormQuestion.showIf`): "Only if" an earlier select, status or multi-select
  question is one of some options, or an earlier checkbox is ticked or not. They chain (a
  question shown only if a hidden one was answered stays hidden), and a condition on a
  question that was removed or moved below is ignored, so it can't hide a question for good.
  `shownQuestions` in `packages/database/src/forms.ts` decides; `validateSubmission` drops
  the answers to hidden questions and doesn't require them, on the server too.
- **In the app:** the builder has "When to show" under each question; the filled-in form
  shows and hides questions as the answers change.
- **On the public page (no script):** a `<style>` per form hides conditional questions and
  shows each one with `form:has(select[name=…] option[value=…]:checked)` (or `:checked`
  inputs). Browsers without `:has()` show every question; the server still applies the
  conditions. Conditional questions aren't `required` in the HTML, for the same reason.
- **File questions** (`files` in `FORM_QUESTION_TYPES`): up to 5 files. In the app they're
  stored as attachments are, and the in-app submit only takes file ids. The public page sends
  `multipart/form-data` (`@fastify/multipart`, registered on the public form route only):
  10 MB a file and 25 MB a response (413 past that), stored as workspace files and linked to
  the new row. Files of a question the conditions hide aren't kept.

### N3e: Row page layouts (#11)

**Built:**

- **Customize layout** (`DatabaseMeta.layout`, null by default: today's page), from the row
  page's properties, for people who may edit the database's properties. It applies to every
  page of the database.
  - **Pinned:** up to 4 properties under the title, in a compact row.
  - **The others:** in the page, folded behind "Properties" (with their count), or in a side
    panel on the right (above the content on narrow windows).
  - **Relations as sections:** a relation's linked pages listed after the properties, with up
    to 3 of their properties, "Add a page" (the relation picker) and remove. A linked page
    opens in a side peek.

### The toggles test, and keys right after a caret move

The toggles test (Phase 1) failed in some full runs: what it typed after Ctrl+End went to the
wrong place, and then the selection toolbar didn't show. The guess in an earlier draft (its
click landing on the toggle's arrow) was wrong; moving the click didn't help.

- **The cause:** the browser moves the caret itself for some keys (End, Ctrl+End, Shift+Home),
  and ProseMirror learns of it from a `selectionchange` event that comes later. Input events
  run first, so a key pressed straight after (Enter) can act on the old cursor. Logging both
  selections showed ProseMirror's still at the old place after Ctrl+End in 10 of 12 tries, and
  Enter acting there in 2 of 4 before the fix. Playwright presses keys back to back; a person
  typing fast on a busy machine can do the same.
- **The fix:** before any key is handled, the editor reads the selection from the page
  (ProseMirror's own handler for that event; nothing happens if they already match), in
  `packages/editor/src/extensions.ts`. With it, Enter acted at the new caret in 12 of 12.
- **The test** now checks that Ctrl+End left the toggle before going on. Without the fix that
  check failed 3 times in 3. With it, the test passed 13 times in 15. The 2 failures were the
  first two runs after a fresh build, and timed out (30 s steps); their output wasn't kept.
- **Ruled out:** y-tiptap redraws the whole document when the editor's plugins change (menus,
  others' cursors), but ProseMirror keeps the blocks' views and the selection then.
- **What it showed next:** with Enter acting at the new caret, the offline test
  (`exit-check.spec.ts`), where two desktops each press Ctrl+End and Enter on the same page,
  always splits the same empty last line on both. TipTap's UniqueID gives a split's first
  half a new id and the second, typed into, the old one, so both desktops made a block with
  that same id, and the merged page had two. Opening the page again gave one a new id, so the
  page changed after a restart and the test failed. Before, Enter often acted where the click
  left the caret, and the two desktops split different lines. Now an empty block keeps its id
  when Enter splits it (`KeepIdOnEmptySplit` in `packages/editor/src/extensions.ts`); Enter at
  the start of a line with text still leaves the line's id with its text.
- **Not explained yet:** the selection toolbar not showing after Shift+Home, which is likely
  what those 2 timeouts were. It didn't come back in the three full runs below.

**Tests:**

- **Unit:**
  - show as: a status ticked and toggled, a checkbox flipped, a bar's fill
  - views: no frozen columns or load limit until set
  - undo grouping: two edits in a group undo in one step
  - schedules on several weekdays, their keys, and a page from a template in a run's plan
  - form conditions: shown and hidden, chained, ignored when they point below; hidden
    required questions not enforced and their answers dropped; file answers checked
  - row layouts: read with defaults, and anything malformed falls back
- **Server:**
  - `automations.test.ts`: a scheduled run adds one page from the template, with its values
    and content, on the server and on the desktop that syncs.
  - `forms.test.ts`: the public page's condition styles; a hidden question's answer dropped
    and a hidden required one not enforced; a multipart submission storing a file and linking
    it; too large refused; files of hidden questions not kept.
- **Desktop E2E:**
  - `views.spec.ts`: a number as a bar (50%, then 25% with "Divide by" 200) and a ring; a status
    as a checkbox; 60 imported rows with a load limit of 25, then 50, then 60; a frozen title
    staying put while the table scrolls sideways.
  - `database.spec.ts`: pick five rows with Shift, set their status, undo once; set tags for
    all; duplicate two; Ctrl+A, delete all, undo.
  - `local-automations.spec.ts`: a template repeating every day makes a page with its content
    a day later.
  - `forms.spec.ts`: a files question shown only when the status is Done, answered with a file
    in the app; on the public page, signed out, hidden until Done is chosen, then a file
    uploaded; both rows have their files.
  - `database.spec.ts`: a row page layout: a pinned property, the rest folded, a relation as a
    section (add a page, see its property, open it), on another row too and after a restart,
    then the side panel.
  - `blocks.spec.ts`: the toggles test checks Ctrl+End left the toggle.
  - `a11y.spec.ts`: the layout dialog and a row page with a pinned property, a side panel and
    a relation section, in both themes. (axe found the section's heading out of order; it's an
    `h2` now.)

**Runs:**

- **The full desktop suite, before the empty-split fix:** 167 passed, 3 skipped, 1 failed (the
  offline test, above). The toggles test passed.
- **With it, twice:** 168 passed and 3 skipped each time. The watchdog ended one stuck exit in
  the second run.
- **The web suite:** 6 passed. Formatting, lint, types, unit tests and the web, server and
  desktop builds pass.

## N4: Quick find filters, request access

### N4a: Quick find filters and sorting (#25)

**Built:**

- **Filters under the search field:** Titles only (a toggle), In (a sidebar section, when
  there's more than one), Edited (today, past 7 days, past 30 days, past year), Created by
  (server workspaces) and Sort (best match, last edited, created), with Clear filters. Each is
  a menu, so they work from the keyboard. With a filter and nothing typed, quick find lists
  what the filter lets through. Each result says when it was last edited.
- **In the index:** `search(query, options)` (`SearchOptions` in `packages/core/src/search.ts`,
  cleaned the same way from IPC and from query parameters). The filters are applied where the
  limit is, so 20 results are 20 that match.
  - **Desktop:** two columns in the SQLite index (migration 8): the page tree a page lives in
    and who made it. A row is in its database's tree. Titles only matches the full-text
    `title` column.
  - **Server:** `created_at` and `created_by` in `search_index` (migration 15). A section's
    trees map to their scopes, still limited to the ones the person can read. Titles only
    matches the title's weight (`word:*A`).
  - **A section** is every tree it shows: its own, and those of pages shared into it.
- **Who made a page:** `PageMeta.createdBy`, set where pages are made (new pages, sub-pages,
  databases, duplicates, templates, and the API, as the integration). Rows always had it. Pages
  made before N4 don't say, so a "Created by" filter doesn't list them. The API's pages now
  give their `created_by`.

### N4b: Request access (#33)

**Built:**

- **A screen for a page you can't open** (`packages/app/src/no-access.tsx`): links, mentions,
  page links and notifications to a page that isn't here open it, where before nothing
  happened. The server says only whether the page exists and whether you asked
  (`GET /api/workspaces/:id/pages/:pageId/access`), never its title. A page made a moment ago
  may not be in the server's index yet, so "doesn't exist" looks again a few times.
- **Asking:** the access (view, comment, edit) and a message. One pending request per person
  and page, 20 an hour, for members and guests. A database row is asked for as its database
  (a row can't be shared on its own).
- **Who's told:** everyone with full access where the page is, else the workspace's owners
  and admins: a `request` notification (live, in the inbox, in desktop notifications and in
  email digests). Its key is the request's, so when one of them answers, the others' are
  marked read.
- **Answering:** Share (with the access asked for, or another) or Decline, from the inbox item
  or from a "Requests" list in the page's share dialog. Sharing splits the page into its own
  scope, as the share dialog does, unless it already is one, then grants the role; the
  existing "shared with you" notification tells the requester, and their screen turns into
  the page. A declined request shows on the screen next time; they can ask again.
- **On the server:** `access_requests` (migration 15) and its store
  (`packages/storage-remote/src/access-requests.ts`), the routes in
  `apps/server/src/access-requests/routes.ts`, and the desktop's proxy allows them. Sharing a
  page and granting access moved from the scope routes into `apps/server/src/scopes/sharing.ts`,
  used by both.

**Found on the way:**

- **"Shared " with no title:** the notification for a page shared on its own used its scope's
  name, which such a scope doesn't have. It uses the page's title now.
- **The inbox's accessibility** (found once the a11y test's inbox had an item): each item's
  button had a label that didn't contain its visible text, and the unread dot had a label but
  no role. The button is named by what it shows now, and the dot is an image.
- **Quick find's chips:** accent text on its tint, and the faint grey on a selected row in the
  dark theme, were under 4.5:1; they use the usual text colours.

**Tests:**

- **Unit:**
  - desktop index: each filter, both sorts, titles only, the limit, listing with an empty query
  - server index: the same against Postgres, still limited to readable scopes
  - search options: cleaned from untrusted input, through query parameters and back, the
    "Edited" ranges
  - who made a page, and a duplicate's
- **Server:**
  - `search.test.ts`: the search route's filter parameters, and refusing bad ones
  - `access-requests.test.ts`: what the asker learns (not the title), outsiders refused, once
    while pending, who's told and with what, only full access answers, sharing (the role
    given, the requester told and able to read it), declining and asking again, a row asked for
    as its database, the hourly limit
- **Desktop E2E:**
  - `navigation.spec.ts`: titles only, sort by created, the keyboard, Edited with nothing typed,
    Clear filters
  - `request-access.spec.ts` (new, two desktops): Bob clicks a mention of Ada's private page,
    asks to edit with a message; Ada shares it from her inbox; Bob's screen becomes the page and
    his inbox says so. A link to another page; Ada declines from the share dialog; Bob sees it
    and may ask again.
  - `a11y.spec.ts`: quick find with a filter menu open and filtered, a page that doesn't exist,
    and an inbox with a request, in both themes
- **Web E2E:** quick find's Titles only and Created by on the server's search.

**Runs:**

- **The full desktop suite, twice:** 172 passed and 3 skipped each time. The watchdog ended no
  stuck exits.
- **The web suite:** 6 passed. Formatting, lint, types, unit tests and the web, server and
  desktop builds pass.

## N5: Word and Google Docs (#39)

**Built:**

- **Importing `.docx`** (`packages/importers/src/docx.ts`): Word documents, and Google Docs
  downloaded as Word, through the same Import button. One document becomes the import's page
  itself, titled from its Title paragraph (or its properties, or the file name); several
  become a page each.
- **What comes over:**
  - Headings by style, or by outline level, so other languages' "Heading 1" work too.
  - Bullet, numbered and nested lists, from the document's numbering (lists that redefine
    their levels, as LibreOffice's do, included), and checklists (☐ and ☑) as to-dos.
  - Bold, italic, underline, strikethrough, code (monospace fonts and code styles), colours
    and highlights mapped to the nearest of the app's colours, links, and line breaks.
  - Quotes, code blocks (consecutive code paragraphs joined), tables with header rows and
    merged cells, pictures with their captions, and footnotes (numbered where referenced,
    listed at the end).
- **What doesn't, and says so in the report:** equations and text boxes come over as text,
  comments are left out, tracked deletions are left out (the current text is kept), and
  Windows metafile pictures (EMF, WMF) are left out.
- **No new dependency:** a `.docx` is a zip of XML. `fflate` (already used for zips) unpacks it,
  refusing more than 200 MB uncompressed, and a small XML parser
  (`packages/importers/src/xml.ts`) reads it.

**Tests:**

- **Unit** (`docx.test.ts`): documents built from XML in the test, for each of the above; the
  XML parser; a damaged file and an oversized one, each a warning; and two real files made by
  pandoc and LibreOffice from the same Markdown (`packages/importers/fixtures/docx/`), checked
  block by block.
- **Desktop E2E** (`import.spec.ts`): LibreOffice's file through the Import button: the counts,
  the title, a heading, a bold word, a nested numbered list, the table's header, the code, the
  picture loaded, and the page found by quick find.

**Runs:**

- **The full desktop suite, twice:** 173 passed and 3 skipped each time. The watchdog ended no
  stuck exits.
- **The web suite:** 6 passed. Formatting, lint, types, unit tests and the web, server and
  desktop builds pass.

## The README and the guide

With Phase 8 done, the README describes Workspace for people who'll use it: Phase 8's features,
an **Install** and a **Use it** section, and Word and Google Docs import. A new
[getting started guide](getting-started.md) walks through pages, databases, finding things,
importing and working with others. The screenshots were taken again from
`apps/desktop/e2e/readme-shots.spec.ts`, which now also shows quick find's filters, bulk edit, a
row page's layout, an imported Word document and a tabs block (the last only in the spec).
