# Phase 5: Collaboration

**Status:** planned. M1 (members, invites and groups) is next.

## Context

Phases 0–4 are complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE4.md](PHASE4.md) for the sync server). One Phase 3 check is still open: running the importer on a real Notion export.

Phase 5 goal from the roadmap ([PLAN.md](PLAN.md) §4): **"Several users co-edit with the correct permission checks."** The roadmap's scope for this phase, from the feature list (§3, "Collaboration"):

- workspaces, members, groups and guests
- sharing per page and per teamspace (full access, can edit, can comment, can view), inherited down the page tree
- private pages and teamspaces in the sidebar
- real-time co-editing, live cursors and presence avatars
- comments and discussions, inline and on the page, with resolve; suggested edits
- an inbox with notifications for mentions, comments and reminders, and desktop notifications
- publish to web as a public read-only site, with page analytics
- server-side backlinks and page history, so the web app has them too (moved here from Phase 4)

The roadmap budgets 5–6 weeks. There are seven milestones, each committed and pushed on its own with tests. The estimate below comes to about 6.5 weeks. If time runs short, suggested edits and custom domains for published sites are the parts to cut.

**Already in place (reused, not rebuilt):**

- **Accounts and sign-in** (Phase 4 M2): passwords, OIDC, sessions, the sign-up policy (open, invite-only, off), and `workspace_members` with one owner per workspace.
- **The sync protocol** (Phase 4 M3): one update log per workspace, replicated over one socket. Desktops hold every doc (`replica` mode); the web app opens only the docs it shows (`partial` mode).
- **Live co-editing already works:** two people on the same page are two devices on the same log, and Yjs merges their edits. Phase 5 adds who-is-where (presence and cursors), not the merging.
- **Log followers on the server:** the search indexer (Phase 4 M5) follows each workspace's log with its own cursor and reads merged doc states. Backlinks, history snapshots and notifications follow the log the same way.
- **The HTML exporter** (Phase 3 M5) renders pages and databases to static HTML. Publish to web reuses it.
- **Page history and backlinks on the desktop** (Phase 3 M2), computed from local docs.
- **Read-only pages:** locked pages (Phase 1) already switch the editor, the page chrome and database views to read-only. The view and comment roles use the same path.
- **`Platform.features`** (Phase 4 M6): the UI hides what a host doesn't support. Sharing, members and the inbox are features a local-only desktop workspace doesn't have.

**Not in Phase 5:**

| Item                                                             | Goes to                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Automations, forms, webhooks, the public API, integration tokens | Phase 6                                                                   |
| Email notification digests beyond invites                        | Phase 6, with the job queue                                               |
| Per-row permissions inside a database                            | Not planned: rows inherit their database's access, as in Notion's default |
| SAML, SCIM and audit logs                                        | Not planned for v1                                                        |
| Server-side export and PDF for the web app                       | Phase 7                                                                   |

## Architecture

### The problem: one tree doc holds every title

Today the **workspace doc** holds the metadata of every page (title, icon, parent, position), and a desktop replicates every doc in the workspace. That's right for one user, but it would show every private page's title to every member. Yjs docs can't be filtered by content, so whatever a person may not see must live in a doc they never receive.

### Scopes: access is decided per doc, by the server

- **A scope** is a set of pages that share the same access. Kinds:
  - a teamspace
  - one member's private section
  - a shared page: a page whose access differs from its parent's, together with its sub-pages
- **Each scope has a tree doc** (`tree:<scopeId>`) with the metadata of its pages, in the same layout the workspace doc has now. The sidebar shows the union of the tree docs the user can read.
- **The existing workspace doc stays** as the tree doc of the workspace's first scope. Existing workspaces need no data migration.
- **Every doc is placed in exactly one scope**, and the server keeps that placement in Postgres (`doc_scopes`):
  - a page's content doc, or a database doc, is placed in the scope of its page
  - row docs are placed in their database's scope
  - comments docs (`comments:<pageId>`) are placed with their page
