# Plan: Notion-equivalent workspace app for Ubuntu 24.04+ (no AI)

## Context
`ariehant/workspace` is an empty repo (no commits). The goal is a self-built replacement for Notion that has all of its core features except Notion AI. It must run on Ubuntu 24.04 and later.

Decisions already made:
- **Deployment:** an offline-first desktop app that works fully on its own, plus an optional self-hosted sync server (Docker) for several devices and users.
- **Stack:** TypeScript throughout: Electron + React + Node.
- **Collaboration:** the data model is CRDT-based from day one. Real-time multi-user features (presence, sharing, permissions) come in a later phase.

Out of scope: Notion AI (Q&A, writers, autofill, AI blocks, AI connectors), Notion Mail, Notion Calendar as a separate app, and Notion's marketplace.

---

## 1. Architecture

```
┌──────────────── Desktop (Electron, Ubuntu) ────────────────┐
│ Renderer: React + TipTap/ProseMirror + Yjs                 │
│   editor · sidebar · database views · search UI            │
│ Main process (Node):                                        │
│   SQLite (node:sqlite)     ← metadata, index, FTS5         │
│   Yjs update log (SQLite blobs) ← page content            │
│   Local file store (~/.local/share/<app>/files)            │
│   Sync client (y-websocket/Hocuspocus provider) ──────┐    │
└───────────────────────────────────────────────────────┼────┘
                                                        │ WSS + HTTPS
┌──────────────── Self-host server (Docker Compose) ────▼────┐
│ API: Fastify (REST + tRPC/OpenAPI), Auth (sessions, OIDC)  │
│ Realtime: Hocuspocus (Yjs WebSocket server)                │
│ PostgreSQL (metadata, permissions, Yjs updates)            │
│ MinIO / S3 (attachments)   Meilisearch (search, optional)  │
│ Worker (BullMQ + Redis): exports, imports, reminders,      │
│   automations, webhooks, thumbnailing                      │
│ Same React UI also served as a web app                     │
└────────────────────────────────────────────────────────────┘
```

Key choices and why:
- **Electron rather than Tauri.** On Linux, Tauri renders through WebKitGTK, which behaves inconsistently with contenteditable and ProseMirror. Electron ships Chromium, so the editor behaves the same everywhere. Packaging is mature (.deb, AppImage, Snap, Flatpak) and it runs on Wayland and X11.
- **Yjs CRDT for every page and database row.** Offline edits merge without conflicts, and adding real-time collaboration later only means connecting a provider. Nothing has to be migrated.
- **Everything is a block.** As in Notion, pages, database rows and content blocks share one tree model: `Block {id, type, parentId, props, children[]}`. A database is a block with a schema, its rows are page blocks, and views are separate records.
- **One codebase for the UI.** The desktop renderer and the server's web app use the same React packages.

## 2. Monorepo layout (pnpm + Turborepo)
```
apps/
  desktop/        Electron main + preload + packaging (electron-builder)
  web/            Vite build of the UI for browser access (served by server)
  server/         Fastify API + Hocuspocus + workers
packages/
  core/           Block model, Yjs schema bindings, ops, IDs (no UI)
  editor/         TipTap extensions: every block type, slash menu, DnD
  database/       Property types, formula engine, filters/sorts/groups, views
  ui/             Design system (Radix + Tailwind), icons, themes
  app/            Screens: sidebar, page, search, settings (shared desktop/web)
  storage-local/  SQLite + Yjs persistence adapter (desktop)
  storage-remote/ Postgres adapter + sync protocol (server)
  importers/      Notion zip, Markdown, CSV, HTML, Evernote, Confluence
  exporters/      Markdown, CSV, HTML, PDF (Chromium printToPDF)
  api-sdk/        Public REST API client + types
infra/            docker-compose.yml, Dockerfiles, Caddy (TLS), backups
```
Tooling: TypeScript strict, ESLint, Prettier, Vitest for unit tests, Playwright for E2E (it supports Electron too), GitHub Actions CI on `ubuntu-24.04`.

## 3. Feature inventory (parity target, AI excluded)

