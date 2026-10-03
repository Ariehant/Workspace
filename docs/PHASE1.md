# Phase 1: Editor MVP and navigation

**Status:** Phase 1 complete (M1–M6).

## Context

Phase 0 is merged into the branch `ccr-9cd9bc27-ksa6p1` (commits `583a744` and `AGENTS.md`). It delivered the monorepo, the Yjs data model, SQLite storage, the Electron shell and a basic TipTap editor. The overall roadmap is in `docs/PLAN.md`.

Phase 1 goal from the roadmap: **"Can replace Notion for personal notes."** That means:

- every text, list, media and layout block
- the slash menu, Markdown shortcuts and drag-and-drop for blocks
- inline formatting and mentions
- page icons and covers
- a full sidebar tree (drag to reorder or nest, favorites)
- a trash view
- quick find

Databases are Phase 2.

Phase 1 is large (4–6 weeks of work in the roadmap), so it is split into six milestones. Each milestone is committed and pushed on its own with tests.

## Reuse from Phase 0 (do not rebuild)

- `packages/core/src/workspace.ts`: `createPage`, `movePage` (already blocks cycles), `trashPage`, `restorePage`, `deletePagePermanently`, `setPageIcon`, `getAncestorIds`, `getDescendantIds`.
- `packages/core/src/tree.ts`: `buildPageTree` (handles orphans and cycles; `includeTrashed` is used by the trash view).
- `packages/core/src/blocks.ts`: `readBlocks` / `pageText`. Extend them to read the new `id` attribute and the text of new nodes such as callouts and toggles.
- `packages/storage-local/src/sqlite-store.ts`: `search()` (FTS5 prefix query plus snippet), the `pages` index, `migrate()` with `PRAGMA user_version`, settings.
- `DocManager` (`packages/storage-local/src/doc-manager.ts`) already drops page docs on permanent delete and re-indexes when content changes.
- IPC pattern in `apps/desktop/src/main/ipc.ts` (validate everything) and the `Platform` interface in `packages/app/src/platform.ts`. New host features go through `Platform`, so the future web build gets them for free.
- UI primitives in `packages/ui` (`Menu*`, `Button`, `IconButton`, tokens). Add `Popover` and `Dialog` (Radix) there.

## Architecture additions

**Block registry** (`packages/editor/src/blocks/registry.ts`). It is the single list of block kinds: `{ id, title, keywords, icon, group, insert(editor), turnInto?(editor) }`. The slash menu, the "Turn into" menu, the drag-handle menu and the Markdown shortcuts all read from it.

**Block IDs.** Add `@tiptap/extension-unique-id` (MIT) on all block nodes, as an `id` attribute stored in Yjs. These IDs are what later block links, synced blocks, comments and the API will use.

**File store.** Attachments are content-addressed under `<dataDir>/files/<sha256>.<ext>`:

- Main-process module `apps/desktop/src/main/files.ts`, with IPC `files:import` (bytes plus a name; returns `{ id, name, mime, size }`).
- A privileged custom protocol `ws-file://<id>` (`protocol.handle`), so the sandboxed renderer can show the files without file:// access.
- `Platform` gets `importFile(file: File)` and `fileUrl(id)`.
- Add a `files` table and a migration so permanent deletes and orphan cleanup can garbage-collect files later.

**Link unfurl.** IPC `links:unfurl(url)` runs in main and is used by bookmark blocks:

- http(s) only, 5 s timeout, 1 MB cap
- parses `og:`/`twitter:` meta tags and `<title>`
- caches results in a `link_previews` table

**CSP update** (`apps/desktop/electron.vite.config.ts`):

- `img-src`/`media-src` gain `ws-file:`
- `frame-src` is an allowlist for embeds (YouTube, Vimeo, Figma, Google Maps, CodePen, GitHub Gist)

**Page metadata additions.** New optional fields on the page Y.Map in `packages/core/src/schema.ts` and `workspace.ts`. Missing fields mean the default, so existing workspaces need no migration:

