# Workspace Write: build plan (handoff)

This document is written to be given, whole, to an AI coding assistant (or a developer) who will
build the app in a new repository. It's self-contained: everything needed about Workspace is
here.

---

## Prompt

> You are building **Workspace Write**, a desktop document editor (Electron, for Linux and
> Windows). Its interface follows the familiar layout of online word processors (a menu bar, a
> toolbar, pages on a canvas, comments and suggestions), and it adds themes, card layouts,
> presentations and a template system in the spirit of Gamma. It's **local-first**: documents
> live on the user's computer and everything works offline. Build it in versions, in order:
> **v1.0** is the editor, the card and presentation view, templates and local storage, with no
> AI; **v1.1** adds an optional connection to a Workspace server through its API; **v2.0** adds
> AI. The v2.0 section is a specification for later: don't build any AI in v1. Follow the spec
> below exactly where it states facts about Workspace's API. Finish each version, with its tests
> passing and the app packaged, before starting the next. Ask the owner for anything listed
> under "What to ask the owner" when you reach it.

---

## 1. The product

**What it is:** a fast, offline-first writing app. It can be used for letters, reports,
resumes and proposals, and the same document can be shown as cards or presented as slides.

**Name and branding:** "Workspace Write" is a working name; the owner may rename it.

- Don't use Google's or Gamma's names, logos, icons, illustrations or colour schemes anywhere in
  the app, its website or its packaging.
- The layout is familiar, in the way word processors resemble each other, but the look (icons,
  colours, typography) is its own.
- License: AGPL-3.0, the same as Workspace.

**Targets:**

- under 200 MB of memory with one 20-page document open;
- a cold start to the last document in under 2 seconds;
- typing that stays under 16 ms a keystroke on a 100-page document.

## 2. v1.0: the editor

### 2.1 Window and chrome

- **Title row:** the document's name (click to rename), a star (favourite), and its save state
  ("Saved on this computer").
- **Menu bar:**
  - **File:** New, Open, Make a copy, Import, Export, Page setup, Print, Version history,
    Properties.
  - **Edit:** Undo, Redo, Cut, Copy, Paste, Paste without formatting, Find and replace.
  - **View:** Print layout or Pageless, Show ruler, Show outline, Card view, Present,
    Full screen.
  - **Insert:** Image, Table, Drawing (shapes and lines, optional), Horizontal line, Page break,
    Section break, Header, Footer, Page numbers, Footnote, Equation, Table of contents, Link,
    Bookmark, Special characters.
  - **Format:** Text, Paragraph styles, Align and indent, Line spacing, Columns, Bullets and
    numbering, Clear formatting.
  - **Tools:** Word count, Spelling, Preferences.
  - **Help:** Keyboard shortcuts, About.
- **Toolbar:**
  - Undo, Redo, Print, Zoom.
  - The style picker, Font, Size.
  - Bold, Italic, Underline, Text colour, Highlight.
  - Link, Comment, Image.
  - Align, Line spacing, Checklist, Bullets, Numbering, Indent.
  - Clear formatting.
  - The mode switcher: Editing, Suggesting, Viewing.
- **Canvas:**
  - Pages at the chosen size (A4, Letter, Legal, custom) and orientation, with margins, zoom from
    50% to 200%, and rulers with draggable margins and indents.
  - **Pageless mode:** one continuous page, with a width setting.
