# Phase 5: Collaboration

**Status:** M1 (members, invites and groups), M2 (scopes and permissions on the server), M3 (teamspaces, private pages and sharing in the app) M4 (presence and live cursors), M5 (comments and suggested edits), M6 (inbox and notifications) and M7 (publish to web, server backlinks and history) are done. The exit check is next.

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

### M1: members, invites and groups ✅

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

**M1 notes:**

- **Server (`storage-remote`, migration 5):**
  - Roles were already in `workspace_members` from Phase 4.
  - Migration 5 adds `users.avatar`, `workspace_invites`, `groups` and `group_members`.
  - **Differs from the plan:** the avatar is a small `data:` URL on the user row (the client crops it to 96 px, WebP; at most 64 KB), not a stored file. Files are per workspace, and a picture belongs to the account. Inline, it reaches every device in the members doc and shows offline with no file fetch.
  - `Teams` holds members, invites and groups:
    - Role changes and removals run under the workspace row's lock, so two owners demoting each other at once still leave one owner.
    - A new invite to an address replaces the pending one.
    - Accepting never lowers someone's role. Accepting again as the same person is a no-op, because signing up with an invite already joins.
- **Routes:**
  - `/api/workspaces/:id/{members,invites,groups}` and `/api/invites/:token` (what the link shows, without signing in, rate-limited), plus `…/accept`.
  - Guests get 403 on the members list. Outsiders get 404, as for every workspace route.
  - Sign-up accepts a workspace invite when sign-up is invite-only, and joins that workspace.
  - `PATCH /api/auth/me` takes a name and/or a picture.
- **The members doc (`members`):**
  - The server writes it (`MembersDoc.refresh`) after every change, and once when a socket connects. That catches up workspaces from before M1.
  - It reads the doc's merged state, writes only the difference with `writeMembers` (in `@workspace/core`) and appends it through the hub (`SyncHub.appendFromServer`), so connected devices get it live.
  - The hub refuses client writes to it through a new per-doc check (`Access.canWriteDoc`). Refused items are acknowledged with seq 0 and not stored, so the client's outbox moves on, and the client gets a `denied` error. This is a first step toward M2's per-item acks.
  - People who leave stay listed as `removed`, so the pages they touched keep their names.
- **Sockets:** a role change closes the person's sockets with 1001, so they reconnect with the new access. Removal closes them with 4403.
- **Mail:** `SMTP_URL` and `SMTP_FROM` (nodemailer) send invite emails. Without them, the inviter copies the link. A failed email still returns the link.
- **App:**
  - `Platform.team` is a `request(method, path, body)`:
    - the web app calls the API directly
    - the desktop goes over IPC to the main process, which holds the token and only forwards the team routes, checked against a pattern and method list
    - the UI offers it on the web, and on the desktop while it syncs
  - **Members dialog:** the invite form (emails and role, then links to copy), tabs for Members, Guests, Groups and Invites, role menus, remove and leave. Only owners see or change owners.
  - **Profile dialog:** name and picture.
  - **Sidebar:** Members, plus Members… and Your profile… in the workspace menu.
- **People in the UI:**
  - `usePeople` merges the members doc with the workspace doc's old `users` map (members' current names win). It feeds person cells (with pictures), "created by", filters and pickers.
  - Pickers offer a server workspace's current members only. A local workspace offers everyone in its `users` map, as before.
  - `Avatar` moved to `@workspace/ui`. It shows the picture, or an initial on a color derived from the person's id.
- **Person mentions:**
  - `@` suggests people (any word of their name) between dates and pages.
  - The mention stores the user id, and the name stays current.
  - Exports write `@Name`. Search indexes person values by member name, on the desktop and the server.
- **Desktop identity:** while syncing, the app's user is the account (the same id as in the members doc), so new person values and "created by" use it.
- **Web:**
  - `/invite/<token>` shows who invited whom, to where and as what.
  - Signed out, it's a sign-up or sign-in form for the invited address; the invite code is filled in and the workspace is joined right after.
  - Signed in as someone else, it says so and offers to sign out.
  - Used, expired and withdrawn links say so.
