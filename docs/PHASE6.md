# Phase 6: Automations and API

**Status:** in progress. M1 (the content role, server edits with an author, and the job queue), M2 (forms), M3 (automations on the server) and M4 (automations on a local desktop, and button webhook and notification steps) are done.

## Context

Phases 0–5 are complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE5.md](PHASE5.md) for collaboration). One Phase 3 check is still open: running the importer on a real Notion export.

Phase 6 goal from the roadmap ([PLAN.md](PLAN.md) §4): **"API conformance tests pass."** The roadmap's scope for this phase, from the feature list (§3):

- **Database automations:** triggers on property changes and on schedules, with actions that set a property, add a page, send a notification or call a webhook.
- **The form view** for databases.
- **A public REST API** compatible in shape with Notion's: pages, blocks, databases and data sources, search and users. It comes with integration tokens and webhooks.
- **The "can edit content" database role,** moved here from Phase 5: rows are writable, the database's properties and views are not.
- **Email notification digests,** moved here from Phase 5 to come with the job queue.

The roadmap budgets 3–4 weeks. The estimate below comes to about 6 weeks, with eight steps: seven milestones and the exit check. If time runs short, cut these, in this order:

1. automations on a local-only desktop (M4)
2. email digests (in M7)
3. the newer `2025-09-03` API version (data sources as their own objects)

**Already in place (reused, not rebuilt):**

