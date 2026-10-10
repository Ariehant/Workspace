# Workspace

An offline-first replacement for Notion's core features (pages, rich text, databases, and later sync
and collaboration) that runs natively on Ubuntu 24.04 and later. Notion AI features are out of scope.

The roadmap and architecture are in [docs/PLAN.md](docs/PLAN.md). **Status:** Phase 0 (foundation) and
Phase 1 (editor and navigation, see [docs/PHASE1.md](docs/PHASE1.md)) and Phase 2 (databases,
see [docs/PHASE2.md](docs/PHASE2.md)) are complete. Phase 3 (power features, see [docs/PHASE3.md](docs/PHASE3.md)) is done
except its last check, importing a real Notion export. Phase 4 (sync server, see
[docs/PHASE4.md](docs/PHASE4.md)) is complete: a self-hosted server (Docker Compose behind Caddy), accounts and SSO,
offline-first sync between desktops, server-side search and attachments, and the web app. Two desktops
converge after offline edits and restarts. Phase 5 (collaboration, see [docs/PHASE5.md](docs/PHASE5.md)) is complete: members,
invites, roles and groups, profiles and @-mentions of people are done (M1), and the server now
decides who sees and edits what: scopes (teamspaces, private pages, shared pages) with roles,
enforced per doc on the sync socket, search and page location (M2). The app shows it all
(M3): sidebar sections for teamspaces, pages shared with you and your private pages, a share
dialog, teamspace settings, read-only pages for viewers, and moving pages between sections.
People on the same page see each other (M4): avatars in the page header, named cursors in the
editor, a dot in the sidebar on pages others are viewing, and avatars on database rows others
have open. Comments work too (M5): comment on selected text or on the whole page, reply,
@-mention, react and resolve, in a comments panel. People who may only comment suggest edits
instead, and someone who may edit accepts or rejects them. The inbox (M6) collects mentions,
comments and replies on pages you follow, reminders and pages shared with you, live, with
desktop notifications. Pages can be published to the web (M7), readable without signing in,
and the server keeps backlinks and page history, so the web app has them too. The exit check
passes: three accounts on two desktops and the web app, crafted clients that try to get around
the checks, and the Docker stack with a second account. Phase 6 (automations, forms and a
Notion-compatible API, see [docs/PHASE6.md](docs/PHASE6.md)) is under way. M1 is done: a database
can be shared as "Can edit content" (rows, not properties or views, checked by the server), the
server can edit docs on someone's behalf through the same checks, and it has a job queue. M2 adds
forms: a database's form view, filled in from the app (even by people who may only view it) or,
shared by link, by anyone in a browser, with each response a new row. M3 adds automations: when a page is added, a property is
edited or on a schedule, the server edits the page, adds pages, notifies people or sends a
signed webhook, acting with the access of the person who made it. M4 runs them on a desktop
whose workspace isn't synced too (schedules included, catching up after the app was closed),
and buttons can send a webhook or a notification. M5 adds integrations and the API: owners make
an integration with a token, connect pages to it, and it uses Notion's API (`/v1`, the
official SDK works) on those pages: users, pages, databases and data sources, queries and
search. M6 adds page content (blocks: read, appended, changed and deleted by id, while people
edit the same page live), comments, and signed links to stored files.

## What works today

- Desktop app (Electron) with a page tree in the sidebar: create pages, drag to reorder or nest
  them, favorites, and a resizable sidebar. Trash: restore or delete permanently; pages are deleted
  automatically after 30 days.
- Quick find (`Ctrl+K` / `Ctrl+P`) over titles and content, with recent pages; `Ctrl+Enter` opens
  the result in a new window. Back and forward with `Alt+←`/`Alt+→` or the mouse's side buttons.
- Tabs: `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`; Ctrl+click or middle-click anything that opens a page to
  open it in a new tab. Drag tabs to reorder them or out of the window. Tabs, with their
  history, come back after a restart.