- **Access is server-side data, never Yjs content:**
  - `scopes(id, workspace_id, kind, name, parent_scope_id, inherit)`
  - `scope_access(scope_id, principal, role)`, where a principal is a user, a group or "everyone in the workspace"
  - A scope that inherits gets its parent scope's access plus its own entries.
  - A member who can edit a tree doc still can't grant themselves anything: listing someone else's page in their tree only shows a stub they can't open.
- **Roles**, from most to least access. Each is enforced per doc on every message:

  | Role                              | Read docs | Write comments doc | Write rows | Write page, database and tree docs | Manage sharing |
  | --------------------------------- | --------- | ------------------ | ---------- | ---------------------------------- | -------------- |
  | Full access                       | ✓         | ✓                  | ✓          | ✓                                  | ✓              |
  | Can edit                          | ✓         | ✓                  | ✓          | ✓                                  |                |
  | Can edit content (databases only) | ✓         | ✓                  | ✓          |                                    |                |
  | Can comment                       | ✓         | ✓                  |            |                                    |                |
  | Can view                          | ✓         |                    |            |                                    |                |

  Rows live in their database doc and their own page docs, so "can edit content" is enforced at the doc level: row docs are writable and the database doc (schema and views) is not. The catch is that row titles and cells are in the database doc. "Can edit content" therefore needs the database doc split into a schema part and a rows part (`rows:<dbId>`), done in M2 with a migration that moves the `rows` map.

- **Workspace roles:** owner, admin, member and guest.
  - Owners and admins manage members, groups, teamspaces and workspace settings.
  - Like Notion, they can't read other members' private pages.
  - Guests belong to no teamspace and only reach the pages shared with them.

### Moving pages between scopes

- **Sharing a page** with someone who can't already see it turns the page into its own scope:
  - The server creates the scope, moves the page's subtree from the parent tree doc to the new tree doc, and re-places its docs.
  - The parent tree keeps a stub (`{id, scope, parentId, sortKey}`). Members of the parent see the page in place; people who only have the new scope see it under "Shared".
- **Moving a page to another teamspace or to Private** is the same server operation. It needs a connection. Moves inside one scope still work offline, as now.
- **Concurrent edits:** the server edits tree docs as a peer of its own, appending ordinary Yjs updates to the log. A title edited offline in the old tree doc while the page was being moved is lost. This is rare, and the page history keeps it.

### The sync protocol, version 2

- **Filtering the stream:** each connection carries the user's readable scopes. The hub sends a log row only if its doc's scope is readable.
  - A per-workspace cache of placements and access is invalidated when either changes.
  - A single server process invalidates in memory. Postgres `LISTEN/NOTIFY` is the path for several processes.
- **`push` items carry a scope** for docs the server hasn't seen yet. The server places a new doc there if the user can edit that scope. For an existing doc, the hint is ignored and the doc's own scope is checked.
- **Per-item acks** say `ok` or `denied`. When an item is denied, the client:
  - drops it from the outbox
  - saves the rejected local state as a page-history snapshot ("Not saved: your access changed")
  - resets the doc to the server's state (`DocManager.reset`)

  So nothing vanishes silently.