- `cover: { kind: 'color' | 'gradient' | 'file', value, positionY } | null`
- `fullWidth`, `smallText`, `font: 'default' | 'serif' | 'mono'`, `locked`

Setters follow the `setPageIcon` pattern, and the page index gains whichever columns search needs.

## Milestones

### M1: editor foundation ✅

- Block IDs, registry, and `packages/editor/src/slash-menu/` (built on `@tiptap/suggestion` plus `@floating-ui/react`): keyboard navigation, fuzzy match on title and keywords, groups, and "No results".
- Block handle (`@tiptap/extension-drag-handle-react`) with `⋮⋮` drag to move blocks and a `+` to insert below. Its menu has Delete, Duplicate, Turn into and "Copy link to block". Block color moves to M4.
- Multi-block selection (select a range, then Backspace, drag or turn-into across blocks).
- Selection bubble menu: bold, italic, underline, strike, code, link and "Turn into". Text/background color moves to M4 and inline equation to M2.
- Placeholder per block type ("Heading 1", "Type '/' for commands", "To-do").

### M2: text, list and layout blocks ✅

- Text and headings: text, H1–H3, toggle headings H1–H3.
- Lists: bulleted, numbered, to-do (`@tiptap/extension-list` TaskList).
- Basic blocks: toggle (`@tiptap/extension-details`), quote, divider, callout (custom node with an emoji and background color).
- Code block: lowlight with a language picker, a copy button and wrap toggle. Highlight.js is used rather than Shiki to keep the bundle size down.
- Equations: block and inline (`@tiptap/extension-mathematics`, KaTeX).
- Simple table (`@tiptap/extension-table`): header row and column toggles, add or remove rows and columns.
- Columns: a custom `columnList`/`column` pair. Dropping a block on the left or right edge of another creates columns, and widths are resizable.
- Table of contents (`@tiptap/extension-table-of-contents`), breadcrumb, and "Link to page" (a custom node holding a pageId that renders the live title and icon from the workspace doc).
- Markdown input rules for all of the above, including `[]` for a to-do, `>` and a space for a toggle, `"` for a quote, `---` for a divider and `$$` for an equation.

**M2 notes:**

- **Toggle state isn't saved in the document.** Open/closed is per window, like Notion, where each person folds toggles for themselves. TipTap's persisted mode also replaced every attribute on click, which would reset block IDs.
- **Inline equations use `$$x$$`,** which is both TipTap's and Notion's syntax. `$$` followed by a space on an empty line starts a block equation.
- **Highlight.js "common" languages and KaTeX are bundled eagerly.** The renderer bundle is about 1.5 MB, and lazy-loading moves to polish.
- **Columns:** dropping a block inside the left or right 15% of another block puts them side by side. Dropping in the gutter left of the text, where the drag handle is, still reorders. Drag the gap between columns to resize them.

### M3: media and files ✅

- Image: paste, drop, upload or URL. Resize handles, caption and alignment. Uses the file store.
- Video, audio, file and PDF blocks. PDFs use Chromium's built-in viewer in an `<iframe>` pointing at `ws-file://`.
- Web bookmark (link unfurl card), and embeds from the allowlist (an `<iframe sandbox>` with the needed permissions only).
- Pasting a URL offers a menu: Mention, Bookmark, Embed (when supported), or plain link.

**M3 notes:**

- **Attachments** are stored once per content hash in `~/.local/share/workspace-app/files/` and served to the sandboxed UI through the `ws-file://` protocol, which supports range requests for seeking in video and audio. PDFs open in Chromium's built-in viewer.
- **Embeds** come from an allowlist: YouTube (via youtube-nocookie), Vimeo, Loom, Figma, CodePen and Google Maps. The CSP `frame-src` is generated from the same list in `packages/editor/src/nodes/embeds.ts`. Unsupported links offer a bookmark instead.
- **Bookmark previews** are fetched in the main process (http(s) only, 6 s timeout, first 1 MB) and cached for 7 days.
- **Not done yet:** garbage collection of unreferenced files, and "download / save as" for file blocks (they open in the default app). Both are planned for Phase 3 with import and export.
- **Bug found:** passing a new `computePositionConfig` object to the React `DragHandle` on each render re-registered its plugin. Re-registering any plugin makes the Yjs binding re-render the document, which reverted unsynced edits. It's now a constant, and the paste-as-bookmark E2E test guards against regressions.