- **Outline sidebar:** headings, click to jump, collapsible.
- **Status bar:** word count (and the selection's), the page number and the zoom.
- **Keyboard:** the shortcuts people know from common word processors (Ctrl+B/I/U,
  Ctrl+Alt+1–6 for headings, Ctrl+Shift+7/8 for lists, Ctrl+K for links, Ctrl+Alt+M for a comment,
  Ctrl+/ for the list of shortcuts).

### 2.2 Content

- **Paragraph styles:** Normal text, Title, Subtitle, Heading 1–6.
  - Each has font, size, weight, colour, spacing before and after, and line spacing.
  - "Update Heading 1 to match" and "Save as my default styles", per document and as user
    defaults.
- **Text:** any installed font (plus a bundled set of open fonts), size, bold, italic,
  underline, strikethrough, superscript and subscript, text colour, highlight, and links.
- **Paragraphs:** alignment, indents (first line and hanging), line spacing, spacing
  before and after, keep with next, and page break before.
- **Lists:** bullets, numbers (with custom formats, restart and continue), checklists, and
  nesting.
- **Tables:**
  - insert, resize columns, merge cells, cell colour and borders, and header rows that repeat on
    each page;
  - rows split across pages.
- **Images:** insert (file, paste, drop), resize, crop, alt text, and wrapping (inline, wrap
  text, break text, behind or in front of text).
- **Breaks and layout:** page breaks, and section breaks (with their own orientation, margins
  and columns); columns (1–3).
- **Headers and footers:** a different first page, different odd and even pages, page numbers
  with formats.
- **Notes and references:** footnotes, numbered per document; a table of contents (with or
  without page numbers, updates on demand); bookmarks and internal links.
- **Equations:** LaTeX input, rendered (KaTeX).
- **Special characters:** a picker with search.

### 2.3 Review

- **Comments:**
  - on selected text, with threads, resolve and re-open, and an "All comments" panel;
  - the comment author is the local user's display name (set at first run).
- **Suggestion mode:**
  - edits become tracked insertions and deletions, with author and time;
  - accept or reject each one, or all of them.
- **Viewing mode:** read-only.

### 2.4 History

- Automatic snapshots: every few minutes while editing, and on close.
- **Named versions:** "Name current version".
- **Version history panel:** a timeline; select a version to see it, with changes highlighted;
  "Restore this version" (which itself is undoable); "Make a copy".

### 2.5 Files

- **Own format:** `.wwrite`, a zip of the Yjs document state, the assets (images, fonts it
  embeds) and a `manifest.json` (format version, title, created and modified dates).
  - It's registered with the operating system: double-click to open, "Open with".
- **Import:**
  - `.docx` (including Google Docs' File → Download → Word), `.odt`, `.html`, `.md`, `.txt`;
  - styles, lists, tables, images, headers and footers, footnotes and comments where the format
    has them.
- **Export:** `.docx`, `.odt`, `.pdf`, `.html`, `.md`, `.txt`, and `.wwrite`.
- **Print:** the system dialog, matching the print layout exactly.
- **Round trips:** opening an exported `.docx` in another word processor and back keeps text,
  styles, lists, tables, images and page setup. The tests check this (section 9).

## 3. v1.0: themes, cards and presenting (no AI)

- **Themes:**
  - a theme sets fonts (heading and body), a colour palette (background, text, accent, two more),
    spacing, the corner radius and card style;
  - built-in themes (8–12, original designs), a theme editor, and import and export of themes;
  - applying a theme updates the paragraph styles.
- **Card view (View → Card view):**
  - the same document shown as cards: each Heading 1 starts a new card;
  - **card layouts:** text only; image left or right; image on top; two or three columns; a
    full-bleed image with a text overlay; title card;
  - choosing a layout is per card and stored in the document;
  - cards can be reordered by dragging, which moves the sections in the document.
- **Present (View → Present):**
  - full-screen slides from the cards, with arrow keys, a progress bar, and Esc to exit;
  - presenter notes from a "Notes" block in each card, shown on a second screen if there is one.
- **Export:** a PDF with one card per page (16:9), and `.pptx` (a stretch goal: text, images and
  layout positions; themes as fonts and colours).

## 4. v1.0: templates

A template is a `.wwrite` file with a `template` flag, placeholder blocks and a preview image.

- **Template gallery:** opened from File → New → From template, or on the start screen.
  - **Built-in templates,** original designs: resume (2), cover letter, letter, report, meeting
    notes, project proposal, essay, newsletter, and three card decks (pitch, lesson, project
    update).
  - **Downloadable packs** from a template index: a JSON feed at a URL set in Preferences, empty
    by default, so the owner can host a gallery later.
    - The feed lists packs with a name, description, preview images, size, version and a
      SHA-256 of the pack file.
    - Downloads are checked against the SHA-256 and kept in the user-data folder.
    - The feed format goes in `docs/template-feed.md` with a JSON Schema.
- **Templates from files:** import a `.docx`, `.odt`, `.html` or `.md` (or a Google Docs export as
  `.docx`) as a template.
  - Its styles, theme (fonts and colours), page setup and structure are kept.
  - Optionally ("Replace text with placeholders"), each paragraph's text becomes placeholder text
    of a similar length, and images become image placeholders.
- **Templates from a web page's layout:** the user pastes a URL; the main process fetches the
  page with a normal browser user agent, without running its scripts, and reads:
  - the heading hierarchy and section structure;
  - the colour palette (the most used text, background and accent colours from the CSS);
  - the font families (mapped to the nearest bundled or installed font);
  - rough proportions (a hero section, columns, a card grid).

  From that it makes a template skeleton, with **placeholder text and image placeholders only**:
  - It never copies the page's text, images, logos, icons or trademarks.
  - It checks `robots.txt` and stops if fetching is disallowed.
  - Before saving it shows a preview and asks the user to confirm they're allowed to use the
    design.
  - Pages that need JavaScript to show their content give a clear "couldn't read this page's
    layout" message; v1 doesn't run a headless browser.

- **Custom templates:**
  - File → Save as template, from any document;
  - a template editor: mark blocks as placeholders (with hint text such as "Your name"), set the
    theme, styles and card layouts, and add a preview image (generated from the first page);
  - templates are listed under "My templates", and can be renamed, duplicated, deleted,
    exported and imported as `.wwrite` files.

## 5. v1.0: local-first

- **Storage:** each document is a Yjs document, stored in SQLite (better-sqlite3) in the user-data
  folder, with the assets beside it.
  - Saving is automatic and continuous (incremental Yjs updates), with no Save button.
  - The title row shows "Saved on this computer".
- **Offline:** everything in v1 works without a network. Only the template feed and web-page
  layout import use one, and they say so when offline.
- **History:** snapshots for version history (section 2.4), pruned on a schedule: everything
  for 7 days, then daily for 30 days, then weekly. Named versions are kept forever.
- **Backups:** a backup folder (default in the user's Documents), written daily and on demand.
  Each backup is a `.wwrite` per document, keeping the last N.
- **Crash recovery:** the next start reopens documents at their last update.
- **Start screen:** recent documents (with previews), the template gallery, search, and
  Open file.
- **Search:** full-text search across all documents (SQLite FTS5), from the start screen and
  Ctrl+O.
- **Multiple windows:** one document per window; opening one that's already open focuses it.

## 6. v1.1: the Workspace connection (optional)

Workspace is a self-hosted, Notion-style app for notes and databases. Its server has a REST API in
the shape of Notion's. This version lets a document be sent to a Workspace page, or opened from
one. It's off until the user sets it up.

### 6.1 Workspace's API, as far as this app needs it

- **Base:** the API is at `<server>/v1`.
- **Every request** carries:
  - `Authorization: Bearer ntn_…`, an integration token;
  - `Notion-Version: 2022-06-28`;
  - `Content-Type: application/json` for JSON bodies.
- **The token:**
  - The user makes an integration in Workspace (Members → Integrations, owners and admins only)
    and copies its token, which is shown once.
  - They connect the pages it may use: a page's Share → Connections, which covers the pages
    under it.
  - The integration needs the capabilities to read, update and insert content.
- **Limits:**
  - 3 requests a second on average, in bursts of up to 30, then `429` with `Retry-After`;
  - 500 KB per request;
  - results in pages of up to 100 (`start_cursor`, `page_size`, `has_more`, `next_cursor`).
- **Errors:** `{ "object": "error", "status", "code", "message" }`, with Notion's codes. Show
  the message for `unauthorized`, `restricted_resource` and `object_not_found`.
- **Find pages:** `POST /v1/search` with `{ "query": "…", "filter": { "property": "object",
"value": "page" } }`.
- **A page's content as Markdown** (Workspace's own endpoint):
  - `GET /v1/pages/{id}/markdown` answers `{ "object": "page_markdown", "id", "markdown" }`.
  - `PATCH /v1/pages/{id}/markdown` with `{ "markdown": "…", "mode": "replace" }` replaces the
    page's content (`"append"`, the default, adds to it). It answers with the new Markdown.
  - Up to 200,000 characters per request.
  - The Markdown supports headings, lists, to-dos, quotes, code, tables, links, bold and italic.
- **Create a page:** `POST /v1/pages` with
  `{ "parent": { "page_id": "…" }, "properties": { "title": { "title": [{ "text": { "content": "Title" } }] } } }`.
  Then fill it with `PATCH …/markdown`.
- **Images:** the Markdown endpoint carries text only. Images go in as image blocks, in three
  steps:
  1. `POST /v1/file_uploads` with `{ "filename", "content_type" }`.
  2. Send the file as `multipart/form-data` (the part `file`, up to 20 MB) to the returned
     `upload_url` within an hour.
  3. Add an image block that uses it: `PATCH /v1/blocks/{page_id}/children` with
     `{ "children": [{ "type": "image", "image": { "type": "file_upload", "file_upload": { "id": "…" } } }], "after": "{block_id}" }`.

     Find the block to put it after with `GET /v1/blocks/{page_id}/children` once the text is in:
     the block whose text precedes the image in the document.

  If that's too much for v1.1, leave images out and say so in the "what doesn't carry" notice.

### 6.2 What the app does

- **Settings → Workspace:** the server address and token. "Test" calls `POST /v1/search` with an
  empty query. The token is stored with Electron's `safeStorage`.
- **File → Send to Workspace:**
  - The user picks a parent page (search) or an existing page to replace.
  - The app converts the document to Markdown (its own exporter) and creates or replaces the page.
  - It remembers the link (page id), so sending again updates the same page.
  - **Before sending,** it shows what Markdown can't carry: layout, themes, card layouts,
    comments, suggestions, headers and footers, page setup and colours.
- **File → Open from Workspace:** search, pick a page, and import its Markdown as a new document,
  with a link back.
- **No sync:** these are one-way copies at the moment of sending or opening.

## 7. v2.0: AI (the next version, specified here, not built in v1)

Everything in this section is for v2.0. v1 has no AI code, settings or menus. The design goal:
the user chooses which model does what, and nothing leaves the computer without them knowing.

### 7.1 Providers

- **A provider layer** (main process) with one interface for chat and completion, streaming,
  and image generation where the provider has it.
- **Bring your own key:** Anthropic (Claude), OpenAI, Google (Gemini), Mistral and OpenRouter.
  - Keys are entered in Settings → AI and kept with `safeStorage`.
  - "Test" makes a tiny request.
- **Local models:** any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp server), with
  its address and model name.
- **Signing in instead of a key,** where a provider offers an OAuth flow for apps (for example
  OpenRouter's PKCE flow):
  - the system browser opens, and the answer returns to a loopback address;
  - most model APIs only accept keys, so sign-in is offered only where the provider supports it.
- **Model per feature:** a table in Settings mapping features (writing, rewriting, deck
  generation, chat, images) to a provider and model, with a default.
- **Privacy:**
  - each AI action shows which provider gets which text;
  - a "local models only" switch;
  - nothing is sent in the background;
  - prompts and answers are logged only if the user turns logging on.
- **Usage:** tokens and an estimated cost per request (from the provider's reported usage), with
  a monthly summary.

### 7.2 Features

Each of these needs its own short spec before it's built: inputs, output, the undo behaviour,
an acceptance check, and a privacy note.

- **Generate from a prompt or an outline (Gamma-style):** a document or a card deck, with
  headings, sections, card layouts and a theme. It streams into a new document and can be
  stopped.
- **Write with selection:** rewrite, shorten, expand, change tone, fix spelling and grammar,
  translate, summarize, turn into a list or a table. The result shows as a suggestion (section
  2.3) to accept or reject.
- **Continue writing** from the cursor.
- **Chat with the document:** a side panel that answers questions about it and can insert its
  answers.
- **Layout and theme suggestions:** for a card, its best layout; for a document, a theme.
- **Template from a description:** "a one-page resume for a robotics engineer" becomes a
  template.
- **Images:** generate an image from a prompt (providers that support it), or search for one,
  with a stock photo API key the user adds.
- **Alt text** for images.
- **Smart tables:** fill or extend a table from text.

## 8. Architecture

- **Stack:**
  - Electron, React, TypeScript (strict), Vite (electron-vite);
  - TipTap 3 on ProseMirror, with Yjs for the document model (also the base of history and
    future collaboration);
  - better-sqlite3;
  - packaged with electron-builder: AppImage and `.deb` for Linux, NSIS for Windows.
- **Processes:**
  - **Main:** files, SQLite, the network (template feed, web layout import, Workspace API, and
    later AI), and secrets.
  - **Renderer:** the UI only, behind a typed IPC bridge (`contextBridge`,
    `contextIsolation: true`, sandboxed, no `nodeIntegration`), with a strict Content Security
    Policy.
- **Pagination** (the riskiest part: do a spike first, in week one):
  - A layout pass measures the rendered blocks and places them on fixed-size pages, with page
    breaks, keep-with-next, splitting a paragraph across pages at line boundaries, and table rows
    across pages with repeated headers.
  - Headers, footers and footnotes are laid out per page.
  - It runs incrementally (only pages after an edit), off the typing path.
  - Pageless mode skips it.
- **Converters:**
  - `.docx`: read with a zip and XML parser into ProseMirror JSON, and write with the `docx`
    library;
  - `.odt` likewise;
  - PDF through Electron's `printToPDF` from the print layout;
  - Markdown and HTML through ProseMirror serializers.
- **Fonts:** a bundled set of open fonts (for example Inter, Source Serif, JetBrains Mono, Noto
  for wide script coverage including Devanagari), plus the system's.
- **Spell check:** Electron's built-in Hunspell, with language choice in Preferences.
- **Logs:** a rotating log file, without document text.

## 9. Tests and "done when"

- **Unit (Vitest):**
  - the document model;
  - styles;
  - pagination: page counts for fixtures, breaks, keep-with-next, tables across pages;
  - each importer and exporter, with round trips (`.docx` → document → `.docx`, compared on text,
    styles, lists, tables, images and page setup);
  - the template extractor, on saved HTML fixtures (the structure, palette and fonts found, and no
    text from the page in the result);
  - the template feed's checksum checks.
- **End-to-end (Playwright with Electron, under `xvfb-run` in CI):**
  - create a document from a template, type, style, insert a table and an image;
  - add a comment and a suggestion, then accept it;
  - name a version and restore it;
  - export `.docx` and PDF;
  - switch to card view, change a card's layout, and present;
  - restart and find everything there.
  - For v1.1: send to and open from a mock Workspace `/v1` server that follows section 6.1.
- **Performance:** a 100-page fixture; typing latency and memory are measured in CI and compared
  with the targets in section 1.
- **CI (GitHub Actions):** lint (ESLint, Prettier), typecheck, unit tests, end-to-end tests and
  packaging (Linux on Ubuntu, Windows on a Windows runner).
- **v1.0 is done when** all of sections 2–5 work offline, the tests pass, and the AppImage,
  `.deb` and Windows installer build and start.
- **v1.1 is done when** sending and opening round-trip with a real Workspace server. To get one:

  ```sh
  git clone https://github.com/Ariehant/Workspace.git
  cd Workspace/infra
  cp .env.example .env     # set DOMAIN=localhost and POSTGRES_PASSWORD
  docker compose up -d --build
  ```

  Sign up in the browser (the first account is the admin), make an integration in Members →
  Integrations, and connect a page to it.

## 10. Not in v1

- **Collaboration:** real-time editing with other people. It would come later through a server;
  the Yjs model keeps that door open.
- **Platforms:** mobile and macOS builds.
- **AI:** every AI feature (section 7, v2.0).
- **Marketplace:** a hosted template marketplace with accounts and payments. The feed in
  section 4 is the hook for it.
- **Scripts:** add-ons and scripting.

## 11. What to ask the owner

- **Before starting:** the final name and the app icon.
- **For the template gallery:** where the template feed will be hosted (it can stay empty for
  v1.0).
- **For v1.1:** a Workspace server address and an integration token for testing, or use the
  Docker Compose recipe in section 9.
- **For v2.0:** which providers to support first, and whether to ship a default local-model
  setup.
- **Before release:** where releases are published.