- `workspace://page/…` links to pages and blocks open in the app, including from other apps.
- Rich-text page editor (TipTap/ProseMirror):
  - `/` opens a filterable block menu: text, headings, to-do, bulleted/numbered and toggle lists,
    toggle headings, quote, divider, callout, table, code (syntax highlighting for ~190
    languages, line numbers, captions, Tab/Shift+Tab on selected lines), Mermaid diagrams,
    block and inline equations (KaTeX, with workspace macros and live errors), table of
    contents, breadcrumb, columns, link to page and new sub-page.
  - Markdown shortcuts: `#`, `-`, `1.`, `[]`, `>` (toggle), `"` (quote), ` ``` `, `---`, `$$`,
    `$$x$$` (inline equation).
  - Hover a block for `+` (add below) and `⋮⋮` (drag to move; click for turn into, duplicate,
    copy link, delete). Drop a block on another block's left or right edge to make columns.
  - Media: images (upload, paste or drop; resize; captions), video, audio, PDFs (viewed in the
    page), any file (opens in its default app), web bookmarks with previews, and embeds from
    YouTube, Vimeo, Loom, Figma, CodePen and Google Maps. Pasting a link offers Bookmark or Embed.
  - Selecting text shows a toolbar for bold, italic, underline, strikethrough, code, links,
    colors, equations and turn into. Ctrl+click opens a link. Blocks can be colored from the `⋮⋮`
    menu.
  - `@` mentions pages (live titles) and dates ("next fri", "in 2 weeks"); `@remind tomorrow`
    sends a desktop notification at 9:00. `:` suggests emoji.
  - Paste Markdown to get blocks; copy gives Markdown as plain text. Ctrl+F finds and replaces.
- Databases, inline or full page (`/database inline`, `/database full page`, or "Get started
  with: Database" on an empty page):
  - Property types: text, number, select, multi-select, status, date (ranges, times), checkbox,
    URL, email, phone, files, person, created/edited time and by, and unique ID.
  - Table view: edit cells in place, keyboard navigation, copy and paste, undo; sort; rename,
    retype, hide, resize, reorder, duplicate and delete columns; drag rows to reorder. Large
    tables only render the rows in view.
  - Several views per database, each with its own filters (simple chips or nested AND/OR),
    sorts, grouping and sub-grouping, column calculations and visible columns; search inside a
    view. Number, date and time formats; reminders on dates.
  - Formulas (Notion's Formula 2.0 language): an editor with highlighting, autocomplete,
    function docs, live preview and error positions; results sort, filter and group by type.
  - Relations (one-way or two-way, across databases or within one) with a page picker,
    rollups with Notion's calculations, sub-items nested in the table, and dependencies.
  - Board (drag cards between columns, swimlanes, hidden and colored columns), list and gallery
    views, with card previews (cover, first image, files) and card sizes.
  - Calendar (month/week, drag to reschedule and resize), timeline (zoom levels, draggable
    bars, dependency arrows) and chart views (bar, line, pie, donut).
  - Buttons (insert blocks, add or edit database pages) and a button property; `@today` and
    `@me` in buttons and templates.
  - Database templates (default per database or view), linked views of a database in any
    page, simple tables turned into databases and back, locked views and properties.
  - Rows are pages: open them in a side peek, a center peek or full page, with their properties
    above the content. Rows show up in quick find (including their property text), can be
    linked to, and go to the Trash when deleted.
- Synced blocks: the same content in several places, edited anywhere.
- Backlinks under every page title, and page history with preview and restore.
- Export a page (`···` → Export…) or the whole workspace (click "Workspace" at the top of the
  sidebar) as Markdown & CSV in Notion's layout, HTML, or PDF; back up the workspace to a
  `.zip` and restore it.
- Import (sidebar → Import) a Notion export zip (Markdown & CSV or HTML) or Markdown, HTML, CSV
  and text files: pages, databases with inferred types and relations, links and attachments.
- Templates gallery (sidebar → Templates): built-in templates for personal use, projects,
  engineering and a robotics lab, with previews. "Save as template" in a page's `···` menu adds
  your own.
- Every block has a stable id, ready for block links, comments and sync later.
- Everything is saved locally as you type and survives restarts, including the last open page and
  which sidebar items are expanded.
- Several windows on the same workspace stay in sync live (File → New Window, `Ctrl+Shift+N`).
- Light, dark and system themes.
- Page icons (emoji or image) and covers (gradients, colors or images, repositionable).
- Page menu: font (default, serif, mono), small text, full width, lock, duplicate (with
  sub-pages), move to, copy link, word count.
- Sync between devices through a server you host (sidebar → "Sync is off", or File → Sync…):
  sign in with a password or single sign-on, upload this workspace or use one from the server,
  and keep working offline; changes and attachments sync when the connection is back.
- Teams on a server workspace: invite people by email (a link to send, or an email when the
  server has SMTP) as admins, members or guests; roles, groups, and your name and picture
  (Members in the sidebar, Your profile in the workspace menu). @-mention people in pages, and
  pick them in person properties.
- `.deb` and AppImage packages for Ubuntu.

## Requirements

- Ubuntu 24.04 or later (x86-64). Other modern Linux desktops should work too.
- For development: Node.js 22.13 or later (24 LTS recommended) and pnpm 10
  (`corepack enable` sets up the pinned version).

## Development

```sh
pnpm install
pnpm dev            # launch the desktop app with hot reload
```

| Command             | What it does                                                |
| ------------------- | ----------------------------------------------------------- |
| `pnpm dev`          | Run the desktop app in development mode                     |
| `pnpm build`        | Build all packages                                          |
| `pnpm typecheck`    | Type-check every package                                    |
| `pnpm test`         | Unit tests (Vitest)                                         |
| `pnpm test:e2e`     | End-to-end tests driving the real Electron app (Playwright) |
| `pnpm test:e2e:web` | The web app's end-to-end tests (Chromium, real server)      |
| `pnpm dev:web`      | The web app with hot reload (`VITE_SERVER=<server url>`)    |
| `pnpm lint`         | ESLint                                                      |
| `pnpm format`       | Prettier                                                    |
| `pnpm package`      | Build `.deb` and AppImage into `apps/desktop/dist/`         |

E2E tests need a display. On a headless machine, run `pnpm --filter @workspace/desktop build`
first, then `xvfb-run -a pnpm test:e2e`.

## Installing on Ubuntu

**.deb (recommended):**

```sh
sudo apt install ./workspace-app_0.1.0_amd64.deb
workspace-app
```

The package installs an AppArmor profile so Chromium's sandbox works under Ubuntu 24.04's
user-namespace restrictions.

**AppImage:** Ubuntu 24.04 needs FUSE 2 (`sudo apt install libfuse2t64`). Ubuntu's AppArmor
policy also blocks the Chromium sandbox for AppImages; until signed AppImage profiles are in
place, prefer the `.deb`.

### Where data is stored

| What                                 | Location                                                               |
| ------------------------------------ | ---------------------------------------------------------------------- |
| Workspace database (pages, content)  | `~/.local/share/workspace-app/workspace.db` (honours `$XDG_DATA_HOME`) |
| Attachments (images, PDFs, files)    | `~/.local/share/workspace-app/files/`                                  |
| Chromium profile (caches, GPU state) | `~/.config/Workspace/`                                                 |

With sync on, the database also holds the changes waiting for the server, and the sign-in
(encrypted with the system keyring when there is one).

Back up the workspace by copying `workspace.db` and the `files/` folder while the app is closed. Set `WORKSPACE_DATA_DIR`
to use a different directory, for example to keep separate workspaces.

## Self-hosting the sync server

The server runs with Docker Compose on Ubuntu 24.04: Caddy (automatic HTTPS), the server and
Postgres 16, with attachments on a volume (or in S3 with `docker-compose.s3.yml`).

```sh
cd infra
cp .env.example .env   # set DOMAIN and the passwords
docker compose up -d
```

The first account created becomes the server admin. After that, `SIGNUP` decides who can join:
`open`, `invite` (the default) or `disabled`. Admins manage accounts from the command line:

```sh
docker compose exec server workspace-admin create-invite [email]
docker compose exec server workspace-admin create-user ada@example.com "Ada" [--admin]
docker compose exec server workspace-admin reindex   # rebuild the search index
docker compose exec server workspace-admin help      # all commands
```

Single sign-on works with any OpenID Connect provider (GitLab, Google, Keycloak, Authentik…).
Set `OIDC_*` in `.env` (see `.env.example`).

People join a workspace through an invite from its owners or admins (Members → Invite), which
also lets them sign up on an invite-only server. Set `SMTP_URL` and `SMTP_FROM` for the server
to email invites; otherwise the invite links are shown to copy and send.

`infra/workspace.service` runs it under systemd and `infra/backup.sh` backs it up.

- **In a browser:** open `https://<DOMAIN>`. The web app is the same UI. It keeps only the pages
  you open, and works while connected (export, import, backups and page history are desktop
  features).