### M4: inline content ✅

- `@` mentions (`@tiptap/extension-mention`): pages (searching the workspace doc) and dates ("today", "tomorrow", "next Friday", ISO dates). Each renders as a live chip. Person mentions come with accounts in Phase 5.
- Reminders on date mentions are stored now and fire through a main-process timer with an Electron `Notification`.
- `:` emoji autocomplete (`@tiptap/extension-emoji`) and Notion's ten text and background colors as CSS tokens in both themes.
- Rich copy and paste: paste Markdown as blocks (`@tiptap/markdown`), and copy as HTML plus Markdown.
- Find and replace in a page (`prosemirror-search`, Ctrl+F) and word count.

**M4 notes:**

- **`@` mentions** cover pages (live title, click to open) and dates in natural language: "today", "next fri", "in 2 weeks", "oct 5". Person mentions arrive with accounts in Phase 5.
- **Reminders** (`@remind tomorrow`) notify at 09:00 local through the main process. Ones missed while the app was closed fire on the next start. A reminder is identified by its block and time, so editing the sentence never notifies twice.
- **Colors** use Notion's 9 colors, for text or background, on text spans and whole blocks. They're stored by name so each theme renders them, and callouts use the same palette.
- **Markdown:** pasting Markdown, including VS Code's style-only HTML, becomes blocks, and copying puts Markdown in the plain-text clipboard.
- **Find and replace** opens with Ctrl+F, with a case toggle, replace one or all, and a match count.
- **Moved to M5:** word count, shown in the page "…" menu.
- **Bundle size:** the renderer is now about 2.1 MB with the emoji data and the Markdown parser. Lazy-loading the emoji list, KaTeX and highlight.js is planned for polish.
- **Bug found:** Suggestion v3 resolves items asynchronously and first reports `loading` with an empty list. The early-exit rules now ignore that state; they had been closing `:emoji` and `@in 2 weeks` while typing.

### M5: page chrome ✅

- Icon picker (Radix Popover). Emoji grid from `emojibase-data`, with search, recent emoji and a random button, plus "Upload image" through the file store. Hovering the page shows "Add icon" and "Add cover".
- Covers: a gallery of solid colors and gradients, or an uploaded image. "Reposition" drags the vertical position, and "Remove" clears it.
- Page "…" menu: full width, small text, font (Default, Serif, Mono), lock page (makes the editor and title read-only), word count (moved from M4), duplicate, move to, and move to trash.
- **Duplicate** copies the page doc state into a new doc, reassigns block IDs, and copies sub-pages recursively.
- **Move to** opens a page picker dialog that calls `movePage`.

**M5 notes:**

- **Icons** are an emoji or an uploaded image, stored as `file:<id>` in the same field. One `PageIcon` component renders them everywhere: sidebar, breadcrumbs, links, mentions and pickers.
- **Covers** are stored as `{ kind: color | gradient | file, value, positionY }`. Gradients and colors render in both themes. "Add cover" picks a random gradient and "Add icon" a random emoji, as in Notion.
- **Page options** (font, small text, full width, lock) live in the shared workspace doc, so later collaborators see the same page style. Missing fields default, so older workspaces need no migration.
- **Duplicate** copies the page tree and content, gives the copies fresh block IDs, and points links between the copied pages at the copies. The copy is titled "<title> (1)".
- **Not done yet:** recent emoji in the picker, and the Unsplash gallery. Unsplash needs network access and an API key, so it's left out of an offline-first app for now.

### M6: navigation ✅