**Editor and blocks**
- Text blocks: text, H1–H3 (including toggle headings), bulleted, numbered and to-do lists, toggle, quote, callout, divider.
- Code (syntax highlighting with Shiki, language picker), inline and block equations (KaTeX), Mermaid diagrams.
- Simple table (row and column headers), column layouts, table of contents, breadcrumb, link to page, synced blocks.
- Buttons and template buttons.
- Media: images (resize, caption, crop), video, audio, PDF and file embeds, web bookmarks (unfurl), generic iframe embeds (YouTube, Figma, GitHub gist and so on).
- Inline formatting: bold, italic, underline, strikethrough, code, link, text and background colors, @mentions (page, person, date, reminder), emoji, inline equations.
- Editing tools: slash `/` menu, Markdown shortcuts, a "turn into" menu, drag handle with drag-and-drop for blocks and columns, multi-block selection, copy/paste of rich HTML and Markdown, undo/redo, find and replace in a page.
- Page settings: emoji or image icons, cover images (upload, gallery, Unsplash optional), full width, small text, three font choices, locked pages, word count.

**Databases**
- Views: table, board, list, gallery, calendar, timeline (Gantt), chart (bar, line, pie, donut) and form.
- Properties: text, number (with formats), select, multi-select, status, date (ranges and reminders), person, files, checkbox, URL, email, phone, formula (Notion Formula 2.0-compatible engine), relation (one-way and two-way), rollup, created time and by, last edited time and by, unique ID, button.
- Per view: filters (including nested groups), sorts, grouping, sub-grouping, column calculations, hidden properties, card preview and size.
- Inline and full-page databases, linked views of existing databases, database templates with a default template, sub-items, dependencies on the timeline, row locking.
- Row pages open as a side peek, a center modal or a full page.
- Automations: triggers on property changes and on schedules, with actions such as setting a property, adding a page, sending a notification or calling a webhook.

**Workspace and navigation**
- Sidebar page tree with nesting, drag-and-drop reordering, favorites, private pages, teamspaces, recently viewed, and a trash with restore and permanent delete.
- Quick find search (Ctrl+K) with filters and full text over page content.
- Backlinks, page history with version restore, a templates gallery, duplicate and move-to, multiple windows and tabs, and the full set of Notion keyboard shortcuts.
- Light, dark and system themes. Settings for language and date formats.

**Collaboration (phase 5)**
- Accounts, workspaces, members, groups, guests.
- Sharing per page and per teamspace (full access, can edit, can comment, can view) with permissions inherited down the page tree.
- Real-time co-editing, live cursors and presence avatars.
- Comments and discussions, inline and on the page, with resolve. Suggested edits.
- Inbox with notifications for mentions, comments and reminders. Desktop notifications through libnotify.
- Publish to web as a public read-only site (with SEO options and an optional custom domain on the server). Page analytics.

**Import, export and integrations**
- Import: Notion export zip (Markdown+CSV and HTML), Markdown, CSV, HTML, plain text, Evernote ENEX, Confluence, Trello.
- Export: Markdown+CSV, HTML, PDF, and a full workspace backup.
- A public REST API compatible in shape with Notion's API (pages, blocks, databases, data sources, search, users), integration tokens, and webhooks.
- Web clipper: a later, optional browser extension.

## 4. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| **0. Foundation** (1–2 wk) ✅ done | Monorepo, CI on ubuntu-24.04, Electron shell, design system, `core` block model on Yjs, SQLite persistence, IPC bridge | App launches, a page persists across restarts |
| **1. Editor MVP** (4–6 wk) ✅ done | All text, list, media and layout blocks; slash menu; Markdown shortcuts; DnD; inline formatting; mentions; page icon and cover; sidebar tree; trash; quick find (SQLite FTS5) | Can replace Notion for personal notes |
| **2. Databases** (6–8 wk) ✅ done, plan: [PHASE2.md](PHASE2.md) | Property system, formula engine, table/board/list/gallery/calendar/timeline/chart views, filters/sorts/groups, relations/rollups, templates, linked views, side peek | Notion's own database templates can be rebuilt |
| **3. Power features** (3–4 wk) ✅ done (real-export check pending), plan: [PHASE3.md](PHASE3.md) | Synced blocks, buttons, page history, backlinks, templates gallery, multi-window/tabs, import/export (Notion zip first), Mermaid/KaTeX/code | A real Notion export imports with no meaningful loss |
| **4. Sync server** (4–5 wk) ✅ done, plan: [PHASE4.md](PHASE4.md) | Docker Compose stack, auth (email/password + OIDC), Hocuspocus sync, attachment upload to MinIO, device sync, web app build | Two devices for one user stay in sync, including after offline edits |
| **5. Collaboration** (5–6 wk) ✅ done, plan: [PHASE5.md](PHASE5.md) | Workspaces, members, guests, permissions, presence and cursors, comments, inbox and notifications, publish to web | Several users co-edit with the correct permission checks |
| **6. Automation & API** (3–4 wk) ✅ done, plan: [PHASE6.md](PHASE6.md) | Database automations, forms, reminders (done in Phase 5), public REST API, webhooks, integration tokens; the "can edit content" database role (moved from Phase 5); a Postgres job queue instead of Redis | API conformance tests pass |
| **7. Polish & release** (ongoing) in progress, plan: [PHASE7.md](PHASE7.md) | Performance (pages with 10k blocks, databases with 50k rows using virtualized views), accessibility, i18n, auto-update, signed packages | Release v1.0 |

