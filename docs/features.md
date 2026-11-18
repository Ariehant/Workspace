# Features

Everything Workspace does today, area by area. The parity target with Notion (and what's out of
scope) is in [PLAN.md](PLAN.md#3-feature-inventory-parity-target-ai-excluded); what's still
planned is in [PHASE7.md](PHASE7.md).

**Contents:** [Pages and the editor](#pages-and-the-editor) ·
[Databases](#databases) · [Workspace and navigation](#workspace-and-navigation) ·
[Import and export](#import-and-export) · [Sync and the web app](#sync-and-the-web-app) ·
[Collaboration](#collaboration) · [Automations and forms](#automations-and-forms) ·
[API and integrations](#api-and-integrations) · [Packaging](#packaging)

## Pages and the editor

- **The slash menu** (`/`): text, headings, to-do, bulleted, numbered and toggle lists, toggle
  headings, quote, divider, callout, table, code, Mermaid diagrams, block and inline equations,
  table of contents, breadcrumb, columns, link to page, new sub-page, buttons, synced blocks and
  databases. Searching it also finds commands for the block you're in: a colour (`/red`,
  `/blue background`), `/turn into h2`, `/duplicate`, `/delete`, `/comment`, `/today`,
  `/reminder`, `/mention` and `/emoji`. On a database row's page, `/relation`, `/select`,
  `/formula` and the other property types add that property to the database (a relation, rollup
  or formula opens its setup; anything else opens for a value).
- **Keyboard shortcuts** as in Notion: move blocks (`Ctrl+Shift+↑/↓`), duplicate (`Ctrl+D`),
  turn into (`Ctrl+Alt+0`–`9`), the last colour again (`Ctrl+Shift+H`), check a to-do or open a
  toggle (`Ctrl+Enter`), go to the parent page (`Ctrl+Shift+U`), back and forward
  (`Ctrl+[`/`]`), dark mode (`Ctrl+Shift+L`). `Ctrl+?` (or **Keyboard shortcuts** in the
  workspace menu) lists them all; so does the [desktop guide](desktop.md#keyboard-shortcuts).
- **Markdown shortcuts:** `#`, `-`, `1.`, `[]`, `>` (toggle), `"` (quote), ` ``` `, `---`, `$$`
  and `$$x$$` (inline equation). Pasting Markdown gives blocks; copying gives Markdown.
- **Blocks:** hover a block for `+` (add below) and `⋮⋮` (drag to move; click for turn into,
  duplicate, copy link, color and delete). Drop a block on another block's edge to make columns.
- **Code:** syntax highlighting for about 190 languages, line numbers, captions, wrapping, and
  Tab/Shift+Tab on selected lines.
- **Diagrams and math:** Mermaid diagrams (code, preview or split) and KaTeX equations, with
  workspace macros and live errors.
- **Media:** images (upload, paste or drop; resize; crop and rotate, the file kept as it is;
  captions), video, audio, PDFs viewed in the page, any file (opens in its default app), web
  bookmarks with previews, and embeds: any https website (in a sandboxed frame, with its site
  named above it and a link to open it, since some sites refuse frames), with links from
  YouTube, Vimeo, Loom, Figma, CodePen, Google Maps, Google Docs, Sheets, Slides, Forms and
  Drive, GitHub Gists, Miro, X, Spotify, SoundCloud, Typeform, Airtable and Excalidraw turned
  into their players. Pasting a link offers Mention, Bookmark or Embed.
- **Tabs** (`/tabs`): content in tabs, one shown at a time. Click the open tab to rename it; `+`
  adds one and `×` deletes the open one; arrow keys move between them. Which tab is open is
  your own (it isn't saved in the page), and moving the cursor into a hidden tab opens it.
  Exports write the tabs one after another, each under its title.
- **Inline formatting:** a toolbar on selected text for bold, italic, underline, strikethrough,
  code, links, colors, equations and turn into. Ctrl+click opens a link.
- **Mentions:** `@` for pages (live titles), people, and dates ("next fri", "in 2 weeks");
  `@remind tomorrow` sets a reminder for 9:00. `:` suggests emoji. A pasted link can become a
  link mention: the site's icon and the page's title, as a link.
- **Find and replace** in a page (`Ctrl+F`).
- **Synced blocks:** the same content in several places, edited anywhere.
- **Buttons:** insert blocks, add or edit database pages, send a webhook or a notification;
  `@today` and `@me` in buttons and templates.
- **Page settings:** emoji or image icons; covers (gradients, colors or images,
  repositionable, and photos from Unsplash on a server with an Unsplash key, credited on the
  cover); font (default, serif, mono), small text, full width, lock, word count.
- **Every block has a stable id**, for block links, comments, sync and the API.

## Databases

Inline or full page (`/database inline`, `/database full page`, or "Get started with:
Database" on an empty page).

- **Property types:** text (with bold, italic, underline, strikethrough, code, colours and
  links: Ctrl+B, I, U, E and K while editing, or its toolbar), number (with formats), select,
  multi-select, status, date (ranges, times, reminders), checkbox, URL, email, phone, files,
  person, formula, relation, rollup, button, created and edited time and by, and unique ID.
- **Show as:** a number (or a number formula or rollup) as a progress bar or a ring, with its
  colour, the value that fills it ("Divide by", 100 by default) and the number beside it or
  not; a status as a checkbox, ticked when it's in the Complete group (ticking sets the first
  Complete option, unticking the first To-do one).
- **Views:** table, board, list, gallery, calendar, timeline, chart (bar, line, pie, donut) and
  form. Each view has its own filters (simple chips or nested AND/OR), sorts, grouping and
  sub-grouping, column calculations, visible properties, card preview and size, and a search.
- **Table:** edit cells in place, keyboard navigation, copy and paste, undo; rename, retype,
  hide, resize, reorder, duplicate and delete columns; drag rows to reorder. "Freeze up to this
  column" keeps the first columns in place when the table scrolls sideways. Large tables only
  render the rows in view.
- **Load limit:** a table, list or gallery can show 10, 25, 50, 100 or 500 pages (per group
  when grouped), then "Load more".
- **Bulk edit:** tick rows in a table (Shift+click for a range, Ctrl+A for all, Escape to let
  go), then set a property for all of them at once (one undo step), duplicate them, copy their
  links or delete them.
- **Formulas:** Notion's Formula 2.0 language, with an editor that highlights, autocompletes,
  documents functions, previews live and points at errors. Results sort, filter and group by
  type.
- **Relations and rollups:** one-way or two-way, across databases or within one, with a page
  picker; rollups with Notion's calculations; sub-items nested in the table; dependencies on
  the timeline.
- **Board:** drag cards between columns, swimlanes, hidden and colored columns.
- **Calendar and timeline:** month and week calendars, drag to reschedule and resize; timeline
  zoom levels, draggable bars and dependency arrows.
- **Templates:** a default template per database or view, linked views of a database in any
  page, simple tables turned into databases and back, locked views and properties. A template
  can **repeat**: a new page from it every day, on chosen weekdays or every month, at a time
  (it's a scheduled automation, run by the server while the workspace syncs, or by the
  desktop).
- **Rows are pages:** open them in a side peek, a center peek or full page, with their
  properties above the content. Rows show up in quick find, can be linked to, and go to the
  trash when deleted.
- **Customize layout** (on a row page, for every page of the database): up to four properties
  pinned under the title; the others in the page, folded behind "Properties", or in a side
  panel; relations shown as sections of the page, listing the linked pages with a few of
  their properties, to open, add or remove.

## Workspace and navigation

- **Sidebar:** a page tree with drag and drop to reorder or nest, favorites and a resizable
  width. On a server workspace: sections for teamspaces, pages shared with you and your private
  pages.
- **Quick find** (`Ctrl+K` / `Ctrl+P`) over titles and content, with recent pages;
  `Ctrl+Enter` opens the result in a new window. Filters narrow it: titles only, a section
  (a teamspace, Shared or Private), when it was edited (today, past 7 or 30 days, past year)
  and, on a server, who created it. It sorts by best match, last edited or created; with a
  filter and nothing typed, it lists what the filter lets through. Pages made before Phase 8
  N4 don't record who created them (database rows always did).
- **Tabs and windows:** `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`; Ctrl+click or middle-click opens in a new
  tab; drag tabs to reorder them or out of the window. Several windows stay in sync live
  (`Ctrl+Shift+N`). Tabs and their history come back after a restart.
- **Back and forward** with `Alt+←`/`Alt+→` or the mouse's side buttons.
- **`workspace://page/…` links** open pages and blocks, including from other apps.
- **Backlinks** under every page title, and **page history** with preview and restore.
- **Trash:** restore or delete permanently; pages are deleted after 30 days.
- **Templates gallery:** built-in templates for personal use, projects, engineering and a
  robotics lab, with previews. "Save as template" adds your own.
- **Themes:** light, dark and system.
- **Zoom** from 50% to 300% (`Ctrl+=`, `Ctrl+-`, `Ctrl+0` or `Ctrl` + wheel) in the desktop app,
  for every window, remembered.
- **Language and region:** dates, times, numbers and the first day of the week follow your
  region, or each your own way. The app's text is in English.
- **Accessibility:** keyboard use throughout (the page tree and tables included), names and
  roles for screen readers, WCAG AA contrast in both themes, and reduced motion. Checked with
  axe on every screen.
- Everything is saved as you type and survives restarts, including the last open page and
  which sidebar items are expanded.

## Import and export

- **Import** (sidebar → Import): a Notion export zip (Markdown & CSV, or HTML), and Markdown,
  HTML, CSV and text files. Pages, databases with inferred types and relations, links and
  attachments come across.
- **Import from Evernote, Trello and Confluence:** an Evernote notebook (`.enex`) as a database
  of notes with tags, dates, checklists and attachments; a Trello board (its JSON export) as a
  database with a board view by list, cards with labels, due dates, checklists and comments;
  and a Confluence space (its HTML export zip) as the page tree, with panels, code, tasks,
  attachments and links between pages. See the
  [desktop guide](desktop.md#import-from-other-apps) for how to export from each.
- **Import Word and Google Docs** (`.docx`; Google Docs: File → Download → Microsoft Word):
  headings (by style, in any language), bullet, numbered and nested lists, checklists, bold,
  italic, underline, strikethrough, code, colours, links, quotes, code blocks, tables (with
  header rows and merged cells), pictures with their captions, and footnotes. One document
  becomes the page itself, titled from its Title. Equations, comments and text boxes come
  across as text, or are listed in the report.
- **Export** a page (`···` → Export…) or the whole workspace as Markdown & CSV in Notion's
  layout, HTML, or PDF.
- **Backups:** the whole workspace to a `.zip`, and restore from one.

## Sync and the web app

These need the [self-hosted server](self-hosting.md).

- **Sync between devices:** sign in with a password or single sign-on, upload this workspace or
  use one from the server, and keep working offline. Changes and attachments sync when the
  connection is back, and edits made on both sides merge.
- **The web app:** the same UI in a browser, at your server's address. It keeps only the pages
  you open, and works while connected. It exports Markdown & CSV and HTML (made by the server)
  and PDF (through the browser's print); import and backups are desktop features.
- **Server search** over everything you can read, and server-side page history and backlinks,
  so the web app has them too.

## Collaboration

- **Members:** invite people by email (a link to send, or an email when the server has SMTP) as
  admins, members or guests; groups; names and pictures.
- **Sharing:** teamspaces and per-page sharing with full access, can edit, can edit content
  (database rows only), can comment and can view, inherited down the page tree. The server
  enforces it on every write.
- **Request access:** a link or mention of a page you can't open shows "You don't have access
  to this page" (nothing else about it), where you ask to view, comment or edit, with a
  message. The people with full access to it get the request in their inbox and in its share
  dialog, and share it in one click (or decline); once shared, it opens where you were. A
  database row is asked for as its database. Up to 20 requests an hour.
- **Presence:** avatars in the page header, named cursors in the editor, dots in the sidebar
  and avatars on database rows others have open.
- **Comments:** on selected text or the whole page, with replies, @-mentions, reactions and
  resolve. People who may only comment suggest edits, which an editor accepts or rejects.
- **Inbox:** mentions, comments and replies on pages you follow, reminders, pages shared with
  you and requests for access (with Share and Decline), live, with desktop notifications. Email digests: after a mention, or daily, with
  one-click unsubscribe.
- **Publish to web:** a public, read-only page (with its sub-pages if you like), with view
  counts.

## Automations and forms

- **Automations** on a database: when a page is added, a property changes, or on a schedule,
  set properties, add pages, notify people or call a webhook (signed with
  `X-Notion-Signature`). On a server they run on the server, with the access of the person who
  made them; on a desktop that isn't synced, the app runs them (catching up on missed
  schedules).
- **Forms:** a database's form view, filled in from the app, or shared by link and filled in
  by anyone in a browser. Each response is a new row.
  - **Conditions:** a question can show only when an earlier select, status or multi-select
    answer is one of some options, or a checkbox is ticked (or not). The public page does this
    without script (CSS), and the server applies the conditions to what it's sent: a hidden
    question isn't required, and an answer to it is dropped.
  - **File questions:** up to 5 files (10 MB each, 25 MB a response on the public page),
    stored as the workspace's attachments and shown in the row's files property. A new form
    doesn't ask for files until a file question is added.

## API and integrations

- **A REST API in Notion's shape** at `/v1`: pages, blocks, databases, data sources, comments,
  search and users, in API versions `2022-06-28` and `2025-09-03`. The official SDK works
  unchanged.
- **Integrations** with tokens and capabilities, connected to pages like people are.
- **Webhooks** for page, database and comment events, verified and signed as Notion's are.

The [API guide](api.md) has the details.

## Packaging

- `.deb` and AppImage packages for Ubuntu 24.04 and later; the `.deb` includes an AppArmor
  profile for Chromium's sandbox. See the [desktop guide](desktop.md).
- The server as a Docker image, with a Compose stack behind Caddy. See the
  [self-hosting guide](self-hosting.md).