- Sidebar drag-and-drop: reorder, nest by dropping onto a page, and un-nest. It calls `movePage` with an index. Pages also auto-expand while dragging over them.
- Favorites section (per-user list in settings), a "Recent" list (stored in settings) and a resizable sidebar width.
- Trash popover:
  - lists the pages put in the trash, with filter-as-you-type
  - restore, and delete permanently with a confirm dialog
  - pages older than 30 days are deleted automatically at startup
- Quick find (Ctrl+K and Ctrl+P):
  - a dialog backed by `Platform.search`, which wraps the existing IPC `search:query`
  - an empty query shows recent pages; results show the breadcrumb path and the snippet with the matching words highlighted
  - Enter opens the page, Ctrl+Enter opens it in a new window
- Back and forward history (Alt+Left/Right, mouse buttons) and `workspace://page/<id>` deep links registered via the `.desktop` MimeType.

**M6 notes:**

- **Drag and drop** uses native HTML5 drag events rather than `@dnd-kit/core`: the tree is small, rows already handle the pointer, and it saves a dependency. A drop on a row's top or bottom quarter goes before or after it; the middle nests. `resolveDrop` (in `@workspace/core`, unit tested) turns a drop into `{ parentId, index }` and refuses drops into a page's own sub-pages. Dropping below the tree moves a page to the end of the top level.
- **Quick find** shows title matches straight away, then adds content matches from the full-text index. It excludes trashed pages.
- **History** is per window and kept in memory (`pushHistory`/`stepHistory` in core). Going back skips pages that have since been deleted.
- **Links:** `workspace://page/<id>#<blockId>` links open in the app from anywhere: a link in a page, "Copy link" or "Copy link to block", another app, or the desktop (a second launch hands the link to the running app). A link to a block scrolls to it and flashes it. In a locked or trashed page, a plain click opens a link.
- **The Go menu** lists Search, Back and Forward. The renderer handles the shortcuts itself so they work in the web build too.

## Critical files

- **New:**
  - `packages/editor/src/{blocks/*, slash-menu/*, bubble-menu.tsx, block-handle.tsx, extensions/*}`
  - `packages/app/src/{quick-find.tsx, trash.tsx, icon-picker.tsx, cover.tsx, page-menu.tsx}`
  - `apps/desktop/src/main/{files.ts, links.ts, reminders.ts}`
- **Modified:**
  - `packages/core/src/{schema.ts, workspace.ts, blocks.ts}`
  - `packages/storage-local/src/sqlite-store.ts` (migration 2)
  - `packages/editor/src/page-editor.tsx` and `editor.css`
  - `packages/app/src/{app.tsx, sidebar.tsx, page-view.tsx, platform.ts}`
  - `apps/desktop/src/{main/ipc.ts, preload/index.ts, renderer/main.tsx}`
  - `electron.vite.config.ts` (CSP)
  - `electron-builder.yml` (MIME and URL handler)

## Verification

- **Unit tests (Vitest):**
  - block registry completeness (every block has an insert path)
  - `readBlocks`/`pageText` for every new node type, including IDs
  - new page metadata setters and defaults on old docs
  - duplicate-page doc copy
  - file store hashing and deduplication
  - unfurl parser against HTML fixtures
  - SQLite migration 1→2 on a Phase 0 database fixture
- **E2E (Playwright, `apps/desktop/e2e/`), one spec per milestone:**
  - insert every block through the slash menu and through its Markdown shortcut, then restart and check each one round-trips
  - drag a block and create columns
  - paste an image, restart, and check the image still loads from `ws-file://`
  - set an icon and a cover, restart, and check they persist
  - sidebar drag-and-drop nesting
  - trash: restore and permanent delete
  - quick find for a word in a page body
  - an `@` page mention updates when the target page is renamed
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `xvfb-run -a pnpm test:e2e` before every push. CI on the PR must be green.
- Check every milestone by eye with screenshots in light and dark themes, and keep the renderer bundle size in check (lazy-load KaTeX, lowlight languages and emoji data).
- At the end of the phase, rebuild the `.deb`, install it in Ubuntu 24.04, smoke-test it, and walk through the Phase 1 rows of the `docs/PLAN.md` §3 feature inventory.