- **`access` message:** the user's scopes, with each one's kind, name, tree doc and role. It is sent after `hello` and again whenever access changes. Desktops store it, so the sidebar and read-only state work offline.
- **Gaining access:** the server sends the merged state of every doc in the new scope (`backfill`). Those docs have log numbers below the device's cursor, so the stream alone would never deliver them.
- **Losing access:** the server sends `revoke` with the scope. The desktop deletes those docs, their index entries and their history.
- **Presence:**
  - `watch`/`unwatch` tell the server which docs a desktop has open (the web app's `open`/`close` already do).
  - `awareness` carries y-protocols awareness updates for a watched doc.
  - The server overwrites the `user` field with the signed-in account before relaying, so nobody can appear as someone else. It relays only to connections that can read the doc.
- Version 1 clients are refused with "update the app": the desktop has no installed base yet.

### Checking what a write contains

- **Comments docs:** the server applies each update to a copy and compares the before and after. A new comment must carry the sender as its author. Nobody edits or deletes another person's comment, except someone with full access deleting it. Comments docs are small, so this is cheap.
- **The members doc** (`members`, see M1) is written only by the server. Client writes to it are denied.
- **Authorship:** `doc_updates` gains a `user_id`. Page-history authors and "last edited by" on the server come from the log, not from fields a client could forge.

### Other access checks

- **Files** stay workspace-wide and content-addressed. A file's id is the SHA-256 of its contents, and ids only appear inside docs, so knowing an id implies having read a doc that uses it. The exception is published pages: a public visitor gets a file only if a published page references it (M7).
- **Search, page location, backlinks and history endpoints** filter by readable scopes in SQL.

```
                      Postgres
 users ─ workspace_members (owner|admin|member|guest) ─ groups ─ group_members
 scopes (teamspace|private|shared, parent, inherit) ─ scope_access (principal, role)
 doc_scopes (doc_id → scope_id)      doc_updates (+ user_id)
 invites · notifications · page_follows · reminders · comments index
 page_links · doc_snapshots · published_pages · page_views
```

## Milestones

### M1: members, invites and groups (about 1 week)

- **Server:**
  - Migration 5: `workspace_members.role` (owner, admin, member, guest), `invites`, `groups`, `group_members`, and `users.avatar_file`.
  - **Invites:**
    - By email, with a role. The link is `/invite/<token>`; the token is stored hashed, expires after 7 days and works once.
    - Accepting needs an account. An invite also lets someone sign up when sign-up is invite-only.
    - With `SMTP_URL` set, the server emails the link. Without it, the inviter copies the link.
  - **Members:** list, change role, remove, leave. Rules:
    - The last owner can't leave or be demoted.
    - Admins can't change owners.
    - Removing someone closes their sockets on that workspace.
  - **Groups:** create, rename, delete, and add or remove members.
  - **The members doc** (`members`): names, avatars and workspace roles, written by the server only. It replaces the workspace doc's `users` map for person properties and the person picker, and works offline. Guests see names and avatars, not emails.
- **App:**
  - Settings → **Members**: tabs for members, guests, groups and pending invites; an invite dialog; role menus.
  - **Account:** name and avatar.
  - **Person mentions:** `@name` in text, as a mention node with the user's id. Person properties list the members.
  - **Desktop:** the workspace switcher shows server workspaces the account belongs to, beyond the one synced now. Joining one from an invite link opens it.
- **Tests:**
  - invites (expiry, reuse, wrong account, invite-only sign-up)
  - role rules
  - the members doc being read-only
  - E2E: the owner invites a second account on the web, which accepts and appears in the members list and the person picker

### M2: scopes and permissions on the server (about 1.5 weeks)

- **Migration 6:**
  - `scopes`, `scope_access` and `doc_scopes`, plus `doc_updates.user_id`
  - each existing workspace gets one scope that uses the `workspace` doc as its tree. Its access is the owner only, so inviting someone exposes nothing until the owner shares it.
- **Docs:** placing every existing doc in that scope: the placement follows the tree (pages, their databases, rows, comments).
- **Database doc split:** `rows:<dbId>` holds the `rows` map so "can edit content" can be enforced. A one-time migration runs in the client (`@workspace/database`), on both the desktop and the server. Readers accept both layouts until the move is done.
- **Effective role:** `effectiveRole(user, scope)` combines workspace role, group membership, the scope's own entries and inherited entries. It is computed in SQL with a recursive CTE and cached per workspace.
- **Protocol version 2** (`packages/sync`):
  - new messages: `access`, `backfill`, `revoke`, `watch`, `unwatch` and `awareness` (relayed in M4)
  - scope hints on push items
  - per-item ack status
  - `SyncHub` filters per connection. `PartialClient` and `SyncClient` handle denied items, backfill and revoke.
- **Scope API:**
  - create and rename teamspaces, and set their members and default role
  - share a page: add or remove principals, change a role, toggle inheritance
  - move a page across scopes
  - all as server operations that edit tree docs and placements in one transaction
- **Desktop:**
  - the sync store keeps the access list
  - `DocManager.reset(docId, state)`
  - deletion on revoke
  - backfill applied without moving the cursor
- **Tests:**
  - **An authorization matrix:** every role (including none) × doc kind × action (open, receive in the stream, push, awareness, search, location, history, backlinks, files), each expected to allow or deny. It is table-driven against a real server and Postgres.
  - forged scope hints
  - stubs pointing at unreadable scopes
  - a downgrade while offline (denied push → history snapshot → reset)
  - revoke and backfill across a reconnect
  - convergence fuzzing with filtering on

### M3: teamspaces, private pages and sharing in the app (about 1.5 weeks)

- **Sidebar sections:**
  - Teamspaces: each with its tree, plus join and leave
  - Shared: pages shared with you, and pages you shared outside a teamspace
  - Private
  - Favorites, across all of them

  New pages go to the section they're created in. A local-only workspace shows just "Private", as now.

- **Teamspaces:**
  - create one, with name, icon and description
  - visibility: open (anyone can join), closed (visible, join on request) or private (hidden)
  - members and the default role
  - workspace-default teamspaces that new members join
- **Share menu** (page header and page menu):
  - add people or groups with a role
  - general access: the teamspace, the workspace, or only the people listed
  - "Inherit from parent" on or off
  - copy link
  - who has access and why ("from Engineering")
- **Read-only modes:**
  - **view:** the editor, title, icon, cover and database views are read-only, as for locked pages
  - **comment:** the same, but comments can be added
  - **can edit content:** rows and cells are editable; properties, views and the schema are not
  - The UI disables actions it would be denied, and the server checks again.
- **No access:** page mentions, links, synced blocks, relations and rollups that point into an unreadable scope show "No access" instead of a title or content. Backlinks and search only list readable pages, which happens naturally because the desktop never receives the other docs.
- **Drag to another section** moves the page across scopes, after confirming when access changes ("People in Engineering will see this page"). Offline, the move waits with a notice.
- **E2E**, with three accounts (owner, member, guest) on two desktops and the web:
  - private pages are invisible to the others
  - sharing a page with the guest shows it under their "Shared" and nothing else
  - a view-only member can't type
  - revoking access removes the page from the guest's desktop

### M4: presence and live cursors (about 0.5 weeks)

- **Awareness per open doc:** y-protocols `Awareness` instances, carried by `DocTransport.presence` (over IPC on the desktop, over the socket on the web).
  - The local state holds the user (from the server), a color derived from the user id, and the selection as Yjs relative positions.
  - States expire after 30 seconds without updates, and on disconnect.
- **Editor:** remote cursors and selections with name labels, using the cursor plugin from `@tiptap/y-tiptap` (the y-prosemirror fork the editor already uses), styled to match.
- **Page header:** avatars of who's on this page; clicking one scrolls to their cursor.
- **Database views:** the row someone has open shows their avatar.
- **Sidebar:** a small dot on pages others are viewing.
- **Tests:**
  - identity can't be spoofed (the server overwrites `user`)
  - awareness isn't relayed to people who can't read the doc
  - E2E: two accounts on one page see each other's cursor and avatar

### M5: comments and suggested edits (about 1 week)

- **Comments doc** (`comments:<pageId>`), so people who can comment don't need write access to the page:
  - threads: id, anchor, resolved by and when, and a list of comments
  - each comment: id, author, rich-text body, created and edited times, reactions
  - **Anchors:**
    - the page
    - a block (by block id)
    - a text range, as Yjs relative positions into the page content, so it survives concurrent edits
    - a database property value on a row page
- **UI:**
  - select text → Comment (bubble menu and `Ctrl+Shift+M`); highlighted ranges open their thread
  - page comments under the title
  - a comments panel: open and resolved threads, filters, jump to the anchor
  - replies, @mentions in comments, edit and delete your own, resolve and reopen, emoji reactions
  - an orphaned anchor (its text was deleted) shows the thread as "on deleted text"
- **Suggested edits:**
  - "Suggest edits" mode (page menu, and the default for commenters) turns typing and deleting into suggestions in the comments doc. A suggestion holds the anchored range and the proposed replacement as a ProseMirror slice.
  - The editor shows insertions underlined and deletions struck through.
  - Someone who can edit accepts a suggestion, which applies it to the page, or rejects it.
  - Limited to text inside one block or across adjacent text blocks. Structural changes (moving blocks, changing block types) aren't suggestible.
- **Server:** the comments update check (authorship, no editing other people's comments), and a comments index for the inbox and the comments count.
- **Tests:** anchors through concurrent edits; suggestions applied after edits elsewhere in the block; forged authors denied; E2E for a commenter commenting and suggesting while the owner accepts.

### M6: inbox and notifications (about 0.75 weeks)

- **Server log followers** (generalising the search indexer's cursor into `log_followers`):
  - new person mentions in pages and comments
  - replies and new threads on pages the user follows
  - reminders: date mentions and date properties with a reminder, stored in `reminders`, and fired by a scheduler loop that polls for due ones
  - invites, and access granted to a page
- **Notifications:**
  - The `notifications` table, per user and workspace, with read and archived state.
  - Page follows: a user follows pages they created, edited or commented on, and can follow or unfollow from the page menu.
  - Live delivery over the socket (`notify`), plus REST endpoints for the list and for marking items read.
- **App:**
  - **The inbox** in the sidebar, with an unread count. Filters: all, mentions, unread, archived. Clicking an item opens the page at the comment or mention.
  - **Desktop notifications** through Electron's `Notification` (libnotify on Ubuntu) when the window isn't focused, with settings per kind.
  - **Reminders:**
    - Local reminders keep working offline in every workspace.
    - In a synced workspace a reminder belongs to whoever set it (the mention gains a `userId`).
    - The desktop doesn't repeat a system notification for a reminder it already showed.
- **Tests:**
  - each notification kind, and notifications for unreadable pages being dropped
  - reminder scheduling across a server restart
  - E2E: a mention on one desktop shows in the other user's inbox and as a desktop notification (Electron's `Notification` is stubbed so the test can see it)

### M7: publish to web, server backlinks and history (about 1 week)

- **Publish** (Share menu → Publish):
  - **Settings:** a slug, whether sub-pages are included, whether search engines may index it, a title and description for search results and social cards, and whether visitors may duplicate it as a template.
  - **Rendering:** the server renders `/p/<slug>/…` from merged doc states with the HTML exporter: pages, databases as tables, and images.
    - Cached per page and invalidated by the log.
    - A visitor gets a file only if a published page references it.
    - CSP and `noindex` headers.
  - **Unpublish** takes effect at once.
  - **Custom domain** (optional): Caddy on-demand TLS, with an `ask` endpoint that only answers for configured domains.
- **Page analytics:** views and unique viewers per day, from signed-in visits and published views, shown in the page menu. Counted server-side without cookies for public visitors (a daily salted hash of IP and user agent).
- **Server backlinks:** a log follower extracts links with the same `@workspace/core` functions the desktop uses into `page_links`. The web app turns on `backlinks`.
- **Server history:**
  - A log follower stores `doc_snapshots`, with authors from `doc_updates.user_id`, after a doc has been quiet for 10 minutes. The retention policy is the desktop's.
  - The web app turns on `history`, and restore runs in the client as on the desktop.
  - Desktops show the server's versions (with authors) next to their local snapshots.
- **Tests:**
  - publishing and unpublishing, and the file allow-list
  - nothing unpublished leaks through links, mentions or synced blocks on a published page
  - snapshots and restore
  - E2E: publish a page, open it signed out, then unpublish

## Exit check

"Several users co-edit with the correct permission checks":

- **Three accounts** (owner, member, guest) on two desktops and the web app, against one server:
  - The owner's private pages never reach the member's or guest's desktop. Their local databases contain no such doc, title or file reference.
  - A teamspace page is co-edited live by the owner and the member, with cursors and avatars.
  - A page shared with the guest as "can comment": the guest comments and suggests an edit, the owner accepts it, and the guest can't edit the page.
  - The member, while offline, edits a page the owner then makes view-only. On reconnect, the member's edit is denied, saved in their history, and the page matches the server.
  - Revoking the guest's access removes the page from the guest's desktop.
  - A mention and a comment reply arrive in the right inboxes and as desktop notifications.
  - A published page is readable signed out; unpublished sub-pages and files are not.
- **The authorization matrix** (M2) passes: every role × doc kind × action, over the socket and the REST API.
- **Crafted clients:** a test client that skips the UI tries to:
  - open, push to and watch docs it has no access to
  - forge scope hints, comment authors and awareness identities
  - write the members doc

  Every attempt is denied, and nothing it shouldn't see arrives in its stream.

- **The Docker stack:** the stack smoke test (Phase 4) is extended with a second account and a shared page.

## Packages

```
packages/
  sync/            protocol v2: access, backfill, revoke, presence, per-item acks
  storage-remote/  members, invites, groups, scopes, access, notifications, links, snapshots
  collab/          new: comments doc model, anchors, suggestions, presence state (no I/O)
apps/
  server/          scope and sharing API, followers (notifications, links, snapshots), publish
```

New dependencies:

- `y-protocols` (awareness), already in the tree through `@tiptap/y-tiptap`
- `nodemailer`, only when `SMTP_URL` is set

## Critical files

- **New:**
  - `packages/collab/src/{comments.ts, anchors.ts, suggestions.ts, presence.ts}`
  - `apps/server/src/{members/*, scopes/*, followers/*, publish/*}`
  - `packages/app/src/{members-settings.tsx, share-menu.tsx, teamspaces.tsx, comments/*, inbox.tsx}`
  - `packages/editor/src/{cursors.ts, comment-marks.ts, suggest-mode.ts}`
- **Modified:**
  - `packages/sync/src/{messages.ts, hub.ts, client.ts, partial.ts}`: protocol v2
  - `packages/core/src/{schema.ts, workspace.ts}`: tree docs per scope, stubs, members doc
  - `packages/database/src/schema.ts`: the `rows:<dbId>` split
  - `packages/storage-local/src/{doc-manager.ts, sync-store.ts}`: reset, revoke and the access list
  - `packages/app/src/{sidebar.tsx, page-view.tsx, platform.ts}`: sections, read-only roles, features
  - `apps/desktop/src/main/sync/service.ts`: v2 messages, notifications

## Verification

- **Unit tests (Vitest):**
  - effective roles
  - the protocol v2 encoding and limits
  - comment anchors and suggestions through concurrent edits
  - the members doc and the tree doc stubs
  - the database doc split migration
- **Integration tests (Vitest + throwaway Postgres):**
  - the authorization matrix
  - invites and roles
  - scope moves (tree docs and placements stay consistent)
  - followers (notifications, links, snapshots) through catch-up and compaction
  - publishing
- **E2E (Playwright):**
  - several Electron instances signed in as different accounts, plus the web app in Chromium
  - the exit check scenario as its own spec, like Phase 4's
- **Convergence fuzzing** (M3 of Phase 4) gains random access changes. Every device must end with exactly its readable docs, converged.
- Before every push:
  - `pnpm lint`, `pnpm typecheck`, `pnpm test` and the Prettier check
  - the desktop E2E, run twice
  - the web E2E
- **Security review** before sign-off:
  - every message and endpoint checks access to the specific doc, not just the workspace
  - nothing derives access from Yjs content
  - invite tokens are hashed and used once
  - published pages expose only what's published