- **On a desktop:** open Sync in the sidebar and enter `https://<DOMAIN>`.

## Architecture

```
apps/
  desktop/          Electron main process, preload bridge, renderer entry, packaging
packages/
  core/             Data model on Yjs: pages, page tree, blocks, DocClient sync
  storage-local/    SQLite persistence (node:sqlite), DocManager, search index
  editor/           TipTap editor bound to a page's Yjs document
  ui/               Design tokens (Tailwind), themes, buttons, menus
  app/              Shared React screens: sidebar, page view, app shell
  storage-remote/   Postgres store for the sync server (migrations, update log, accounts)
  sync/             Sync protocol: messages, the server hub and the clients (no I/O)
apps/server/        Sync server (Fastify: auth, workspaces, WebSocket sync, search), bundled with esbuild
apps/web/           The web app: the shared UI on the server (Vite)
infra/              Docker Compose stack, Caddyfile, systemd unit, backup script
```

- **All data is Yjs CRDT documents.** One _workspace doc_ holds every page's metadata (title, icon,
  parent, order, trash state). Each page has its own _page doc_ with the editor content. Concurrent
  edits always merge, which makes the planned sync server and real-time collaboration an addition
  rather than a rewrite.
- **The main process owns the data.** `DocManager` keeps the live documents, appends every update
  to SQLite, relays it to the other windows and keeps the search index current. Renderer windows
  are sandboxed and reach it only through the typed preload API (`window.workspace`).
- **No native modules.** SQLite comes from Electron's built-in `node:sqlite` (with FTS5), and
  every JavaScript dependency is bundled, so packages ship without `node_modules`.
- **Shared UI.** `packages/app` talks to its host only through the `Platform` interface, so the
  planned web build can reuse it over the sync server.
