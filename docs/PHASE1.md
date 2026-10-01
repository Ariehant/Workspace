# Phase 1: Editor MVP and navigation

**Status:** M1 and M2 done. M3–M6 to do.

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

### M3: media and files

- Image: paste, drop, upload or URL. Resize handles, caption and alignment. Uses the file store.
- Video, audio, file and PDF blocks. PDFs use Chromium's built-in viewer in an `<iframe>` pointing at `ws-file://`.
- Web bookmark (link unfurl card), and embeds from the allowlist (an `<iframe sandbox>` with the needed permissions only).
- Pasting a URL offers a menu: Mention, Bookmark, Embed (when supported), or plain link.

### M4: inline content

- `@` mentions (`@tiptap/extension-mention`): pages (searching the workspace doc) and dates ("today", "tomorrow", "next Friday", ISO dates). Each renders as a live chip. Person mentions come with accounts in Phase 5.
- Reminders on date mentions are stored now and fire through a main-process timer with an Electron `Notification`.
- `:` emoji autocomplete (`@tiptap/extension-emoji`) and Notion's ten text and background colors as CSS tokens in both themes.
- Rich copy and paste: paste Markdown as blocks (`@tiptap/markdown`), and copy as HTML plus Markdown.
- Find and replace in a page (`prosemirror-search`, Ctrl+F) and word count.

### M5: page chrome

- Icon picker (Radix Popover). Emoji grid from `emojibase-data`, with search, recent emoji and a random button, plus "Upload image" through the file store. Hovering the page shows "Add icon" and "Add cover".
- Covers: a gallery of solid colors and gradients, or an uploaded image. "Reposition" drags the vertical position, and "Remove" clears it.
- Page "…" menu: full width, small text, font (Default, Serif, Mono), lock page (makes the editor and title read-only), word count, duplicate, move to, and move to trash.
- **Duplicate** copies the page doc state into a new doc, reassigns block IDs, and copies sub-pages recursively.
- **Move to** opens a page picker dialog that calls `movePage`.

### M6: navigation

- Sidebar drag-and-drop (`@dnd-kit/core`): reorder, nest by dropping onto a page, and un-nest. It calls `movePage` with an index. Pages also auto-expand while dragging over them.
- Favorites section (per-user list in settings), a "Recent" list (stored in settings) and a resizable sidebar width.
- Trash popover:
  - lists `buildPageTree(..., { includeTrashed: true })` roots where `trashedAt` is set, with filter-as-you-type
  - restore, and delete permanently with a confirm dialog
  - pages older than 30 days are deleted automatically at startup
- Quick find (Ctrl+K and Ctrl+P):
  - a dialog backed by `Platform.search`, a new method that wraps IPC `search:query`, which is already implemented
  - an empty query shows recent pages; results show the breadcrumb path and the snippet with the matching words highlighted
  - Enter opens the page, Ctrl+Enter opens it in a new window
- Back and forward history (Alt+Left/Right, mouse buttons) and `workspace://page/<id>` deep links registered via the `.desktop` MimeType.

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
