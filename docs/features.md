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
  databases.
- **Markdown shortcuts:** `#`, `-`, `1.`, `[]`, `>` (toggle), `"` (quote), ` ``` `, `---`, `$$`
  and `$$x$$` (inline equation). Pasting Markdown gives blocks; copying gives Markdown.
- **Blocks:** hover a block for `+` (add below) and `⋮⋮` (drag to move; click for turn into,
  duplicate, copy link, color and delete). Drop a block on another block's edge to make columns.
- **Code:** syntax highlighting for about 190 languages, line numbers, captions, wrapping, and
  Tab/Shift+Tab on selected lines.
- **Diagrams and math:** Mermaid diagrams (code, preview or split) and KaTeX equations, with
  workspace macros and live errors.
- **Media:** images (upload, paste or drop; resize; captions), video, audio, PDFs viewed in the
  page, any file (opens in its default app), web bookmarks with previews, and embeds from
  YouTube, Vimeo, Loom, Figma, CodePen and Google Maps. Pasting a link offers Bookmark or Embed.
- **Inline formatting:** a toolbar on selected text for bold, italic, underline, strikethrough,
  code, links, colors, equations and turn into. Ctrl+click opens a link.
- **Mentions:** `@` for pages (live titles), people, and dates ("next fri", "in 2 weeks");
  `@remind tomorrow` sets a reminder for 9:00. `:` suggests emoji.
- **Find and replace** in a page (`Ctrl+F`).
- **Synced blocks:** the same content in several places, edited anywhere.
- **Buttons:** insert blocks, add or edit database pages, send a webhook or a notification;
  `@today` and `@me` in buttons and templates.
- **Page settings:** emoji or image icons; covers (gradients, colors or images,
  repositionable); font (default, serif, mono), small text, full width, lock, word count.
- **Every block has a stable id**, for block links, comments, sync and the API.

## Databases

Inline or full page (`/database inline`, `/database full page`, or "Get started with:
Database" on an empty page).

- **Property types:** text, number (with formats), select, multi-select, status, date (ranges,
  times, reminders), checkbox, URL, email, phone, files, person, formula, relation, rollup,
  button, created and edited time and by, and unique ID.
- **Views:** table, board, list, gallery, calendar, timeline, chart (bar, line, pie, donut) and
  form. Each view has its own filters (simple chips or nested AND/OR), sorts, grouping and
  sub-grouping, column calculations, visible properties, card preview and size, and a search.
- **Table:** edit cells in place, keyboard navigation, copy and paste, undo; rename, retype,
  hide, resize, reorder, duplicate and delete columns; drag rows to reorder. Large tables only
  render the rows in view.
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
  page, simple tables turned into databases and back, locked views and properties.
- **Rows are pages:** open them in a side peek, a center peek or full page, with their
  properties above the content. Rows show up in quick find, can be linked to, and go to the
  trash when deleted.

## Workspace and navigation

- **Sidebar:** a page tree with drag and drop to reorder or nest, favorites and a resizable
  width. On a server workspace: sections for teamspaces, pages shared with you and your private
  pages.
- **Quick find** (`Ctrl+K` / `Ctrl+P`) over titles and content, with recent pages;
  `Ctrl+Enter` opens the result in a new window.
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
- Everything is saved as you type and survives restarts, including the last open page and
  which sidebar items are expanded.

## Import and export

- **Import** (sidebar → Import): a Notion export zip (Markdown & CSV, or HTML), and Markdown,
  HTML, CSV and text files. Pages, databases with inferred types and relations, links and
  attachments come across.
- **Export** a page (`···` → Export…) or the whole workspace as Markdown & CSV in Notion's
  layout, HTML, or PDF.
- **Backups:** the whole workspace to a `.zip`, and restore from one.

## Sync and the web app

These need the [self-hosted server](self-hosting.md).

- **Sync between devices:** sign in with a password or single sign-on, upload this workspace or
  use one from the server, and keep working offline. Changes and attachments sync when the
  connection is back, and edits made on both sides merge.
- **The web app:** the same UI in a browser, at your server's address. It keeps only the pages
  you open, and works while connected (export, import, backups and page history are desktop
  features).
- **Server search** over everything you can read, and server-side page history and backlinks,
  so the web app has them too.

## Collaboration

- **Members:** invite people by email (a link to send, or an email when the server has SMTP) as
  admins, members or guests; groups; names and pictures.
- **Sharing:** teamspaces and per-page sharing with full access, can edit, can edit content
  (database rows only), can comment and can view, inherited down the page tree. The server
  enforces it on every write.
- **Presence:** avatars in the page header, named cursors in the editor, dots in the sidebar
  and avatars on database rows others have open.
- **Comments:** on selected text or the whole page, with replies, @-mentions, reactions and
  resolve. People who may only comment suggest edits, which an editor accepts or rejects.
- **Inbox:** mentions, comments and replies on pages you follow, reminders, and pages shared
  with you, live, with desktop notifications. Email digests: after a mention, or daily, with
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