- **Date reminders** (in the roadmap's list for this phase) were done in Phase 5 M6. The server fires them, in the person's time zone, to the inbox and the desktop.
- **Server-authored doc edits:**
  - `SyncHub.appendFromServer` (`packages/sync/src/hub.ts`) appends a Yjs update to the workspace log and broadcasts it to everyone connected.
  - Moving pages between scopes (`apps/server/src/scopes/routes.ts`) and the members doc already edit docs this way.
  - Forms, automations and the API write rows and pages through the same path.
- **The database engine** (`packages/database`):
  - `addRow`, `setCell`, `trashRow` and the other row helpers.
  - The query (`query.ts`), filter (`filter.ts`) and sort code, plus formulas, relations and rollups.
  - All of it is pure and runs unchanged on the server.
- **Block content, both ways:**
  - Reading: `readContent` (`packages/exporters/src/content.ts`, with marks and inline nodes) and `readBlocks` (`packages/core/src/blocks.ts`).
  - Writing: `appendContent` and `parseMarkdown` (`packages/editor/src/content.ts`), already used by the importers on a headless schema.
- **Log followers:** the search indexer, the notifier and the history keeper each follow a workspace's log with their own cursor (`log_followers`). Automations and webhooks are two more followers.
- **Access:**
  - `WorkspaceAccess.canWrite` and `checkUpdate` (`apps/server/src/access/service.ts`).
  - `checkUpdate` already validates a comment-role write by applying it to a copy and diffing it (`checkCommentsChange` in `packages/core/src/comments.ts`). The content role is checked the same way.
- **Sharing to a person** (Phase 5 M3). An integration is shared with in the same way, as a bot user.
- **The inbox and notifications** (Phase 5 M6), for the "send a notification" action and for automation failures.
- **Buttons** (Phase 3 M1, `packages/core/src/synced.ts` and `packages/app/src/buttons/run-button.ts`). Their steps are the model for automation actions; buttons gain the webhook and notification steps.

**Not in Phase 6:**

| Item                                                               | Goes to                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Public (OAuth) integrations listed for other workspaces            | Not planned for v1: internal integrations with tokens cover self-hosting                         |
| Automations that call AI, or "send to Slack/Gmail" actions         | Not planned (no AI; the webhook action covers outside services)                                  |
| Automations triggering other automations                           | Not planned: as in Notion, changes an automation makes don't start automations                   |
| Form logic (skip to a question based on an answer), file questions | File questions in M2 if time allows; conditional logic not planned for v1                        |
| A Redis/BullMQ worker                                              | Not needed: the job queue is a Postgres table (see below). Redis can come later if load needs it |

## Architecture

### The job queue: a Postgres table, not Redis

The roadmap planned Redis and BullMQ for the jobs that run outside a request: webhook deliveries, scheduled automations and email digests. A table in the Postgres the server already has does the same job with one less service to run and back up:

- **Table:** `jobs(id, workspace_id, kind, payload jsonb, run_at, attempts, max_attempts, last_error, locked_until, done_at)`.
- **Atomic enqueue:** a job is written in the same transaction as what caused it. For example, the follower's cursor moves forward together with the jobs it found, so a crash never loses or doubles one.
- **Workers:** the server takes jobs with `SELECT … FOR UPDATE SKIP LOCKED`. That is safe even with several server processes, which keeps the door open for running more than one.
- **Retries:** exponential backoff (1 min, 5 min, 30 min, 2 h, 8 h), then the job is marked failed and its owner is told in the inbox.
- **Clean-up:** finished jobs are kept for 7 days for the run logs, then deleted.

The Phase 5 reminder poll (`setInterval` in the notifier) stays as it is. Scheduled automations use the queue.

### Server-authored edits, with an author

`appendFromServer` writes `userId: null` today. It gains an `author` argument, which is either a person or a bot:

- **Forms:** the person who submits, or nobody for an anonymous public form.
- **Automations:** the automation's bot user.
- **The API:** the integration's bot user.

The update log then says who made every change, and history ("Edited by …") shows it.

A helper, `ctx.docs.edit(workspaceId, docId, author, (doc) => …)`, does each edit in four steps:

1. Load the doc's merged state.
2. Run the change.
3. Encode only the difference.
4. Check the difference with the same `checkUpdate` a client push goes through, then append it.

The server's own writes pass the access checks too, so a bug in the API can't write where its caller couldn't.

The `createdBy` and `updatedBy` fields of a row come from the client, and stay that way. Checking them on every push was planned, but legitimate pushes carry other people's ids:

- rows made before sync was turned on carry the desktop's local id
- undo puts back the previous editor
- restoring a version brings back rows made by others

The update log's author (`doc_updates.user_id`, set by the server) is the record that can be trusted, and history shows it.

### The "can edit content" role

The roles become full > edit > **content** > comment > view.

**What content allows, in a database:**

- adding, editing, trashing and reordering rows (the `rows` map), and editing their pages (each row's own doc)
- comments, as with the comment role

**What content does not allow:**

- changing the `schema`, `views` or `meta` maps
- editing the database page itself

On a page that isn't a database or a row, content means comment.

**How the server enforces it:** `checkUpdate` gains `checkRowsChange(before, update)`. Like the comments check, it applies the update to a copy and refuses one that touches anything outside `rows`.

**Why not split the rows into their own doc:** Phase 5 had planned to move rows into a separate `rows:<dbId>` doc, with a migration on every client. Checking the change gets the same result without the migration, and it has a proven model in the comments check. The split stays possible later if large databases need it for performance (Phase 7).

**In the app:** the role appears in the share menu only for databases. With it:

- The views toolbar keeps filters and sorts working as a local, unsaved state, as Notion does for people who can't edit views.
- Property headers can't be renamed or deleted.
- New property and New view are hidden.

### Forms

A form is a new view type, `form`, in the database doc. Its config holds:

- **Questions:** each is a property id, with a label, a description, whether it is required, and its order.
- **The form's own details:** title, description and cover.
- **Who can submit:**
  - people with access to the database (at least comment)
  - anyone in the workspace
  - anyone with the link (public)
- **Afterwards:** a "submitted" message, and an optional notification to the creator for each response.

**Submitting:** the server creates the row, through `ctx.docs.edit` with the submitter as author.

- Someone who can only view the database can still submit to a form that allows it, which is the point of forms. The row is written by the server, not by the submitter's client.
- `POST /api/workspaces/:id/forms/:viewId/submit` checks each answer against its property's type and options. Unknown questions, a missing required answer, wrong types and over-long text are refused (400 with the field).

**Public forms:**

- **Where they live:** `/f/<token>`, a server-rendered page in the style of published pages (Phase 5 M7), with a strict CSP and `noindex`.
- **The token:** random, and stored with the view. A new link can be made, which turns the old one off.
- **No JavaScript:** a plain HTML `<form>` that posts back to the same URL.
- **Spam limits:** a rate limit per IP and per form, a size limit, and a hidden honeypot field.
- **Who can create one:** only someone with full access to the database.
- **Submitter:** "Anonymous" (`createdBy: null`), or the signed-in person if they have a session.

**In the app:**

- **The form builder** is the view itself. Questions can be dragged, added from the properties, or added as a new property.
- **Preview and Fill** submits from the app.
- **Share form** offers the audience settings and the link.

**On a local-only desktop:** the form can be filled in the app, as a local edit. Links and audiences need a server, so they are hidden there (`Platform.features`).

**Answer types:** text, number, select, multi-select, status, date, checkbox, URL, email, phone and person. Files are added if time allows, through the existing upload endpoint with a form-scoped upload token. Computed properties (formula, rollup, created/edited, unique ID, button) can't be questions.

### Automations

An automation belongs to a database. It is stored in the database doc's `automations` map, so it syncs, shows in history, and is copied with the database. It holds:

- **Triggers** (any one of them starts it):
  - a page is added
  - a property is edited, optionally "to" a value (e.g. Status is Done)
  - every day, week or month at a time, in a time zone
- **Conditions:** an optional filter on the page, reusing the view filter model and `filter.ts`.
- **Actions,** run in order:
  - **Edit property:** on the page that triggered it, or on all pages of another database matching a filter, to a value. Values can be fixed, "now", "the person who triggered it", or copied from the page.
  - **Add page to** a database, with values.
  - **Send notification** to people, or to the people in a person property.
  - **Send webhook:** an HTTPS POST to a URL, with the page's properties as JSON and custom headers.
  - **Send email:** only when SMTP is configured.
- **Settings:** `enabled`, `createdBy`, and the bot user it acts as.

**Where it runs.** `packages/automations` is pure and does no I/O:

- `matchTriggers(before, after, automation)` diffs the row snapshots before and after a change, the way `commentEvents` does in Phase 5.
- `planActions` turns the actions into concrete edits and jobs.

It has two hosts:

- **The server** (M3), an `automations` log follower. For each change it diffs the database's rows, finds the automations it triggers, and enqueues one job per run. The job applies the edits through `ctx.docs.edit`, as the automation's bot user, and enqueues webhook and email jobs.
  - Scheduled triggers are queue jobs that enqueue their next run when they finish.
- **The desktop main process** (M4), for a workspace that isn't synced. It does the same from local doc changes:
  - Webhooks are sent from the main process.
  - Schedules run while the app is open, with a missed run caught up at start.
  - In a synced workspace, the desktop leaves automations to the server.

**Rules:**

- **No loops:** a change made by an automation (its author is an automation bot) never triggers automations. A run's edits are attributed to that bot.
- **Permissions:** an automation acts with the access of the person who made it. If they lose edit access to a database the automation touches, it pauses and they are told.
- **Batching:** several changes to one page within 3 seconds count as one, so typing a title doesn't fire once per keystroke. This matches Notion's own delay.
- **Run log:** each automation keeps its last 50 runs (when, trigger, outcome and error), shown in its settings.
- **Failures:** a webhook that keeps failing marks the run failed and tells the automation's creator in the inbox. After 10 failed runs in a row, the automation turns itself off.

**Buttons** gain the same "Send webhook" and "Send notification" steps. A button runs in the app, so in a synced workspace these steps call the server (`POST /api/workspaces/:id/buttons/webhook`, which checks that the person can edit the page). On a local-only desktop, the main process sends them.

### Webhooks leave the server safely

Webhook actions, button webhooks and integration webhooks (M7) all go out through one `deliver` job:

- **HTTPS only,** except to `localhost` when `WEBHOOK_ALLOW_HTTP` is set (for development).
- **No private or local addresses:** after DNS resolution, loopback, private, link-local, CGNAT and metadata addresses are refused. The check runs on the resolved address, at connect time, so DNS rebinding can't get round it. `WEBHOOK_ALLOW_PRIVATE` turns this off for a self-hosted server that needs to reach its own network.
- **Limits:** no redirects followed, a 10 s timeout, a 1 MB request body, and response bodies are read only up to 4 KB, for the run log.
- **Signature:** every delivery is signed with HMAC-SHA256 of the body, using a secret per automation or per subscription, sent as `X-Notion-Signature: sha256=…`.

### The public API

**Notion-compatible shape.** The API is Notion's, at `/v1/…` on the server's own domain. This lets existing integrations and the official SDKs (`@notionhq/client` with `baseUrl`) work against it. The `Notion-Version` header picks the shape:

- **`2022-06-28`:** databases are queried directly (`POST /v1/databases/:id/query`). This is the version most existing code uses.
- **`2025-09-03`:** a database has data sources (`GET /v1/data_sources/:id`, `POST /v1/data_sources/:id/query`). Each of our databases has exactly one data source, with its own id that maps to the database. Linked views are not data sources.

**Endpoints:**

- **Users:** `GET /v1/users`, `GET /v1/users/:id`, `GET /v1/users/me` (the bot).
- **Pages:**
  - `POST /v1/pages` (in a page or a database, with properties, children, icon and cover)
  - `GET /v1/pages/:id`, `PATCH /v1/pages/:id` (properties, icon, cover, `in_trash`/`archived`)
  - `GET /v1/pages/:id/properties/:propertyId`, paginated for titles, rich text, relations and rollups
- **Databases:**
  - `POST /v1/databases`, `GET /v1/databases/:id`, `PATCH /v1/databases/:id` (title, properties)
  - `POST /v1/databases/:id/query`, with Notion's filter and sort JSON (compound `and`/`or`, nested two deep, as Notion allows)
- **Data sources** (`2025-09-03`): retrieve, query, create and update.
- **Blocks:**
  - `GET /v1/blocks/:id`, `PATCH /v1/blocks/:id`, `DELETE /v1/blocks/:id`
  - `GET /v1/blocks/:id/children`, `PATCH /v1/blocks/:id/children` (append, with `after`)
- **Search:** `POST /v1/search`, with a query, a filter by object type, a sort by last edited time, and pagination.
- **Comments:** `GET /v1/comments?block_id=`, `POST /v1/comments` (on a page, or in a discussion).

**Notion's conventions:**

- **Pagination:** `start_cursor`, `page_size` (≤ 100), `has_more` and `next_cursor`.
- **Errors:** `{object: "error", status, code, message}`, with Notion's codes: `invalid_json`, `invalid_request_url`, `invalid_request`, `validation_error`, `missing_version`, `unauthorized`, `restricted_resource`, `object_not_found`, `conflict_error`, `rate_limited`, `internal_server_error`.
- **Limits:**
  - 2,000 characters per rich-text item
  - 100 blocks per append, two levels deep
  - 1,000 block elements and 500 KB per request
  - 3 requests per second per integration on average, with bursts; `429` with `Retry-After` beyond that
- **Ids:** UUIDs; dashed and undashed forms are both accepted.

**Conversion.** `packages/api-model` is pure and maps between our docs and Notion's JSON:

- **Rich text:** our marks (bold, italic, strikethrough, underline, code, color, link) and inline nodes (page mention, person mention, date mention, inline equation) map to Notion's `rich_text` items with `annotations`.
- **Blocks** map type by type: paragraph, headings 1–3 (with `is_toggleable`), bulleted, numbered and to-do items, toggle, quote, callout, divider, code, equation, image, video, audio, file, pdf, bookmark, embed, table and table rows, column lists and columns, child page, child database, synced block, link to page, table of contents and breadcrumb. Anything else reads as `unsupported`.
  - **Block ids:** our blocks need stable ids, which they don't all have today. M6 adds a `blockId` attribute to every top-level and nested block node. It is set when a block is created, and once for existing blocks when a doc is first read by the API, as a server edit.
- **Properties:** every property type, both ways. Computed values (formulas, rollups, created and edited times and people, unique IDs) come out in Notion's shapes and are refused on write, as Notion does.
- **Files:** our attachments come out as `file` objects with a URL signed for one hour (`/api/files/…?sig=`). External URLs come out as `external`.

**Writes.** API writes go through `ctx.docs.edit` as the integration's bot user. The server now depends on `@workspace/editor` for its headless schema (`appendContent`), as the importers do: ProseMirror only, no DOM.

### Integrations and tokens

An internal integration belongs to a workspace and is made by an owner or admin, in Settings → Integrations.

**Its bot user:**

- Each integration is a bot user (`users.kind = 'bot'`), and a member of the workspace with the `bot` role.
- It is in the members doc, so mentions and "Edited by" show its name and icon.
- It is not counted as a person, can't sign in, and gets no notifications.

**Its token:**

- The token is shown once and stored hashed (`integration_tokens`). It can be rotated, which turns the old one off at once.
- It starts with `ntn_` so existing tooling recognises it.

**Capabilities**, checked on every request (`restricted_resource` otherwise):

- read content, update content, insert content
- read comments, insert comments
- user information: none, without emails, or with emails

**Access, as in Notion:**

- An integration sees only pages shared with it: in a page's menu, Connections → Add, which is a share to its bot user, at edit or view access.
- Sharing is inherited down the tree, as for people. The same `AccessService` decides, so an integration can never see more than what was shared with it.
- Search returns only those pages.

**API keys are not sessions.** They are refused on every `/api/…` route, and session cookies are refused on `/v1/…`. CSRF doesn't apply, since there is no cookie.

### Integration webhooks

An integration can have one webhook subscription: a URL plus the events it wants. It works like Notion's:

- **Verification:** when it is set up, the server POSTs a `verification_token`. An admin pastes that token into the integration's settings to turn deliveries on. The token is also the signing secret (`X-Notion-Signature`).
- **Events:**
  - `page.created`, `page.properties_updated`, `page.content_updated`, `page.moved`
  - `page.deleted`, `page.undeleted`, `page.locked`, `page.unlocked`
  - `database.created`, `database.schema_updated`, `database.deleted`
  - `comment.created`, `comment.updated`, `comment.deleted`
- **Payload:** ids only (entity, workspace, author and timestamp). The receiver fetches what it needs through the API, as with Notion.
- **Source:** a `webhooks` log follower. It sends events only for pages the integration can read, at the time they are sent.
- **Batching:** content updates to one page within a minute are merged into one event.
- **Delivery:** through the `deliver` job, with retries for 24 hours. A subscription whose deliveries fail for 3 days is paused, and the integration's owner is told.

### Email digests

When SMTP is configured, people get an email for inbox items they haven't seen (Phase 5 M6), as a queue job:

- **When:** immediately for mentions (after 10 minutes unseen), or daily, or never. This is a per-person setting.
- **One email per person:** it covers all the unread items at that point, so there is never one email per comment.
- **Contents:** only the titles of pages the person can still read, rechecked when the email is sent.
- **Unsubscribe:** a one-click link (`List-Unsubscribe`, RFC 8058).

## Milestones

### M1: the content role, attributed server edits, the job queue ✅

**Server:**

- **Authors on server edits:** `appendFromServer` takes an author (stored as `doc_updates.user_id`).
- **`DocEditor` (`ctx.docs`, `apps/server/src/docs-edit.ts`):**
  - **One edit:** it loads a doc's merged state, runs a change, and keeps only the updates the change made (none: nothing is stored).
  - **The checks:** for someone (a person, later a bot), the result passes the same `canWrite` and `checkUpdate` as their own client's push, or the edit throws `EditRefused`.
  - **Trusted edits** (the caller decided, e.g. a form's audience) must say where a new doc goes. An unplaced doc would be readable by anyone, so one is never left unplaced.
  - Edits to one doc run one at a time.
- **The `content` role** ranks between edit and comment.
  - **Allowed:** a database doc (but only changes to its rows), its rows' pages (including a new row's page in the same push as the row), and comments.
  - **Elsewhere** in the scope it acts as comment.
- **`checkRowsOnlyChange`** (`packages/database/src/check.ts`) decodes the update and finds, for every item it adds or deletes, which top-level map that item is in. Anything outside `rows` is refused, including a row edit bundled with a schema edit, and updates that depend on changes the server lacks.
- **Rows the access service knows:** it learns which docs are databases, and the rows of each, as it reads them. A row's page it hasn't seen is looked for in the scope's databases, for someone with "content" only, and only on a miss.
- **Not done:** checking `createdBy`/`updatedBy` on pushes (see above for why).

**Storage:** migration 10:

- **Constraints:** the role is added to the role checks.
- **`users.kind`:** `person` or `bot`.
- **The `jobs` table** and `store.jobs`:
  - enqueue, optionally in a transaction
  - claim (with `SKIP LOCKED`; the attempt counts when claimed)
  - complete, with a result
  - fail, with a retry time or giving up
  - one open job per key
  - clean-up: a job whose last attempt's worker died is marked failed, and finished jobs are deleted after a week
- **The `JobRunner`** (`apps/server/src/jobs/runner.ts`, `ctx.jobs`) holds a handler per kind and polls for due jobs. It retries after 1 min, 5 min, 30 min, 2 h and 8 h. `PermanentJobError` gives up at once. `main.ts` starts it after listening.

**App:**

- "Can edit content" is offered in the share dialog for databases. Access rows show the role, and offer it for databases.
- **What the role sees in a database:**
  - Rows are editable.
  - The views and properties are shown as locked: no new property or view, and no database settings or description.
  - Select options can't be created or edited, whether in the cell editor or by pasting.
  - Formulas can't be edited.
  - Row pages are editable.
  - The badge reads "Can edit content".
- **Filters and sorts of your own:** someone who can't save a view (this role, a viewer, a locked database) can still filter and sort it. The change applies only in that window, marked "Only you see these", with Reset.
- **Fixed along the way:** an inline database ignored the person's role (it was always editable, and the server refused the edits). It now follows the role, title included.

**Tests:**

- **`check.test.ts`:** row adds, edits, moves, trashing and deletes are allowed. Properties, views, settings, unknown parts, a mixed update, a deletion-only schema change, pending updates and malformed input are refused.
- **`content-role.test.ts`** (real server):
  - **Over the socket:** Gus, with "content", edits a row, adds a row with its page in one push, writes a row's page and comments. His new property and his renamed view are undone, and so are his edits to a non-row page and to the tree. A new doc that isn't a row's page isn't stored.
  - **Through `app.docs`:** a row is added as Gus and arrives live on Ada's device, with Gus as the author in the log. His property and his non-row edit are refused. Five concurrent edits to one doc keep all five rows. A trusted edit without a scope is refused; with one, the doc is placed and reaches Gus.
  - **The runner:** results are kept, a flaky job succeeds on its third try, and a permanent failure stops at once.
- **`jobs.test.ts`:**
  - order and locking
  - eight claims from two stores on 40 jobs take each once
  - retry, then give up
  - a crashed worker's job runs again, and its last attempt is marked failed
  - keys
  - enqueue in a rolled-back transaction leaves nothing
  - clean-up and recent jobs

**E2E** (`content-role.spec.ts`):

- Ada shares "Tasks" with Bob as "Can edit content" from the share dialog.
- On his desktop, Bob sees the badge, and no Add a property, Add a view or database options.
- He adds a row, which Ada sees live.
- Typing a new tag offers no "Create".
- His filter shows "Only you see these", and Ada's view stays unfiltered.

**Fixed along the way: the role on the wire.** Roles are sent by index. "content" first went in the middle of the list, so a client built before it read "comment" as "view". It now goes at the end, and the sync protocol moves to version 5: older clients are told to update instead of misreading the new role.

**Runs:**

- **Desktop E2E, run 1:** 130 of 131 passed.
- **Run 2:** 129 of 131. The failures were in two tests:
  - **The locked-view test** (both runs) still expected Filter to be disabled. A locked view now filters for that window only, and the test checks that.
  - **The page cover test** (run 2): the worker took too long to close, a flake also seen in Phase 5.
- **Reruns:** both specs, three times each, passed 30 of 30.
- **Web E2E:** 3 of 3.

### M2: forms ✅

**Changed from the plan:**

- **Two audiences, not three:**
  - **"People who can see this database"** fill the form in the app.
  - **"Anyone with the link"** use the public page.

  "Anyone in the workspace" would need a signed-in link page for people who can't see the database; it is left for later.

- **Where the public link's token lives:** in the database (`form_links`), never in the doc. Anyone who can read the database could otherwise copy it, and making a new link must turn the old one off.
- **Questions are reordered** with up and down buttons, not dragged.
- **Not done:** file questions, and a cover on the form.

**Model** (`packages/database`):

- **The view type:** `form`, with `FormConfig` on every view (title, description, questions, audience, the message after submitting, `notify`, `createdBy`). A new form view asks every property it can, title first (`defaultForm`).
- **`validateSubmission(properties, form, answers, { members })`** returns the row's title and stored values, or an error per question. It refuses:
  - anything that isn't a question
  - a missing required answer (a required checkbox must be ticked)
  - text over 2,000 characters
  - URLs that aren't http(s), emails and phone numbers that don't look like one
  - options that don't exist
  - people who aren't members (or any person, when no members are given)
  - computed and file properties
- **`answersFromFields`** reads an HTML form post: numbers are parsed, checkboxes are ticked when present, and repeated fields become lists.

**Server:**

- **Migration 11:** `form_links` (one token per form), and the `form` notification kind.
- **`POST /api/workspaces/:id/forms/:databaseId/:viewId/submit`:**
  - **Who:** anyone who can see the database (view is enough: the server writes the row, as a trusted `DocEditor` edit with the submitter as author).
  - **Errors:** 400 with the errors, and nothing is written.
  - **Not found:** 404 for a non-member or a view that isn't a form.
- **`GET`, `PUT`, `DELETE …/link`:**
  - Anyone who can see the database can read the link.
  - Only someone with full access can make a new one (the old one stops working) or turn it off.
- **`GET` and `POST /f/<token>`:**
  - **When it works:** only while the form's audience is "anyone with the link" and the token is current; otherwise 404.
  - **The page:** plain HTML, no script, `noindex`, and a strict CSP (`default-src 'none'`, `form-action 'self'`).
  - **Person questions** aren't asked there.
  - **Errors:** a refused post shows the form again, with the errors and what was typed.
  - **Spam:** a hidden honeypot field (filled in, nothing is kept), and 10 posts a minute per address.
  - **The row:** anonymous (`createdBy: null`).
- **Notifications:** "Notify me of each response" sends the form's maker a `form` notification (inbox, and desktop notifications) for responses by others.

**App:**

- **The form view**, offered in "Add a view".
- **Edit form** (for people who can edit the database): title and description; questions with a label, a description and Required; reorder and remove; add a question from a property or as a new property; the message after submitting; notify me.
- **Preview / fill:** an input per type.
  - On a server, the response goes to the server.
  - In a workspace that isn't synced, the row is added locally.
- **Share form** (on a server): who can fill it in, and the link (create, copy, new link, turn off).
- **Elsewhere:** a form has no filter, sort or New toolbar. The inbox says "… responded to <form>". The desktop allows the forms routes.

**Tests:**

- **`forms.test.ts` (database):** a new form's questions; valid answers become values; every kind of wrong answer; dropped properties; HTML posts.
- **`forms.test.ts` (server):**
  - **From the app:** a view-only member's response is written by the server, arrives live, and has its author and a notification for the maker. Bad answers write nothing. A non-member, or a table view, is 404.
  - **Public links:** only full access makes one. A link shows nothing until the form is public. Then the page has its CSP and no script, and doesn't ask person questions.
  - **Public posts:** a response becomes an anonymous row. A missing required answer comes back with what was typed. An extra field is refused. The honeypot keeps nothing.
  - **Changing the link:** a new link ends the old one, and turning it off ends it.
  - **Rate limit:** the 11th post a minute is refused.

**E2E** (`forms.spec.ts`):

- Ada builds "Order a part" on her desktop: a renamed, required title question and a new number question.
- She answers it in the app; leaving out the required answer is refused first.
- She shares it with anyone who has the link. Someone signed out answers it in a browser.
- The row appears on her desktop, and her inbox says "Someone responded to Order a part".

**Runs:**

- **Unit tests:** 841 passed (3 skipped).
- **Desktop E2E:** run twice, 133 of 133 each time.
- **Web E2E:** 3 of 3.

### M3: automations on the server ✅

**Changed from the plan:**

- **No `packages/automations`:** the model is `packages/database/src/automations.ts`. It needs the database's rows, filters and values, and nothing else uses it.
- **Delay:** a run starts 3 s after the change that triggers it (a job's `runAt`), and reads the page then. Several edits to a page in that time give one run per automation and change.
- **Run log:** the automation's last runs come from the job queue (`automation.run` jobs, which the queue keeps for a week), not a separate table.
- **Not done (left for later):**
  - "Edit pages in another database, matching a filter".
  - Send email.
  - Turning an automation off after 10 failed runs in a row.
  - The conditions editor: the model and the server apply a condition, but the panel can't set one yet.
  - A scheduled automation's actions act on no page: they can add a page, notify and send a webhook.
- **Moved to M4:** the Send webhook and Send notification steps on buttons.

**Model** (`packages/database/src/automations.ts`):

- **Stored** in the database doc's `automations` map: name, `enabled`, `createdBy`, a trigger, an optional condition (a view filter) and actions.
- **Triggers:**
  - a page is added (not a template)
  - a property is edited, optionally to a value
  - a schedule: every day, week or month, at a time, in a time zone
- **Actions:**
  - **Edit property** on the page.
  - **Add a page** to the database.
  - **Notify** people, and the people in a person property.
  - **Send a webhook.**
- **Values:** fixed, now, the person who triggered it, or copied from a property of the page.
- **Functions:**
  - `triggeredBy(automations, before, after, …)` compares the rows before and after a change.
  - `planActions` turns a run into effects.
  - `nextRun(schedule, after)` works in the schedule's time zone, so DST doesn't move it.

**Server:**

- **Migration 12:** `automation_secrets`, the `automation` notification kind, and an index for runs by workspace and kind.
- **The `automations` log follower:**
  - **What it reads:** the changes to databases that have automations, one author's run of updates at a time, with the row state before and after.
  - **Skipped:** compacted history, and changes made by the bot.
  - **What it queues:** one `automation.run` job per start, in the same transaction as the follower's position. It also keeps each schedule's next `automation.schedule` job queued.
- **The automations bot:** each workspace has one, with an id derived from the workspace. The members doc lists it as a removed member named "Automations", so its edits show a name and it can't sign in.
- **A run:**
  - **Pausing:** if the maker can no longer edit the database, the run stops and tells them ("Paused…", once per automation).
  - **Edits:** made through `ctx.docs.edit`, checked as the maker and recorded as the bot. So they pass the same checks as the maker's own client, and they start no automations.
  - **Notifications:** go to the inbox.
  - **Webhooks:** each one is a `webhook.deliver` job.
  - **Failures:** a run that fails stays failed (no retry).
- **Webhooks out** (`webhooks/deliver.ts`):
  - **Address check:** HTTPS only; private, loopback, link-local, CGNAT and metadata addresses are refused. The check is on the resolved address, and the connection is made to that same address.
  - **Limits:** no redirects, 10 s, a 1 MB body, and 4 KB read back.
  - **Signature:** `X-Notion-Signature: sha256=<hmac>`, with the automation's secret.
  - **Retries:** a 5xx, a 429 or a network error is retried with the queue's backoff (5 tries). Any other 4xx fails at once. On the last failure, the maker is told.
  - **Overrides:** `WEBHOOK_ALLOW_PRIVATE` and `WEBHOOK_ALLOW_HTTP` relax the checks for a server on its own network.
- **REST:**
  - `GET …/automations/:databaseId/:automationId/runs`: anyone who can see the database.
  - `…/secret`: only people who can edit it.

**App:**

- **The ⚡ Automations button** in a database's toolbar. It is shown on a server to people who can edit the database.
- **The list:** on/off, edit and delete.
- **The editor:**
  - name and trigger ("Set to" for a property; the day, time and time zone for a schedule)
  - actions, each with its values
  - people to notify, and a message
  - the webhook URL
  - the recent runs
- **Elsewhere:** the inbox says "Automation <name>", and desktop notifications do too. The desktop allows the automations routes.

**Tests:**

- **`automations.test.ts` (database):**
  - stored in the doc
  - page added: not for templates or edits
  - "set to" fires once
  - conditions
  - every kind of value
  - schedules across DST
- **`automations.test.ts` (server):**
  - **"When Status is set to Done":** Completed and Owner are set and Ada is told. It runs once, and the bot is the author.
  - **No loops:** an automation that edits the property it watches runs once.
  - **Pausing:** a maker who loses edit access pauses the automation and is told.
  - **Webhooks:** signed, and retried after a 500. The secret is for editors only.
  - **Schedules:** they run at their time, and the next one lines up.
  - **Delivery:** refuses private addresses and http unless allowed; doesn't follow redirects; gives up on slow receivers.

**E2E** (`automations.spec.ts`):

- Ada makes "Log new tasks" on her desktop: when a page is added, set Logged to now, notify her, and send a webhook to a local receiver.
- She adds a task. Logged fills in live, and her inbox says "Automation Log new tasks".
- The receiver gets one POST, with the page and a valid signature.

**Runs:**

- **Unit tests:** 854 passed (3 skipped).
- **Desktop E2E:** run twice, 135 of 135 each time.
- **Web E2E:** 3 of 3.

### M4: automations on a local-only desktop, and button steps ✅

**Changed from the plan:**

- **Where the host lives:** `LocalAutomations` is in `packages/storage-local`, next to the doc manager it follows, so it has unit tests. The desktop's main process only wires it up (`apps/desktop/src/main/automations.ts`).
- **The test clock:** E2E moves the host's clock forward (`__automationClockOffset`, and `WORKSPACE_AUTOMATION_CLOCK_OFFSET_MS` at start) instead of `AUTOMATION_CLOCK`.
- **Button webhooks:** signed with one secret per workspace (not per button). Anyone who can edit some page can see it (they could add a button anyway).
- **Not done:** an inbox for a local workspace. A local automation's or button's notification is a desktop notification.

**The desktop host** (`LocalAutomations`):

- **Following changes:**
  - Each database with automations keeps a starting copy, taken when it's loaded or when its first automation appears (`DocManager.onLoad`, new).
  - Changes are looked at 3 s after they stop, against that copy, with `triggeredBy` as on the server; then the copy moves on.
- **No loops:**
  - What an automation writes has its own origin (`AUTOMATION_ORIGIN`). It goes straight into the starting copy, so it's never seen as a change.
  - Before it writes, changes still waiting are looked at first, so the copy is never behind.
- **Runs:**
  - One at a time, with `planActions` as on the server.
  - Edits act as the automation's maker.
  - "Notify" shows a desktop notification.
  - The run log is the last 200 runs, kept in settings.
- **Schedules:**
  - Each counts from its last run (a new or changed one counts from now).
  - They run while the app is open (checked at least every minute).
  - One missed while the app was closed runs once at the next start, not once per missed time.
- **Webhooks:**
  - Sent from the main process, signed with the automation's secret (`X-Notion-Signature`, as on the server).
  - Tried again after a network error, a 5xx or a 429 (5 s, 30 s, 2 min). A failure shows a notification.
  - There is no private-address guard: it's the person's own computer and network.
- **Hand-over:**
  - While the workspace syncs, the server runs automations. The host only keeps its copies up to date, so turning sync off doesn't replay old changes.
  - Turning sync on uploads the database docs, and the server's follower picks up their automations and schedules.

**Button steps** (`packages/core` `ButtonStep`):

- **New steps:**
  - **Send webhook:** a URL. It POSTs `{source: {type: 'button', pageId, userId}, data, triggeredAt}`, where `data` is a row's title and properties, or a page's title.
  - **Send notification:** people and a message.
- **On a server:**
  - `POST /api/workspaces/:id/buttons/webhook`: queued as a `webhook.deliver` job, through the same guard, retries and signature as an automation's. If it fails for good, the person who pressed it is told.
  - `POST …/buttons/notify`: only members who can see the page are told (an `automation` notification titled with the button's label).
  - Both need someone who can edit the doc the button is in (the page, or a button property's database).
  - `GET …/buttons/secret` gives the button secret.
- **On a local desktop:** the main process sends the webhook and shows the notification.

**App:**

- **The ⚡ Automations button** is offered on a local desktop too. Its run log and "Show signing secret" come from the server or from the device.
- **The button editor** offers Send webhook (with "Show signing secret") and Send notification, wherever there's a server or a device to send them.
- **Fixed:** whether there's a server to ask (`useTeam`) is now in the app context. The form view used the platform's team API, which the desktop always has, so filling in a form on an unsynced desktop went to the server and failed (M2).
- **Fixed in `DocManager.close`:** it now flushes before clearing the delayed-index timer, since a flush can start a new one.

**Tests:**

- **`automations.test.ts` (storage-local):**
  - **"Set to Done":** Completed is set and the person is told, once, and windows see it.
  - **No loops:** an automation that edits the property it watches runs once.
  - **Webhooks:** signed, tried again after a 500; a 404 isn't, and its failure is shown.
  - **While syncing:** nothing runs.
  - **Schedules:** they run at their time, and one missed while closed runs once.
  - **Origin:** an automation's edits carry its origin.
- **`automations.test.ts` (server), button steps:**
  - A button webhook is signed with the button secret.
  - A bad URL gets a 400, and an unknown page a 404.
  - A notification reaches a member and skips a non-member.
  - People who can only view can't press (403).

**E2E** (`local-automations.spec.ts`, no server):

- **Page added:** "Log chores" fills in Logged, shows a notification, and sends a webhook whose signature matches the secret the editor shows. The run log says Done.
- **Schedule:** a daily schedule runs once the clock passes its time. After restarting four days later, it runs once more (not three times).
- **Button:** "Ping the lab" sends a signed webhook with the page's title, and a notification.

**Runs:** see below.

### M5: integrations, tokens, and the API core (≈ 6 days)

- **Storage:** migration 11, the `integrations` and `integration_tokens` tables; bot users in the members doc.
- **Settings → Integrations** (owners and admins): new, name and icon, capabilities, the token shown once, rotate, delete.
- **Connections in the page menu:** share a page with an integration.
- **The `/v1` server plugin:**
  - **Auth:** bearer `ntn_…`, hashed lookup, capabilities.
  - **Versions:** the `Notion-Version` header (missing → `missing_version`).
  - **Notion conventions:** the error shapes, pagination, the rate limiter per integration, and request size limits.
- **`packages/api-model`:** properties both ways, rich text both ways (the property side; blocks are M6), filters and sorts (Notion JSON → our filter model), page and database objects.
- **Endpoints:** users, pages (create in a database or a page, retrieve, update, trash, property items), databases (create, retrieve, update, query), data sources (`2025-09-03`), and search.
- **Tests:**
  - each endpoint, against the shapes in Notion's API reference
  - every property type, both ways
  - filters: each operator, compound and nested
  - access: an integration sees only what was shared with it, through inheritance and after an unshare
  - capabilities, rate limits, version handling
  - a token used on `/api` is refused, and a cookie on `/v1`

### M6: blocks, comments and files in the API (≈ 4 days)

- **Block ids:** a `blockId` attribute on block nodes (in `@workspace/editor` and `@workspace/core`), set on creation and once for existing blocks.
- **`packages/api-model`:** blocks both ways for every type listed above; `unsupported` for the rest; nesting (children, two levels per append).
- **Endpoints:**
  - blocks: retrieve, update, delete, list children, append children (with `after`)
  - comments: list, create on a page or in a discussion
  - page creation with `children`
- **Files:** signed file URLs for `file` objects; external files kept as URLs.
- **Tests:**
  - **Round trip:** a page made in the app is read through the API, written to a new page, and read back with no loss in any block type.
  - **Concurrency:** appends while someone edits the same page live both survive (Yjs merges, and the server edit is a normal update).
  - block ids stay stable through edits.

### M7: integration webhooks and email digests (≈ 3 days)

- **Webhooks:** the subscription settings and verification, the `webhooks` log follower and its events, merged content updates, access filtering at send time, delivery and pausing.
- **Email digests:** the per-person setting (immediate for mentions, daily, never), the digest job, one email per person, `List-Unsubscribe` and the unsubscribe route.
- **Tests:**
  - each event fires once for its change, and never for pages the integration can't read
  - the signature verifies with Notion's documented method
  - digests: one email per person, nothing about pages they've lost access to, unsubscribe works (a local SMTP sink, as Phase 5's invite tests use)

### Exit check (≈ 2 days)

- **API conformance:** `apps/server/src/api.conformance.test.ts` drives the server with the official `@notionhq/client` SDK, pointed at it with `baseUrl`, against both versions. Each step's response must match the SDK's types and Notion's documented shapes:
  1. Create a database with every writable property type, add pages with values and content, and query with nested filters and sorts.
  2. Paginate the results; append, update and delete blocks; comment.
  3. Search, list users, and handle the errors (`object_not_found` for unshared pages, `validation_error`, `rate_limited` with `Retry-After`).
- **A real-world check:** a few published open-source Notion API scripts (e.g. a CSV importer and a Markdown exporter that use the SDK) run against the server unchanged, to the same result as against Notion. Their output is compared.
- **Scenario E2E:**
  - An integration made in Settings is shared with a database.
  - An outside script adds a page through the API, which appears live on a desktop.
  - The page's automation runs, its webhook reaches a test receiver, and the integration's own webhook reports `page.created` and `page.properties_updated`.
  - A public form submission starts the same automation.
  - A content-role member can edit rows but not the schema.
- **The Docker stack:** the API, a webhook, and a public form through Caddy with TLS.

## Packages

```
packages/
  automations/     new: automation model, trigger matching, action planning (no I/O)
  api-model/       new: Notion-shaped JSON <-> our docs (properties, rich text, blocks, filters)
  database/        the form view, submission validation, the rows-only check
  storage-remote/  jobs, integrations and tokens, bot users
apps/
  server/          ctx.docs.edit, job queue workers, automations and webhooks followers,
                   forms (/f), the /v1 API, digests
```

New dependencies:

- `@notionhq/client`, as a dev dependency only, for the conformance tests
- no Redis; no new runtime services

## Critical files

- **New:**
  - `packages/automations/src/{model.ts, triggers.ts, actions.ts}`
  - `packages/api-model/src/{rich-text.ts, properties.ts, blocks.ts, filters.ts, objects.ts}`
  - `apps/server/src/{jobs/*, docs-edit.ts, forms/*, automations/*, api/*, webhooks/*, digests/*}`
  - `packages/app/src/{database/form-view.tsx, database/automations/*, integrations-settings.tsx}`
- **Modified:**
  - `packages/sync/src/hub.ts`: `appendFromServer` with an author
  - `apps/server/src/access/{roles.ts, service.ts}`: the content role and `checkRowsChange`
  - `packages/database/src/schema.ts`: the `form` view type and the `automations` map
  - `packages/core/src/synced.ts`: button webhook and notification steps
  - `packages/editor/src/*`: block ids
  - `apps/desktop/src/main/sync/ipc.ts`: new team routes (forms, automations, integrations)
  - `packages/storage-remote/src/migrations.ts`: migrations 10 and 11

## Verification

- **Unit tests (Vitest):**
  - trigger matching, conditions and action planning
  - form validation for every property type
  - Notion JSON conversion both ways: properties, rich text, blocks and filters
  - the rows-only check
  - the webhook address guard
- **Integration tests (Vitest + throwaway Postgres):**
  - the job queue under concurrency and crashes
  - the authorization matrix with the content role and bots
  - each API endpoint
  - followers (automations, webhooks) through catch-up
  - digests
- **Conformance:** the official SDK against the server, both versions.
- **E2E (Playwright):** forms, automations, integrations and the content role across desktops, the web app and a signed-out browser, plus the exit check scenario as its own spec.
- **Before every push:**
  - `pnpm lint`, `pnpm typecheck`, `pnpm test` and the Prettier check
  - the desktop E2E, run twice
  - the web E2E
- **Security review before sign-off:**
  - tokens are hashed and scoped by capability
  - an integration sees only what's shared with it
  - every server-authored write passes the same checks as a client's
  - webhooks can't reach private addresses
  - public forms write only answers to their own questions
  - no automation acts beyond its creator's access