## 5. Ubuntu packaging and running
- **Desktop builds with electron-builder:** `.deb` (apt-installable, with a desktop entry and MIME and URL handling for `app://` deep links), AppImage, Snap (strict confinement with the home and network plugs), and Flatpak (Flathub manifest).
- **Runtime:** Electron's bundled Chromium. Target the glibc that ships with 24.04. Wayland via `--ozone-platform-hint=auto`, with X11 fallback. Notifications through libnotify. The system tray uses AppIndicator.
- **Data location:** `~/.local/share/<app>/` (XDG-compliant). Backups are a single SQLite file plus a files directory.
- **Updates:** electron-updater for AppImage. The apt repository and the Snap and Flatpak stores handle updates for their own packages.
- **Server:** `docker compose up` on Ubuntu 24.04 starts Caddy (automatic TLS), the API, Hocuspocus, Postgres 16, Redis, MinIO and the optional Meilisearch. A systemd unit wraps compose. Includes a backup script (pg_dump + MinIO mirror).

## 6. Critical technical risks and mitigations
- **Editor complexity**, especially DnD, columns, synced blocks and selection across blocks. Build on TipTap/ProseMirror with `y-prosemirror` and write a Playwright interaction test for every block type.
- **Databases at scale.** Store each row as its own Yjs subdocument, keep a materialized index in SQLite/Postgres for querying, and virtualize views with TanStack Virtual.
- **Formula engine parity.** Write a dedicated parser and evaluator in `packages/database/formula` and test it against a fixture suite of Notion formulas.
- **Permissions on top of CRDT sync.** The server authorizes each subdocument on connect. Read-only clients have their updates rejected in the Hocuspocus `onChange` and auth hooks.
- **Fidelity of Notion imports.** Use real export samples as golden test fixtures.

## 7. Verification
- **Unit tests (Vitest):** block operations, Yjs merges, the formula engine, filters and sorts, importers and exporters.
- **E2E tests (Playwright `_electron`):** create a page, use each block type, use each database view, import a Notion zip, export to Markdown and PDF.
- **Sync tests:** two Electron instances against the docker-compose server, including offline edits, reconnection and convergence checks.
- **CI matrix:** ubuntu-24.04, plus later Ubuntu releases as they ship. Install the built `.deb` in a clean `ubuntu:24.04` container and run a smoke test under xvfb.
- **Manual QA:** go through the feature inventory in §3 against Notion side by side before each phase sign-off.

## 8. Phase 0 outcome

Delivered: the monorepo (pnpm + Turborepo) with CI on ubuntu-24.04, the Yjs data model in `packages/core`, SQLite persistence and the search index in `packages/storage-local`, the design system, a TipTap editor bound to Yjs, the sidebar page tree, and the Electron shell with a sandboxed preload API. Packaging produces a `.deb` and an AppImage. The exit criterion ("app launches, a page persists across restarts") is covered by an E2E test.

Changes from the original plan:
- **SQLite uses Electron's built-in `node:sqlite` instead of `better-sqlite3`.** It includes FTS5 and removes the native-module rebuild for each Electron version and CPU architecture.
- **Yjs updates are stored in SQLite (`doc_updates`) rather than y-leveldb.** That keeps one file per workspace, and the log is compacted on load.
- **Vite 7 and TypeScript 6.0** (not Vite 8 and TS 7), because electron-vite 5 and typescript-eslint don't support the newer versions yet.

## 9. First implementation steps (Phase 0, done)
1. Scaffold the monorepo (pnpm, Turborepo, TS configs, lint, CI workflow).
2. `packages/core`: the Block schema, Yjs bindings and ID generation, with unit tests.
3. `apps/desktop`: the Electron shell, the SQLite + Yjs persistence adapter and a preload IPC API.
4. `packages/editor`: a TipTap base with paragraph, heading, list and to-do blocks, plus the slash menu.
5. Sidebar page tree and page routing. Commit and push to `ccr-9cd9bc27-ksa6p1`.