- **Not done here (moved):** a desktop holding several server workspaces side by side. Today it syncs one; others are joined on the web, or with "Replace" in Sync. This comes with M3's sidebar sections.
- **Tests:**
  - **Store:** owner rules (including two owners racing), invites (email, expiry, reuse, replacement, revocation, never lowering a role), groups (only the workspace's members, removed on leaving) and avatars.
  - **Server:** invite sign-up on an invite-only server, wrong account, withdrawn invites, the full role matrix, groups over REST.
  - **The members doc:** it reaches devices live, follows renames, pictures and role changes, ignores a device trying to make itself owner, and reconnects or drops sockets on role changes.
  - **Hub:** denied docs are acknowledged and dropped, and server appends work with or without connections.
  - **Units:** `writeMembers`, the `@` people suggestions, person mentions in Markdown and HTML, email parsing.
  - **Web E2E (`members.spec.ts`), on an invite-only server:**
    - Ada sets her picture and invites Bob, and gets the link.
    - Bob signs up from the link and lands in the workspace. The link is used up.
    - Each sees the other with the right roles. Bob gets no management controls.
    - Ada makes a group with Bob, @-mentions him (Bob sees it live) and picks him in a person property.
    - Bob renames himself, and Ada's mention and cell follow.
  - **Desktop E2E:** once synced, the desktop's Members dialog lists the account, invites a guest and revokes the invite.

### M2: scopes and permissions on the server ✅

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

**M2 notes:**

- **Migration 6 (`storage-remote`):**
  - Tables `scopes`, `scope_access`, `doc_scopes` and `doc_moves`; columns `doc_updates.user_id`, `workspaces.default_scope_id` and `search_index.scope_id`.
  - Each existing workspace gets its owner's private scope, with the `workspace` doc as its tree, and every doc but `members` is placed there. Inviting someone exposes nothing until the owner shares.
  - **New workspaces:** an upload from the desktop starts private, like existing ones. One made on the web starts as a teamspace that everyone in the workspace can edit.
  - `Scopes` (in `storage-remote`) holds the access model, placements and moves. `place` is insert-or-get, so two devices placing one new doc agree. `move` re-places docs, records each move at a log position, and moves their search rows, all in one transaction.
- **Effective roles (`apps/server/src/access`):**
  - **Differs from the plan:** roles are computed in TypeScript (`rolesFor`), not with a recursive CTE. The whole model (scopes, entries, members, groups) is small, so `AccessService` loads it once per workspace with every placement, and answers each row without a query.
  - A role is the highest of the person's own, their groups' and `workspace` entries; `full` on teamspaces for owners and admins (private pages stay private, even to them); and, for a scope that inherits, its parent's role.
  - Every change (scope access, member roles, removals, groups, invites accepted, sign-ups that join) reloads the model and re-authorizes the open sockets. A role change no longer closes them.
  - One server process is assumed, as the plan says. `LISTEN/NOTIFY` is the way to run several.
- **Protocol version 2 (`packages/sync`):**
  - `hello` carries the scopes the device holds (`known`). Push items carry a scope hint. Acks say per item whether it was `denied`.
  - New server messages:
    - `access`: the person's scopes and roles
    - `backfill`: the merged state of docs just gained
    - `revoke {docIds, scopes}`: docs and scopes lost
    - `refused`: an `open` of a doc the person can't read
  - The hub takes a `DocPolicy` per connection: `canRead` filters the stream, catch-up and opens, and `canWrite` checks each pushed item (placing a new doc in its hint's scope, or the default scope, if the person may edit there).
  - **A refused item** is acknowledged and not stored. If the person can still read the doc, the hub sends its copy (`state`) so the device starts over from it. Otherwise it revokes the doc.
  - **Access changes:** the hub sends `revoke` first, then `backfill`, then `access`, in order with the client's messages. A client that records its scopes from `access` never claims a scope whose docs it hasn't received.
  - **Returning devices:** on `hello`, the server compares `known` with the person's scopes now, and with the moves recorded since the device's cursor, and sends what it lost and gained.
  - A row is held back from its own connection only if that connection appended it and hasn't had the doc wiped since. Edits in flight when a doc was revoked or reset come back to the device.
  - Version 1 clients are refused at `hello`.
- **Scope API (`/api/workspaces/:id/…`):**
  - `GET scopes`: the caller's scopes and roles, with the access entries where they have full access
  - `POST teamspaces`, `POST private`, `PATCH scopes/:scopeId` (name, inherit)
  - `PUT scopes/:scopeId/access {principal, role|null}`, with principals `user:<id>`, `group:<id>` or `workspace`
  - `POST pages/:pageId/share`: makes the page its own scope, inheriting from where it was, with a stub left in place
  - `POST pages/:pageId/move {from, to, parentId?}`: moves a page and its sub-pages to another scope
  - Moves run one at a time per workspace. The server edits both tree docs as its own peer (`moveSubtree` in `@workspace/core`) and appends the updates through the hub. It then re-places the pages' docs (content, database, rows, comments) and the open sockets get what they gained or lost.
- **REST filtering:** search and page location only return pages in scopes the caller can read.
- **Stubs (`@workspace/core`):** a tree entry with a `scope` field is a stub. `getPage` and `listPages` skip stubs, and `listStubs` lists them for M3's sidebar.
- **Desktop:**
  - The sync store keeps the access list (`sync.access`), merges backfills without moving the cursor, and forgets revoked docs (their updates, index entries and outbox items).
  - **A refused change:** a page-history snapshot ("Not saved: your access changed"), then `DocManager.reset` to the server's copy, then the windows reload.
  - The page tree is held for the app's whole life, so a reset or revoke of it restarts the app.
  - The app writes the user's name into the page tree (the old `users` map) only for a local workspace. A server workspace has the members doc for names, and its tree may not be the user's to change.
- **Web:** a reset or revoked doc reloads the page. `PartialClient.open` rejects with `NoAccessError` for a doc the person can't read.
- **Moved to later milestones:**
  - **"Can edit content" and the `rows:<dbId>` split:** moved to M3, with the sharing UI that offers the role. Roles today are full, edit, comment and view.
  - **`watch`, `unwatch` and `awareness`:** M4, with presence.
  - **Checking comment authors in comments docs:** M5, with comments. Today a comments doc needs the comment role.
  - **History and backlinks in the matrix:** M7, when those endpoints come to the server. Files stay workspace-wide, as planned.
- **Known limits until M3:**
  - The apps show only the `workspace` tree. Docs of other scopes sync, but their pages aren't listed until M3's sidebar sections.
  - The apps don't know roles yet. A view-only person can still type: the edit is refused, kept in history and undone. A member with no scope they can edit can't create pages.
- **Tests:**
  - **The authorization matrix** (`access.test.ts`, real server and Postgres):
    - An owner, a member, a guest and an outsider, over:
      - a teamspace everyone can edit
      - the owner's private pages
      - a view-only teamspace
      - a shared page the guest may comment on
    - For each: open, the live stream, push (including forged scope hints and the members doc), search and page location.
  - **Access changes** (`access.test.ts`):
    - an outsider's socket is refused
    - access taken away while connected (the docs go)
    - access given back while away (the docs come whole on reconnecting)
    - a page moved out of a scope while away
    - a downgrade while offline (the edit is refused and undone, nothing lost on the server)
    - a grant to a group reaching a member added to it later
  - **Store:** scope creation and access, private scopes made once, placement races, moves and their search rows, and migration 6 on data from before it.
  - **Hub, clients and messages:** the policy filtering the stream and opens, refused items (`state` or `revoke`), re-authorization (revoke, backfill, access), `PartialClient` refusing and undoing, and every new message round-tripping.
  - **Convergence fuzzing with access** (`fuzzWithAccess`): random edits, drops, restarts, roles gained and lost, and refused writes. Every replica must end with exactly what the server holds of the docs it may read. 200 seeds of each fuzzer pass.
  - **Desktop sync store:** refused changes kept in history then reset, backfills merged, revoked docs forgotten.
  - **Desktop E2E (`access.spec.ts`):**
    - Ada uploads her workspace and invites Bob. Bob's desktop joins and shows no pages.
    - Ada opens her pages to the workspace, and "Gripper" arrives on Bob's desktop live. Bob's edit reaches Ada.
    - Bob edits offline while Ada makes the pages view-only. On reconnecting, his edit is refused: the app restarts on the server's copy, and his text is in the page history as "Not saved: your access changed".
    - The real-server helpers (the server and the TCP proxy) moved to `e2e/server.ts`, shared with the exit check.

### M3: teamspaces, private pages and sharing in the app ✅

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

**M3 notes:**

- **Many page trees as one (`Forest`, in `@workspace/core`):**
  - A `Forest` holds the tree docs of the scopes someone can read. Every page function (`getPage`, `listPages`, `createPage`, `movePage`, `trashPage`, `duplicatePageTree` and the rest) accepts either a single tree doc or a forest:
    - reads see the union
    - each write goes to the tree the page lives in
    - a new top-level page goes to a named tree, or by default to the person's private pages
  - **Stubs:** a page shared on its own shows where its stub is, for people who can read both trees. Moving it there moves the stub.
  - A parent the person can't see shows the page at the top level.
  - Pages carry `tree` (where they live) and `home` (where they show).
  - **Moves across scopes:** a move that would take a page to another tree throws `ScopeMoveError`, and the app asks the server to do it.
  - **Workspace-wide data** (math macros, the old list of users) stays in the workspace doc (`workspaceDataDoc`). Someone who can't read it gets the defaults.
- **Desktop:**
  - The doc manager holds every tree doc it has (`workspace` and `tree:*`) as a forest. The page index, search, links and "last edited" cover all of them.
  - **A tree reset** to the server's copy is swapped in place and the windows reload. The app no longer restarts, as it did in M2.
  - **A page removed from a tree:**
    - by sync, it may be on its way to another scope's tree: its content stays, and only its index rows go
    - by a deletion on this device: everything goes
  - **New docs** are hinted to their page's scope (a row to its database's, comments to their page's), so they're placed where they belong.
  - The sync status carries the scopes (from `sync.access`), and the renderer builds its forest from them.
  - Imports go into the private pages (`startImport(tree)`), and exports read every tree.
  - The renderer may call the scope routes through the main process's allow-list.
- **Web:** the scopes come from the socket's `access` message. The app tells the client which scope a new doc belongs in (`ScopesPlatform.setResolver`).
- **Server:**
  - **Migration 7:** teamspaces get an icon, a description, a visibility (open, closed, private) and the role joining gives. Every member but guests gets private pages, both for existing members and on joining.
  - **Routes:**
    - `GET teamspaces`: the teamspaces the caller can find (private ones only for their members, none for guests)
    - `POST scopes/:id/join`: open teamspaces only
    - `POST scopes/:id/leave`: refused when someone is in it through everyone in the workspace, a group, or as an admin
    - `PATCH scopes/:id` and `POST teamspaces` take the new fields
    - Who has access is listed to the workspace's members, not only to those with full access
  - Someone else's private pages, opened to a person, reach them as a shared scope, so they show under "Shared", not as their own "Private".
  - Fixed a race in `Scopes.place`: two devices placing the same new doc at once could read nothing.
- **App:**
  - **Sidebar sections:**
    - Teamspaces (by name, with icons from the server), Shared, then Private. A workspace that isn't on a server keeps its one "Pages" section.
    - Each section has its own "add a page" button and drop zone.
    - The Teamspaces header has New teamspace and Browse.
    - A teamspace's menu has its settings and Leave.
    - Rows the person can't edit offer no add, duplicate, move, trash or drag.
  - **Teamspace dialogs:**
    - New teamspace: name, icon, description, who can find it, and everyone in the workspace's access.
    - Settings: the same details, the joining role, and members (add, change role, remove).
    - Browse: Join for open teamspaces.
  - **Share dialog** (the page header's Share button):
    - Invite people (members and guests) or groups with a role. A page that has the access of where it is gets shared on its own first.
    - Who has access, with "from Engineering" for access that comes from the teamspace.
    - General access: "Everyone with access to …" (inheritance) and "Everyone in the workspace".
    - Copy link.
  - **New pages:** "New page" (and Ctrl+N) adds a page to your private pages, as in Notion. A section's own "add a page" button adds it there. The web members E2E now writes its shared page in the workspace's teamspace.
  - **Read-only:** a page (or a row, by its database) the person can only view or comment on is read-only, as a locked page is, with a "View only" or "Can comment" badge.
  - **Moving across sections:** dragging a page to another section, or "Move to" under a page of another section, asks first ("who can see it may change"), then the server moves it.
  - **No access:** mentions and page links to a page that isn't there show "No access" on a server workspace ("Deleted page" otherwise). A synced block from such a page says so.
- **Differs from the plan:**
  - **Closed teamspaces** are joined by being added; join requests need the inbox (M6).
  - **Default teamspaces** are the ones that give everyone in the workspace a role. There's no separate flag, and they can't be left.
  - **Workspace owners and admins** have full access to every teamspace (from M2), so all teamspaces show in their sidebar.
  - **A move across sections while offline** says it needs a connection, rather than waiting to run later.
  - **"Comment" works as "view"** until comments exist (M5).
- **Moved again: "can edit content" and the `rows:<dbId>` split** go to Phase 6, with forms, which need the same row-level writes. Roles stay full, edit, comment and view.
- **Not done:** relation and rollup cells that point at rows in an unreadable database show nothing, rather than "No access".
- **Tests:**
  - **Core forest:**
    - the union and per-tree writes
    - stubs shown in place, or at the top without their tree
    - moves within a tree, and refused across
    - duplicating
    - change events
  - **Desktop storage:**
    - trees held, indexed and scoped
    - trees kept after a restart
    - content kept when sync moves a page to another tree
    - trees reset in place and revoked
  - **Server:**
    - private pages for members (not guests)
    - teamspace details
    - finding (open, closed, private) and joining
    - leaving, and not leaving a teamspace that's everyone's
  - **App:** the sidebar's sections.
  - **E2E (`scopes.spec.ts`)**, with Ada (owner, desktop), Bob (member, web) and Gus (guest, desktop):
    - Ada's pages are private. She makes "Engineering" (everyone may view) through the dialog and adds a page.
    - Bob sees Engineering view only (badge, read-only editor and title) and none of Ada's private pages.
    - Ada shares "Diary" with Gus from the Share dialog. It shows under his "Shared", and nothing else does.
    - Ada drags "Specs" from Private into Engineering and confirms. Bob sees it there, live.
    - Ada removes Gus's access, and "Diary" leaves his desktop.
  - The M2 access test follows the change: a refused edit reloads the window, without a restart.
  - The full desktop E2E passed twice (103 tests each) and the web E2E passed (3 tests).

### M4: presence and live cursors ✅

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

**M4 notes:**

- **Protocol version 3** (`packages/sync`):
  - Client messages: `watch`, `unwatch` and `awareness`, which carries a y-protocols awareness update of at most 64 KB. The server sends `awareness` with others' presence.
  - A version-2 server would refuse the new messages, so the version moved on. Older clients are refused with "update the app".
- **The server's presence rooms** (`PresenceRoom`, in the hub):
  - Each doc someone watches keeps the latest state of every client. Someone who starts watching gets them all at once.
  - **The account, not the client, says who someone is:** each state's `user` is replaced with `{id, name, color}` from the signed-in account. The color is derived from the id, the same way on every client.
  - A connection can't change or remove another connection's clients.
  - **Readers only:** a watch of a doc the person can't read is ignored. Presence goes only to watchers who may read the doc. Losing access to a doc ends the watch, and the person's cursor goes.
  - **Leaving:** when a connection unwatches or goes away, the others get its clients removed. The removal keeps each client's clock, so its next state after a reconnect is taken.
- **Clients:**
  - `SyncClient` and `PartialClient` share `ClientPresence`: the watched docs, sent again after every reconnect, and then `onPresenceRejoin`, so the app announces itself again with a newer clock.
  - **Desktop** (`main/presence.ts`): the main process relays between windows that show the same doc and, while syncing, to and from the server. It keeps which clients each window has, so a window that closes, crashes or reloads is removed for the others at once.
  - **Web:** the socket directly.
  - `DocTransport.presence` (in `@workspace/core`) is how the app reaches either.
- **App** (`packages/app/src/presence.ts`):
  - **One `Awareness` per doc** per window, shared by its views (`PresenceHub`, in the app's context). Only this window's own state is sent. States from others time out after 30 seconds without a renewal, which y-protocols sends every 15.
  - **Editor:** y-tiptap's cursor plugin draws others' carets and selections, with a name label in each person's color. Your own other windows don't show a caret.
  - **Page header:** avatars (with pictures, from the members doc) of the others on the page. Clicking one scrolls to their cursor.
  - **Sidebar:** a dot in each person's color on the pages others are viewing. Each window says which page it shows on that page's tree doc, which only people who can read the page receive.
  - **Database views:** a row someone has open, as a page or in a peek, shows their avatar in the table. The row page's header shows who else has it open. This uses a `row` field on the database doc's presence.
  - A desktop that isn't syncing still shares presence between its own windows (and shows nobody else).
- **Differs from the plan:**
  - The "viewing" dot and the row avatars use tree and database docs' presence: no extra server state, and the same read rules.
  - Row avatars show in table views. Board, list, gallery, calendar and timeline cards don't show them yet.
- **Tests:**
  - **Hub:**
    - the account stamped over a forged `user`
    - another connection's cursor can't be moved or removed
    - newcomers get everyone
    - nothing goes to people who can't read the doc, or to unwatched docs
    - removals at the same clock when someone leaves or loses access
  - **Server, over real sockets:** the name others see is the account's, and a guest who can't read the page gets nothing.
  - **Messages:** the new ones round-trip.
  - **E2E (`presence.spec.ts`)**, with Ada on a desktop and Bob on the web, in a teamspace they both edit:
    - On the same page, each sees the other's avatar in the header and a named cursor in the editor. Bob's typing reaches Ada, with his cursor.
    - Bob opens another page: Ada's sidebar shows a dot on it ("Bob viewing"), and her header no longer shows him.
    - Bob opens a database row: Ada's table shows his avatar on it. He closes the browser, and it goes.

### M5: comments and suggested edits ✅

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

**M5 notes:**

- **The model** (`packages/core/src/comments.ts`), in a comments doc per page (`comments:<pageId>`), placed in the page's scope:
  - `threads`: a map from thread id to the thread: anchor, author, created, resolved by and when, its comments, and for a suggested edit, the suggestion.
  - **Comments:** author, body, created and edited times, and reactions (emoji → who reacted, one entry per person so concurrent reactions merge).
  - **Anchors:** the page, a block, a text range or a row property. A range is two Yjs relative positions (base64), plus the text it covered then (`quote`), so it follows concurrent edits and still says what it was about once the text is gone.
  - Functions for every change (`createThread`, `addComment`, `editComment`, `deleteComment`, `toggleReaction`, `setResolved`, `updateSuggestion`, `decideSuggestion`), and `mentionsIn` for the `<@userId>` mentions in a body.
- **The server's check** (`checkCommentsChange`, called from the hub's new `DocPolicy.checkUpdate` hook for each pushed update to a comments doc):
  - The update is applied to a copy of the stored doc (plus the earlier updates in the same push) and the two are compared.
  - Refused: new threads or comments by someone else; editing or deleting someone else's comment (deleting is allowed with full access); moving someone else's thread; changing someone else's reaction; resolving, accepting or rejecting as someone else; changing someone else's suggestion; accepting without edit access; rejecting unless you may edit or it's your suggestion; anything outside `threads`; and updates that depend on changes the server hasn't got (they couldn't be checked).
  - A refused update is handled like any other: the device gets the server's version back.
- **Editor** (`packages/editor/src/comments.ts`):
  - Commented ranges are highlighted (the open thread more strongly). Clicking one opens its thread.
  - **Comment** in the selection toolbar, and `Ctrl+Shift+M`.
  - **Suggest mode:** a `filterTransaction` turns typing, deleting and replacing a selection inside one text block into suggestions. Typing on extends your suggestion, Backspace takes back suggested text first, and deleting next to your deletion grows it. Anything else (formatting, new blocks, moving blocks) is refused. Accepting a suggestion goes through.
  - A suggestion shows its range struck through and its new text underlined after it (a widget, not in the page). The toolbar offers only Comment while suggesting.
  - Highlights are recomputed from the anchors when others' edits or the threads change. Your own edits map them instead, because Yjs only has an edit after the editor's plugins have seen it.
- **App** (`packages/app/src/comments.tsx`):
  - **Comments panel** beside the page, from the header's comments button (with the open count): open and resolved threads, each with its quoted text (or "On deleted text: …"), replies, edit and delete, reactions, resolve and re-open. Clicking a thread scrolls to its text.
  - **Page comments** under the title ("Add comment" next to Add icon and Add cover).
  - **@-mentions:** typing `@` offers the workspace's people; the comment stores `<@userId>` and shows the current name.
  - **Suggest edits:** a page-menu toggle for people who may edit. For people who may only comment it is always on: they can type in the page (as suggestions), but the title and everything else stay read-only.
  - **Suggestions in the panel:** "Replace X with Y", "Add Y" or "Delete X", with Accept (applies it to the page, then marks it accepted) and Reject. The person who suggested it can withdraw it.
- **Also fixed:** after signing in on the desktop, the app kept the local user's id until a restart. It now reloads the user when the sync account changes, so comments (and anything else written as the person) carry the account's id, which the server checks.
- **Also fixed (from M4):** the cursor plugin is now added to the live editor when presence arrives, rather than by rebuilding the editor (which lost its state, such as a block's highlight after following a link to it).
- Comments docs have no page-history versions of their own, and aren't indexed for search.
- **Differs from the plan:**
  - The model is in `@workspace/core`, next to the other doc models, rather than a new `collab` package.
  - Comment bodies are plain text with mentions, not rich text.
  - A suggestion holds plain replacement text for a range within one text block, not a ProseMirror slice across blocks.
  - The UI makes page and text-range comments. Block and row-property anchors exist in the model but nothing creates them yet, and database row pages don't have comments yet.
  - The server's comments index (for the inbox) moves to M6, where it's used. The count in the header comes from the comments doc.
- **Tests:**
  - **Core:** threads, replies, reactions and resolving; a range anchor through someone else's edit, and collapsing when its text is deleted; suggestions created, extended and decided; and the server check (each refusal above, and what is allowed).
  - **Server, over real sockets:** a forged comment and a forged edit of someone else's comment are refused and reset, while each person's own threads and comments are stored.
  - **E2E (`comments.spec.ts`)**, with Ada on a desktop and Bob on the web, who may only comment:
    - Ada selects text, comments and mentions Bob.
    - Bob sees the highlight, opens the thread, replies and reacts. His page shows "Can comment" and a read-only title.
    - Bob types at the end of the text: it becomes a suggestion (Backspace takes back a letter). Ada sees it, the page itself unchanged, and accepts it: the text is in the page for both.
    - Ada resolves the thread, and the highlight goes. She comments on a word with `Ctrl+Shift+M` and then deletes the word: the thread stays, "On deleted text".
    - Bob adds a page comment, which Ada sees under the title.
  - The full desktop E2E passed twice (112 tests each) and the web E2E passed (3 tests).

### M6: inbox and notifications ✅

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

**M6 notes:**

- **Protocol version 4** (`packages/sync`): a server message `notify` carries one notification (JSON, at most 64 KB) to each of the person's connections. `SyncHub.deliver(workspace, user, payload)` sends it; both clients take an `onNotify` option.
- **The model** (`packages/core/src/notifications.ts`): `NotificationData` (kind, page, block or thread, who did it, text, read and archived times, and a reminder's key), `parseNotification` (clients check what arrives), `readPersonMentions` (person mentions with their block), `commentEvents` (new threads, replies with who already took part, and new mentions in edited comments, between two readings of a comments doc), and `zonedTime` and `reminderTime(date, timeZone)` for reminders computed in someone else's time zone. `@remind` mentions carry `userId`: whoever set them.
- **Storage** (migration 8): `notifications` (per person and workspace, read and archived times; a key makes each one happen once), `page_follows` (an explicit unfollow is kept, so editing again doesn't follow again), `reminders` (one person each, with its fire time; a new time fires again), `log_followers` (a cursor per workspace and follower; existing workspaces start at their newest entry, so history notifies nobody), and `users.time_zone`.
- **The notifier** (`apps/server/src/notify/notifier.ts`) follows each workspace's log like the search indexer, scheduled on every append:
  - For each doc changed since its cursor, it takes the doc as it was at the cursor and replays the new updates one author at a time, so each notification has the right author.
  - **Pages:** a new person mention notifies the person (not themselves); whoever edits a page follows it.
  - **Comments:** a mention notifies the person; a new thread notifies the page's followers; a reply notifies them and everyone who took part in the thread. Commenting follows the page. Each person gets one notification per comment (a mention wins).
  - **Reminders:** `@remind` mentions (for the person on the mention, else whoever added it) and date properties with a reminder (for whoever last set them) are stored with their time in that person's time zone. A loop fires the due ones every 30 seconds, also after a restart.
  - **Sharing:** adding a person to a teamspace or to a shared page notifies them.
  - **Access:** nothing is made for someone who can't read the doc, and the list leaves out notifications about docs the person can no longer read.
  - After a compaction the old and new parts of a doc can't be told apart, so that doc's updates notify nobody (its reminders are still updated).
- **REST:** `GET /api/workspaces/:id/notifications` (filters `all`, `mentions`, `unread`, `archived`; with the unread count), `POST …/notifications/read` and `…/archive`, and `GET`/`PUT …/pages/:pageId/follow`. `PATCH /api/auth/me` takes `timeZone`; the desktop sends it when sync goes live, the web app when it loads.
- **App** (`packages/app/src/inbox.tsx`):
  - **Inbox** in the sidebar, under Search, with the unread count, kept current as notifications arrive. Its panel has All, Mentions, Unread and Archived, "Mark all as read", and per item mark read or unread and archive.
  - Clicking an item opens its page: at the mentioned block, or with the comments panel open at the thread (`requestThread`).
  - **Follow page** in the page menu.
- **Desktop** (`apps/desktop/src/main/notifications.ts`):
  - Notifications go to every window, and to the system (libnotify) when no window has focus. The inbox's settings menu turns each kind on or off as a system notification. Clicking one opens what it's about.
  - **Reminders:** while syncing, only the person's own `@remind` mentions remind them locally (offline too). The server's copy of a reminder isn't shown again if the desktop already showed it, and if the server's comes first, the desktop's own stays quiet.
- **Differs from the plan:**
  - The search indexer keeps its own `search_state` cursor; `log_followers` holds the notifier's.
  - No notifications for workspace invites (they're sent by email or link, M1). Groups given access aren't notified one by one.
  - The web app shows the inbox and its live count, but no browser notifications.
  - Assigning someone in a person property doesn't notify them yet.
  - Instead of a separate comments index (moved here from M5), the notifier reads comments docs from the log.
- **Tests:**
  - **Core:** person mentions; comment events for threads, replies (with who took part) and edits; parsing; wall-clock times in time zones (with daylight saving).
  - **Storage:** filters, read and archived; one notification per key; follows that respect an unfollow; reminders replaced per doc and firing again when their time changes; log follower cursors.
  - **Server, over real sockets:** a mention delivered live and listed, but not to someone who can't read the page; a follower mentioned in a new thread told once (as a mention); a reply to whoever took part; read, archived and unfollowed; notifications hidden after losing access; sharing; `@remind` and date-property reminders at 9:00 in their owner's time zone, owned by whoever set them, firing once across server restarts.
  - **E2E (`inbox.spec.ts`)**, with Ada and Bob each on a desktop:
    - Ada mentions Bob: his inbox counts it, and his desktop shows it while he's away. Opening it from the inbox shows the page.
    - Bob comments on the page: Ada, who follows it, is told. The inbox opens the comments panel at the thread.
    - Bob turns off mentions as desktop notifications: the next mention only reaches his inbox.
    - Ada's own `@remind` shows once (the desktop's or the server's), and reaches her inbox. Bob isn't reminded.
  - The full desktop E2E passed twice (117 tests each) and the web E2E passed (3 tests).

### M7: publish to web, server backlinks and history ✅

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

**M7 notes:**

- **Storage** (migration 9): `page_links`, `doc_snapshots` and `history_pending`, `published_pages` (one slug per page, unique across the server), and `page_views` and `page_viewers` (views per day, and who viewed: a user id, or a daily hash for public visitors).
- **Publishing** (`apps/server/src/publish/`):
  - **The page menu's Share dialog** has a Publish section. Publishing gives the page an address (`/p/<slug>`, from its title), and has settings for sub-pages, search engines, and a title and description for search results and link previews. Unpublish is there too. Only someone with full access may publish, change or unpublish.
  - **Rendering:** `/p/<slug>` redirects to the page's file, rendered by the HTML exporter (`exportPages`) from the merged docs, with relative links between the published pages. The render is cached until the workspace's log moves on, and unpublishing drops it at once.
  - **Nothing unpublished leaks:** only the published pages', databases' and rows' docs are loaded. Mentions and links to other pages show as "Private page", as text with no link and no title (a new `outside` option of the exporter). Synced blocks from elsewhere and other databases' rows show nothing.
  - **Files:** a visitor gets a file only if a published page shows it. Files are streamed from storage, under the export's path.
  - **Headers:** a strict CSP, `nosniff`, `no-referrer`, and `noindex` (header and meta tag) unless search engines are allowed. The chosen title and description go into the page's head.
  - Sub-pages that the parent's content doesn't link to are listed under it, so visitors can reach them.
- **Views:** opening a page in the app counts a view (once per page per window), and so does each public visit, with a hash of the IP address and user agent salted per day (no cookie, nothing kept about the visitor). The page menu shows the views and people over four weeks.
- **Backlinks on the server:** the search indexer, which already reads every changed page doc from the log, also stores its links (`readLinks`, the desktop's function) in `page_links`. `GET …/pages/:id/backlinks` returns those from pages the caller can read. The web app turns on backlinks.
- **History on the server** (`apps/server/src/history/keeper.ts`):
  - A log follower notes the docs that changed. Once a doc has been quiet for 10 minutes, it keeps a snapshot, with the users who changed it since the last one (from `doc_updates.user_id`).
  - Snapshots are pruned like the desktop's: everything for a week, then the newest of each day, and nothing older than 90 days. Clients can ask for a snapshot now, before a restore (edit access).
  - The web app turns on page history; restoring runs in the client, as on the desktop.
  - While syncing, the desktop's history shows the server's versions ("Edited by …") next to its own.
- **Differs from the plan:**
  - No custom domains, and visitors can't duplicate a published page as a template yet.
  - The search indexer keeps the links (it reads the same docs); relations aren't among the server's backlinks.
  - A render is invalidated by any change in the workspace, not only to its pages (simpler, and correct).
  - Views show as totals in the page menu, not a chart.
- **Tests:**
  - **Server:**
    - Publishing needs full access.
    - The render is checked for the title and description, the CSP and `noindex`, and the sub-page.
    - Nothing of an unpublished page leaks: no title, synced content or id.
    - Only the image the page shows is served, not another file of the workspace.
    - Edits show in the render; without sub-pages, the sub-page is gone; slugs are unique; unpublishing takes the page down at once.
    - Views count public visitors and people.
    - Backlinks are listed only for readers.
    - History: a snapshot after the quiet time with its author, none without changes, one on request, and nothing for someone who can't read the page.
  - **E2E (`publish.spec.ts`):**
    - Ada publishes a page with a sub-page from her desktop.
    - Someone signed out reads it in a browser and follows the link to the sub-page; the private page shows as "Private page". Their visit and Ada's show in the page menu.
    - Unpublishing returns 404.
    - On the web app, Ada sees the backlink to a page from the server.
  - The full desktop E2E passed twice (121 tests each; a third run in between failed once in an unrelated page-icon test, where closing the app timed out, and that spec then passed three times on its own) and the web E2E passed (3 tests).

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
