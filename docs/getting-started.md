# Getting started

A short tour for your first hour with Workspace: pages, databases, finding things, bringing your
documents in, and working with other people. Everything here works offline in the desktop app;
the parts about other people need the [server](self-hosting.md).

## Pages and blocks

- **A new page:** **New page** in the sidebar, or `Ctrl+N`. Give it a title and press `Enter`
  to start writing.
- **Blocks:** everything on a page is a block: text, headings, lists, to-dos, toggles, quotes,
  callouts, code, tables, images, files, embeds, equations, diagrams and more. Type `/` for the
  menu of all of them, or use Markdown as you type: `#` for a heading, `-` for a list, `[]` for
  a to-do, `>` for a toggle, `"` for a quote, ` ``` ` for code.
- **Quick commands:** `/` also does things: `/red` colours a block, `/today` adds a date,
  `/duplicate`, `/delete`, `/turn into heading 2`.
- **Moving blocks:** hover a block and drag its `⋮⋮` handle, or `Ctrl+Shift+↑`/`↓`. Drop it
  beside another block to make columns.
- **Linking:** `@` mentions a page, a person or a date. Paste a link and choose **Mention** to
  show it as a chip with the site's title, or **Embed** to show the site in the page.
- **Present:** `···` → **Present** shows the page as slides, full screen; each divider starts a
  new slide. Arrow keys move, Escape ends.
- **Verify:** `···` → **Verify** marks a page as checked, for a while or for good; a badge under
  the title says who did and until when.
- **Sub-pages:** `/page` adds a page inside this one. The sidebar shows the tree; drag pages
  there to reorder or nest them, and star the ones you use most.

## Databases

- **Make one:** on an empty page, **Get started with → Database**, or `/database` anywhere for
  one inside a page.
- **Properties:** text, numbers (shown as a number, a bar or a ring), selects, status, dates,
  people, files, checkboxes, links, relations, rollups, formulas (Notion's Formula 2.0) and
  more. Add one from the column header's **+**, or with `/` on a row's page (`/relation`).
- **Views:** table, board, list, gallery, feed, calendar, timeline, chart and form, each with its own
  filters, sorts and groups. **Add a view** next to the view tabs.
- **Rows are pages:** open one to write in it, as a side peek, centred, or full page. **Customize
  layout** on a row page pins the important properties under the title, folds the rest away, or
  shows related pages as a section.
- **Many rows at once:** tick rows (Shift for a range, `Ctrl+A` for all) and set a property,
  duplicate or delete them together.
- **Templates and automations:** a database's templates fill in new rows; **Repeat…** makes one
  every day, week or month. Automations set properties, add pages, notify people or call a
  webhook when something changes.

## Finding things

- **Home** (in the sidebar): the pages you visited last, reminders coming up and the pages
  edited last.
- **People** (in the sidebar): everyone in the workspace, and the pages each one made.
- **Quick find:** `Ctrl+K`. It searches titles and content. The filters under it narrow it:
  titles only, a section, when it was edited, who created it; and it sorts by best match, last
  edited or created.
- **Back and forward:** `Alt+←` and `Alt+→`. **Tabs:** `Ctrl+T` and `Ctrl+click`. A second window:
  `Ctrl+Shift+N`.
- **Backlinks** under a page's title list the pages that link to it, and **Page history** (in the
  page's `···` menu) restores an earlier version.
- **Every shortcut:** `Ctrl+?`, or **Keyboard shortcuts** in the workspace menu.

## Bringing your documents in

**Import** in the sidebar takes a Notion export, Word and Google Docs files (`.docx`), Evernote
notebooks, Trello boards, Asana and Jira CSV exports, monday.com boards (Excel), Confluence
spaces, and Markdown, HTML, CSV and text files. A report
says what came over and anything that didn't. How to export from each app is in the
[desktop guide](desktop.md#import-from-other-apps).

To take things out: **Export…** in a page's `···` menu (Markdown & CSV, HTML or PDF), **Export
all workspace content…** in the workspace menu (a PDF of everything starts with its contents),
or a full backup to a `.zip`.

## With other people

These need a Workspace server: yours, or one someone runs for you
([self-hosting](self-hosting.md)).

1. **Connect:** click the sync line in the sidebar (**Sync is off**), or File → Sync…, and
   enter the server's address. Sign up (the
   first account on a server is its admin) and choose a workspace, or make one from what's on
   this computer.
2. **Invite:** **Members…** in the workspace menu: people by email, as members or guests, and
   groups. Teamspaces give each team its own section of the sidebar.
3. **Share a page:** **Share** at the top of a page, with full access, edit, comment or view;
   or make a **Share link** for someone outside the workspace (they sign in to use it). A
   database can also be shared as **Can create pages**, for request trackers.
   Someone who opens a link to a page they can't see can **Request access**; you get it in your
   inbox and share it in one click.
4. **Work together:** see who's on a page and where their cursor is, comment on text or the whole
   page, `@`-mention people, and follow what's new in the **Inbox**.
5. **Elsewhere:** the same workspace in a browser at the server's address, and pages published
   to the web from **Share → Publish**.

## Where to learn more

- [Everything Workspace does](features.md), area by area.
- [The desktop app](desktop.md): installing, where your data lives, backups, sync.
- [Running the server](self-hosting.md): Docker Compose, sign-in, email, storage, backups.
- [The API](api.md): integrations with Notion's SDK, and webhooks.
