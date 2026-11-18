# Phase 8: What Notion has that Workspace didn't

**Status:** in progress. N1 (the slash menu and keyboard) is done.

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
| 3   | **Tabs block** (`/tabs`, Notion 3.4, March 2026)                                                                                                                              | Put content in clickable tabs on one page (e.g. "Specs / Tests / Notes") instead of making sub-pages.                                                 | M      | ✅           |
| 4   | **Embed any website** (generic embed) and more providers: GitHub Gist, Google Docs/Sheets/Slides/Drive, Miro, X/Twitter, Spotify, SoundCloud, Typeform, Airtable, Excalidraw… | Paste any link and see it live in the page. Today only YouTube, Vimeo, Loom, Figma, CodePen and Google Maps work; everything else becomes a bookmark. | M      | ✅           |
| 5   | **Link mentions** (paste a URL → "Mention" chip with the site's icon and title)                                                                                               | A small inline link that shows what it points to (a GitHub PR, a Figma file, a web page), instead of a bare URL.                                      | S–M    | ✅           |
| 6   | **Presentation mode** (Notion 3.4, beta)                                                                                                                                      | Turn a page into a slideshow (each divider = new slide), full-screen, arrow keys to move. For meetings and demos.                                     | M      | 🤔           |
| 7   | **Custom emoji** (upload your own, used anywhere `:` works)                                                                                                                   | Team logos, project icons as emoji.                                                                                                                   | M      | 🤔           |
| 8   | **Simple table colours** (colour a row or a column)                                                                                                                           | Highlight a header row or a total column in a plain table.                                                                                            | S      | 🤔           |
| 9   | **Office file previews** (Word, Excel, PowerPoint shown in the page, Notion 3.6)                                                                                              | See a `.docx` / `.xlsx` attachment without downloading it.                                                                                            | M      | 🤔           |
| 10  | **Interactive HTML block** (Notion 3.6)                                                                                                                                       | Small custom widgets (a calculator, a chart) written in HTML inside a page. Mostly made by Notion's AI there; a security risk to run arbitrary HTML.  | M      | ❌           |

### B. Databases

| #   | Notion feature                                                                                                                                                              | What it's for (how you use it)                                                                                                                                   | Effort | Suggest |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------- |
| 11  | **Row page layouts** ("Customize layout": pinned properties under the title, property sections, a tabbed layout; relations shown **as a page section**)                     | Make every row page of a database look the same and tidy: the 3 important properties at the top, the rest folded, related tasks shown as a list inside the page. | M–L    | ✅      |
| 12  | **Number shown as a bar or ring** (progress), checkbox / status **"show as"** options                                                                                       | A "% done" column drawn as a progress bar; ratings as stars-like bars.                                                                                           | S      | ✅      |
| 13  | **Freeze columns, row height, load limit** per view                                                                                                                         | Keep the title column visible while scrolling sideways; compact or tall rows; show 25/50/100 rows then "Load more" in big tables.                                | S      | ✅      |
| 14  | **Bulk edit** (select many rows → set a property, duplicate, delete, move)                                                                                                  | Change the status of 30 tasks at once. (Needs checking: our table has row selection for copy/delete, not "edit property for all".)                               | M      | ✅      |
| 15  | **Recurring templates** (a template that creates a page every day/week/month)                                                                                               | "Weekly review" or "Daily standup" pages appear by themselves on schedule.                                                                                       | M      | ✅      |
| 16  | **Form conditional logic** (show a question only if an earlier answer was X) and **file upload questions**                                                                  | Smarter forms: "If bug → ask for steps"; let people attach a screenshot.                                                                                         | M      | ✅      |
| 17  | **Map view + Place property** (Notion 3.0/3.1)                                                                                                                              | Store addresses/places; see rows as pins on a map. For travel, field work, sites, customers. Needs a map tile source (OpenStreetMap).                            | L      | 🤔      |
| 18  | **Feed view**                                                                                                                                                               | Rows shown as a scrolling feed of full pages (like a blog/updates stream), not cards.                                                                            | M      | 🤔      |
| 19  | **Dashboard view** (Notion 3.4: up to 12 widgets — views, charts, KPI numbers — in one database view)                                                                       | One overview screen for a project: open tasks count, a chart, "my tasks", in one place.                                                                          | L      | 🤔      |
| 20  | **Several data sources in one database** ("databases reimagined", 2025)                                                                                                     | One database block holding e.g. Projects + Tasks + Sprints as tabs, set up as one system/template. Complex; integrations must support it.                        | L      | ❌      |
| 21  | **More automation actions and triggers**: edit pages in another (related) database, use formulas/variables in values, "when a button is pressed", send email, post to Slack | Bigger workflows: "when a project is Done, mark all its tasks Done". (Slack/email need those services set up.)                                                   | M      | 🤔      |
| 22  | **"Can create pages" database permission** (Notion 3.4)                                                                                                                     | Let someone add rows without being able to edit others' rows (e.g. a request tracker).                                                                           | S–M    | 🤔      |
| 23  | **Synced databases from GitHub/Jira/external APIs**                                                                                                                         | Issues from GitHub or Jira show up as a live database. Needs each service's API and accounts.                                                                    | L      | ❌      |
| 24  | **Wiki / verified pages** (mark a page "verified until date", owners, a wiki database of pages)                                                                             | Company handbooks: shows which docs are up to date and who owns them.                                                                                            | M      | 🤔      |

### C. Navigation and workspace

| #   | Notion feature                                                                                                                                                                                                                                              | What it's for (how you use it)                                                            | Effort         | Suggest      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------- | ------------ |
| 25  | **Quick find filters and sorting** (only titles, created by, in teamspace, date range; sort by last edited / best match)                                                                                                                                    | Find the right page fast in a big workspace.                                              | M              | ✅           |
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
| 33  | **Request access** (someone without access clicks "Request", the owner gets it in the inbox, approves)  | Today they just see "no access" and must ask the owner outside the app.                   | S–M                        | ✅                             |
| 34  | **Share link for anyone with the link** (view/comment/edit, optionally with expiry), without publishing | Send a page to a client without making it public on the web.                              | M                          | 🤔                             |
| 35  | **Published sites: custom domain**, site theme/nav bar, "Allow duplicate as template"                   | `notes.yourcompany.com` instead of the server address; let visitors copy a template page. | L (domain) / S (duplicate) | 🤔                             |
| 36  | **Admin tools**: audit log, admin content search, disable export/download, SAML SSO, SCIM user sync     | Company security and compliance. We already have OIDC single sign-on.                     | M–L each                   | ❌ (unless a company needs it) |
| 37  | **Slack notifications** (and Slack link previews)                                                       | Mentions and updates go to Slack. Needs a Slack app per server.                           | M                          | ❌                             |
| 38  | **Workspace analytics** (who's active, popular pages)                                                   | For admins of big workspaces. We already have per-page views.                             | M                          | ❌                             |

### E. Import, export, developer platform

| #   | Notion feature                                                                                 | What it's for (how you use it)                                               | Effort | Suggest |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ------- |
| 39  | **Import from Word (`.docx`)** and **Google Docs** (as `.docx`)                                | Bring existing documents in with their formatting.                           | M      | ✅      |
| 40  | **Import from Asana, Jira, Monday** (their CSV/JSON exports)                                   | Move project boards in, like Trello today.                                   | M each | 🤔      |
| 41  | **Import from Dropbox Paper, Quip, Coda, Workflowy**                                           | Less common tools.                                                           | M each | ❌      |
| 42  | **PDF export of a page with all sub-pages / the whole workspace** (ours is one page at a time) | One PDF of a whole handbook.                                                 | S–M    | 🤔      |
| 43  | **API: file uploads, views endpoints, Markdown API** (Notion 3.5)                              | Integrations that attach files, read views, or read/write pages as Markdown. | M      | 🤔      |
| 44  | **Notion CLI and Workers** (hosted custom code)                                                | Developer tooling; heavy, and Notion-specific.                               | L      | ❌      |

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
