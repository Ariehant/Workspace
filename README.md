# Workspace

An offline-first replacement for Notion's core features (pages, rich text, databases, and later sync
and collaboration) that runs natively on Ubuntu 24.04 and later. Notion AI features are out of scope.

The roadmap and architecture are in [docs/PLAN.md](docs/PLAN.md). **Status:** Phase 0 (foundation) and
Phase 1 (editor and navigation, see [docs/PHASE1.md](docs/PHASE1.md)) are complete. Phase 2
(databases) is next.

## What works today

- Desktop app (Electron) with a page tree in the sidebar: create pages, drag to reorder or nest
  them, favorites, and a resizable sidebar. Trash: restore or delete permanently; pages are deleted
  automatically after 30 days.
- Quick find (`Ctrl+K` / `Ctrl+P`) over titles and content, with recent pages; `Ctrl+Enter` opens
  the result in a new window. Back and forward with `Alt+←`/`Alt+→` or the mouse's side buttons.
- `workspace://page/…` links to pages and blocks open in the app, including from other apps.
- Rich-text page editor (TipTap/ProseMirror):
  - `/` opens a filterable block menu: text, headings, to-do, bulleted/numbered and toggle lists,
    toggle headings, quote, divider, callout, table, code (syntax highlighting, language picker),
    block and inline equations (KaTeX), table of contents, breadcrumb, columns, link to page and
    new sub-page.
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
- Every block has a stable id, ready for block links, comments and sync later.
- Everything is saved locally as you type and survives restarts, including the last open page and
  which sidebar items are expanded.
- Several windows on the same workspace stay in sync live (File → New Window, `Ctrl+Shift+N`).
- Light, dark and system themes.
- Page icons (emoji or image) and covers (gradients, colors or images, repositionable).
- Page menu: font (default, serif, mono), small text, full width, lock, duplicate (with
  sub-pages), move to, copy link, word count.
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

| Command          | What it does                                                |
| ---------------- | ----------------------------------------------------------- |
| `pnpm dev`       | Run the desktop app in development mode                     |
| `pnpm build`     | Build all packages                                          |
| `pnpm typecheck` | Type-check every package                                    |
| `pnpm test`      | Unit tests (Vitest)                                         |
| `pnpm test:e2e`  | End-to-end tests driving the real Electron app (Playwright) |
| `pnpm lint`      | ESLint                                                      |
| `pnpm format`    | Prettier                                                    |
| `pnpm package`   | Build `.deb` and AppImage into `apps/desktop/dist/`         |

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

Back up the workspace by copying `workspace.db` and the `files/` folder while the app is closed. Set `WORKSPACE_DATA_DIR`
to use a different directory, for example to keep separate workspaces.

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
