# Phase 4: Sync server

**Status:** M1 and M2 done. M3 next.

## Context

Phases 0–3 are complete on the branch `ccr-9cd9bc27-ksa6p1` (see [PHASE1.md](PHASE1.md), [PHASE2.md](PHASE2.md) and [PHASE3.md](PHASE3.md)). Phase 3's exit check still needs one step: running the importer on a real Notion export.

Phase 4 goal from the roadmap ([PLAN.md](PLAN.md) §4): **"Two devices for one user stay in sync, including after offline edits."** The roadmap's scope for this phase is:

- a Docker Compose stack
- auth with email/password and OIDC
- sync of the Yjs docs
- attachment upload (MinIO/S3)
- device sync
- the web app build

The roadmap budgets 4–5 weeks. There are six milestones, each committed and pushed on its own with tests.

**Already in place (reused, not rebuilt):**

- **Everything is a Yjs doc:** the workspace (page tree), every page, every database and every row. Merging two copies of any of them is always safe and converges, whatever the order, so sync only has to move updates around.
- **`DocTransport`** (core): the UI already talks to storage through `open`/`push`/`subscribe`/`close`. The desktop implements it over IPC; the web app will implement it over the network.
- **`DocManager`** (storage-local): every change to any doc, from any window or an import, goes through it and fires `onUpdate`. That's the hook the desktop sync client uses. It also already re-indexes whatever it receives, so synced pages show up in search, backlinks and reminders with no extra work.
- **Content-addressed attachments** (`<sha256>.<ext>`): the same file has the same id on every device, so uploads are idempotent and never conflict.
- **`Platform`** (app): every host feature goes through one interface, which the web app implements again.
- **Workers** for exports and imports, and backup/restore (Phase 3).

**Not in Phase 4:**

| Item                                                                     | Goes to                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| Several users in one workspace, sharing, permissions, guests             | Phase 5 (collaboration)                            |
| Presence, live cursors, comments, inbox                                  | Phase 5                                            |
| Redis/BullMQ job queue                                                   | Phase 6, when automations and webhooks need it     |
| Meilisearch                                                              | Not planned: Postgres full-text search covers it   |
| Server-side import/export and PDF for the web app                        | Phase 7 (polish); the web app hides these for now  |
| Page history and backlinks in the web app (server-side indexes for them) | Phase 5, with comments; desktop keeps them locally |

## Architecture

```
Desktop (Electron)                                 Server (Docker Compose)
┌──────────────────────────────┐                  ┌──────────────────────────────────┐
│ renderer ── IPC ── DocManager│                  │ Caddy (TLS)                       │
│                     │        │   WSS /sync      │   ├─ /api, /sync → server (Node)   │
│              SyncService ────┼──────────────────┼─▶ │   Fastify: auth, files, search │
│   outbox + cursor (SQLite)   │   HTTPS /api     │   │   ws: workspace replication    │
│   ws-file:// → local or GET  │                  │   └─ /       → web app (static)    │
└──────────────────────────────┘                  │ Postgres 16: users, sessions,     │
Web app (same React UI)                           │   workspaces, doc_updates, files, │
  WebPlatform: DocTransport over /sync,           │   search index                    │
  files and search over /api                      │ MinIO (S3) or a volume: files     │
                                                  └──────────────────────────────────┘
```

**Sync is replication of the update log, per workspace.** Each workspace has one append-only log of Yjs updates in Postgres. Each row is `(seq, doc_id, update)`, and `seq` is a per-workspace counter.

- **Catch up:** a device sends the last `seq` it has, then receives everything after it, merged per doc and in batches.
- **Send:** a device sends what it changed while it was offline (its outbox) and then live edits. The server appends them, acknowledges them, and passes them on to the workspace's other connections.
- **No conflicts:** Yjs updates are idempotent and commutative, so duplicates, reordering and resends after a dropped connection all converge.
- **Compaction:** the server merges a doc's rows into one under a new `seq`. A device that is behind therefore still receives the merged state.

**Why not Hocuspocus** (named in the roadmap): Hocuspocus syncs one document per session. The desktop is offline-first, so it has to hold every doc of the workspace, often thousands, and catch up on all of them after being offline. A single replication stream per workspace does that with one connection, one cursor and no per-doc handshake.

The message encoding uses `lib0`, like y-protocols. Awareness (presence) can be added to the same socket in Phase 5. The web app, which only opens the docs it shows, uses the same socket to `open` a doc (its merged state) and receive that doc's updates.

## Milestones

### M1: server foundation ✅

- **`apps/server`:**
  - Node 22 + Fastify, with `ws` for the sync endpoint, `pino` logs and config from the environment (validated at start).
  - Health and readiness endpoints, graceful shutdown.
- **`packages/storage-remote`:**
  - The Postgres store (`pg`), with versioned SQL migrations run at start.
  - Tables:
    - `users`, `sessions` and `identities` (OIDC)
    - `workspaces`, plus `workspace_members` (one owner in Phase 4; Phase 5 adds roles)
    - `doc_updates (workspace_id, seq, doc_id, data, device_id, created_at)` and `files`
  - The doc log: append, read since `seq`, merged state of a doc, and compaction (merge a doc's rows above a threshold into one new row).
  - Every query is scoped by workspace.
- **Files:** a storage interface with a filesystem driver (single-box installs and tests) and an S3 driver (MinIO, any S3).
- **Docker:**
  - A `Dockerfile` for the server, which serves the web app's static files too.
  - `infra/docker-compose.yml` with Caddy (automatic TLS), the server, Postgres 16 and MinIO, plus volumes, healthchecks and an `.env.example`.
  - A systemd unit, and a backup script (`pg_dump` plus a MinIO mirror).
- **Tests:**
  - Integration tests run against a throwaway Postgres cluster (`initdb` in a temp dir), with no Docker needed.
  - CI builds the image and runs `docker compose up` with a smoke test.

**M1 notes:**

- **`packages/storage-remote` (`PgStore`):**
  - Migrations are versioned SQL in `schema_migrations`, behind an advisory lock so several servers can start at once.
  - The first migration creates every Phase 4 table. The workspace's log counter (`last_seq`) sits on the `workspaces` row.
  - `appendUpdates` takes that row's lock while it hands out sequence numbers. Concurrent appends therefore get distinct, gapless numbers, and they become visible in that order, so a device reading "everything after N" never skips one.
  - `compactDoc` merges a doc's updates under a new number, so a device that's behind still gets everything.
  - `@workspace/storage-remote/testing` starts a throwaway cluster from the installed binaries (as `postgres` when running as root), or uses `WORKSPACE_TEST_PG_URL`. Each test file gets its own database.
- **`apps/server`:**
  - Fastify with `pino` logs. Authorization and cookie headers are redacted from the logs.
  - `loadConfig` reports every problem in the environment at once.
  - `/api/health` (liveness) and `/api/ready` (database and file storage) endpoints.
  - Graceful shutdown on SIGTERM/SIGINT, with a 10-second limit.
  - esbuild bundles the server, workspace packages included, into `dist/main.js`. The image needs no `node_modules` (338 MB on `node:22-bookworm-slim`).
  - `workspace-admin` (in the image) runs `migrate` and `compact`.
  - The `ws` sync endpoint comes in M3, with the protocol.
- **Files:**
  - The `FileStorage` interface: keys are `<workspace id>/<file id>`, checked against the content-hash format so nothing can escape its folder or bucket.
  - `FsStorage` writes atomically through a temp file.
  - `S3Storage` uses the AWS SDK and creates its bucket on the first readiness check.
- **Docker** (differs from the plan):
  - The default stack is Caddy, the server and Postgres 16, with attachments on a volume. It's the simplest install and needs no extra service.
  - S3 is an overlay (`docker-compose.s3.yml`). It bundles SeaweedFS's S3 gateway (Apache-2.0, one node), or can point at any S3 (MinIO, AWS, Backblaze…).
  - MinIO isn't bundled, because its community images are no longer published on Docker Hub.
  - `backup.sh` dumps Postgres and copies the files volume. `workspace.service` runs the stack under systemd.
- **Verified here:**
  - The image builds.
  - Both stacks start healthy with `docker compose up`.
  - HTTPS through Caddy (its local CA for `localhost`) and the HTTP→HTTPS redirect both work.
  - The admin CLI runs in the container, and the backup script runs.
  - The S3 driver passes against the SeaweedFS container (`S3_TEST_ENDPOINT`).
  - CI's new `server` job repeats the image build and stack smoke test.
- **Tests:** the store (migrations, ordered and concurrent appends, workspace isolation, compaction, files), config validation, health and readiness (including the database down), and the file drivers, including path-escape attempts.

### M2: accounts and auth ✅

- **Email and password:**
  - Sign up, sign in and sign out. Passwords are hashed with Node's `scrypt` (no native module). A rate limit applies per IP and per account.
  - Sign-up policy: open, invite-only or off. The first account becomes the admin.
- **Sessions:**
  - Random tokens, stored only as hashes, with an expiry. They can be listed and revoked per device.
  - The web app uses an HttpOnly `SameSite=Strict` cookie plus a CSRF header. The desktop keeps a bearer token, encrypted with Electron's `safeStorage`.
- **OIDC** (`openid-client`, authorization code with PKCE), for any provider: Google, Keycloak, Authentik, GitLab…
  - The web app redirects.
  - The desktop opens the system browser, and the server finishes by redirecting to a one-time code on a `127.0.0.1` loopback port, which the desktop exchanges for a session.
  - Identities are linked to accounts by verified email.
- **Workspaces:** create, list and rename. The creator is the owner.
- **Tests:** API tests for every flow, including expiry, revocation, the rate limit, and OIDC against a small fake provider started in the test.

**M2 notes:**

- **Storage** (`Accounts`, at `store.accounts`). Migration 2 adds three tables:
  - `invites`
  - `oidc_states` (sign-ins in progress)
  - `auth_codes` (the desktop's one-time codes)

  Session tokens, invite codes and one-time codes are 256-bit random values. Only their SHA-256 is stored. Emails are stored lower-cased and trimmed. Sign-ups are serialized by an advisory lock, so two people racing on a fresh server can't both become the admin.

- **Passwords:**
  - Stored as `scrypt$N$r$p$salt$hash` with N=2^15, so the parameters can change later.
  - A sign-in for an unknown email still runs a hash, so timing doesn't reveal which accounts exist.
  - Minimum 8 characters.
- **Sessions:**
  - Web sessions last 30 days and desktop sessions 180 days, sliding: each use extends them, written back at most every 5 minutes.
  - Disabling an account, or changing its password, ends its other sessions.
- **CSRF:**
  - The cookie is `ws_session` (HttpOnly, `SameSite=Strict`, `Secure` when `PUBLIC_URL` is https).
  - Every `/api/` request that isn't a GET must carry an `X-Workspace-Client` header, unless it authenticates with `Authorization: Bearer`. A page on another site can't set that header without CORS, which the server doesn't allow. Sign-in and sign-up need it too, which blocks login CSRF.
- **Rate limits:**
  - 20 requests per minute per IP on the sign-in endpoints (`@fastify/rate-limit`). The client IP comes from `X-Forwarded-For` (the server trusts its proxy), so don't expose the server's port directly. The compose stack only exposes Caddy.
  - After 10 failed password sign-ins in 15 minutes, an account refuses password sign-in for the rest of the window, even with the right password. This is counted in memory.
- **API:**
  - `GET /api/auth/config` returns the sign-up policy, whether the server needs its first account, and the SSO providers.
  - `POST /api/auth/signup`, `/login` and `/logout`. Pass `client: "desktop"` to get a token instead of a cookie.
  - `GET` and `PATCH /api/auth/me`.
  - `POST /api/auth/password`. An SSO-only account can set a password without a current one.
  - `GET /api/auth/sessions` and `DELETE /api/auth/sessions/:id`.
  - `GET`, `POST` and `PATCH /api/workspaces`. Renaming needs the owner or admin role, and non-members get a 404.
  - Admin only: `GET /api/admin/users`, `POST /api/admin/invites` and `POST /api/admin/users/:id/disabled`.
  - Errors are always `{ error, message }`.
- **OIDC:**
  - Providers are configured with `OIDC_PROVIDERS=gitlab,…` and `OIDC_<ID>_ISSUER/CLIENT_ID/CLIENT_SECRET/NAME`. The redirect URI to register is `<PUBLIC_URL>/api/auth/oidc/<id>/callback`.
  - `openid-client` v6 handles the code flow. Authorization is S256 PKCE, and state, nonce and the ID token signature are all checked. Each pending sign-in lives in Postgres for 10 minutes and can be used once.
  - An identity is matched by provider and subject first, then by email, but only when the provider says that email is verified.
  - A new account follows the sign-up policy. An invite can be passed to `start?invite=`.
- **Desktop SSO** (RFC 8252 style):
  - `start?client=desktop&port=<loopback port>&challenge=<S256 of a verifier>`.
  - The callback redirects to `http://127.0.0.1:<port>/callback?code=…`, or `?error=…`.
  - The app posts the code with its verifier to `/api/auth/desktop/exchange` and gets a token. The code is valid for 2 minutes and works once, and is useless to another local app that doesn't have the verifier.
  - The desktop side (`safeStorage`, sign-in UI) comes in M4.
- **`workspace-admin`:** create-user (prints a generated password), reset-password, create-invite, list-users, disable-user, enable-user, make-admin and list-workspaces.
- **Docker:** compose passes `.env` to the server (`env_file`, optional), so `OIDC_*` settings go there. See `.env.example`.
- **Tests:**
  - 6 storage tests: users and the admin race, sessions, invites, identities, states and codes.
  - 15 API tests, covering every flow above: sign-up policies, cookie and token sign-in, CSRF, listing, revoking and expiring sessions, password change, account lockout and the per-IP limit, disabled accounts, workspaces, and SSO.
  - The SSO tests run against a fake OIDC provider started in the test (discovery, authorize, token with PKCE checks, and JWKS, with RS256 ID tokens from `jose`). They cover first sign-in, linking only through a verified email, the sign-up policy, the desktop loopback and exchange, and replayed, cancelled and tampered callbacks.
  - 3 admin CLI tests.

### M3: the sync protocol

- **`packages/sync`** (no Electron or DOM; used by the desktop, the web app and the server):
  - The message types and their lib0 encoding: `hello{workspace, cursor, device}`, `updates{batch}`, `caught-up{cursor}`, `push{docId, update, localId}`, `ack{localId, seq}`, and `open`/`state` (web).
  - Limits on message and update size.
- **Server:**
  - The session token is checked on the WebSocket upgrade, along with membership of the workspace.
  - Catch-up streams in batches, with backpressure. Pushes are appended in order and broadcast to the workspace's other sockets.
  - Heartbeats, and closing idle or slow sockets.
- **Client state machine:**
  - connect → hello → catch up → live
  - It reconnects with exponential backoff and jitter, sends the outbox first after a reconnect, and treats acks as the only proof an update is stored.
- **Tests:**
  - **Convergence:** three in-memory replicas make random edits to random docs, with random disconnects, duplicated and reordered messages and server restarts. Every doc must end identical everywhere.
  - Postgres-backed integration tests: catch-up after compaction, large catch-ups, a rejected cross-workspace push.

### M4: desktop sync

- **SyncService (main process):**
  - It listens to `DocManager.onUpdate`. Local changes go to an outbox table (SQLite migration 6) together with the cursor, so nothing is lost if the app quits offline. Updates from the server are applied through `DocManager` with a sync origin, so they don't bounce back.
  - Windows and the index update as for any other change.
- **Settings → Sync:**
  - Enter a server URL, then sign in with a password or OIDC (browser + loopback).
  - Choose:
    - **Upload this workspace** to a new server workspace.
    - **Use a server workspace** on this device. Its pages merge with the local ones, since Yjs makes merging two workspaces safe. The prompt says so, and offers "Back up first" (Phase 3).
  - Sign out or stop syncing; the local data stays.
- **Status:** a sync indicator in the sidebar (synced, syncing N changes, offline, signed out, error), with details on click.
- **Attachments:**
  - New files are uploaded in the background (`HEAD` first, so each file is uploaded once).
  - A file missing locally (made on another device) is fetched when `ws-file://` asks for it, then kept.
- **Tests:**
  - Unit: the outbox, the cursor, and applying remote updates without echo.
  - E2E: a desktop instance against a real server process (local Postgres) — sign in, upload, restart, still synced.

### M5: server index and search

- The server keeps the same derived index the desktop has (titles, page tree, body text, rows with their property text) in Postgres full-text search (`tsvector`, `simple` configuration for mixed languages). It reuses the pure functions from core and database: `pageText`, row indexing.
  - It's updated after appends, debounced per doc.
- `GET /api/search` gives the same results and snippets as quick find on the desktop.
- **Attachments API:** upload (size limit, MIME sniffing, content hash checked), download with `ETag`/range requests, and per-workspace storage usage.
- **Admin basics:** a CLI in the image (`workspace-admin`) to create users, reset passwords, list workspaces and compact logs.

### M6: web app

- **`apps/web`:** a Vite build of `packages/app` with a `WebPlatform`:
  - `DocTransport` over the sync socket (`open` a doc's state, then its live updates; pushes acknowledged)
  - search, files and settings over `/api`, and per-user settings stored on the server
- **Sign-in pages:** sign in, sign up and OIDC buttons, then a workspace picker.
- **Features that need the desktop** (PDF export, import, export, backup, multiple windows, page history, backlinks) are hidden in the web app, not broken. Links and notifications open pages in the browser tab.
- The server serves the build under `/`, and Caddy puts everything on one origin.
- **Tests:** Playwright (Chromium) against the server — sign in, edit a page and a database, reload, see the edits.

## Exit check

"Two devices for one user stay in sync, including after offline edits":

- **Two desktops, one server:** an E2E test runs a server on a throwaway Postgres and two Electron instances with separate data folders signed in as one user. It checks each of these on the other device:
  - live edits: page text, a new sub-page, a page moved in the tree, database rows and properties, a deleted page, an attachment
- **Offline:**
  - Instance B is cut off from the server (the test closes its socket and blocks reconnects) and both instances edit the same page, other pages and the same database.
  - After reconnecting, both converge: same text, rows and tree.
  - Both instances are restarted and are still identical.
- **The web app:** an edit in the browser shows on a desktop, and the other way round.
- **Convergence fuzzing** (M3) runs in CI on every push.
- **The Docker stack:** `docker compose up` on a clean Ubuntu 24.04 machine. A device signs up, uploads and syncs through Caddy with TLS (a local CA in CI).

## Packages

```
apps/
  server/          Fastify API, WebSocket sync, admin CLI, Dockerfile
  web/             Vite build of the shared UI with WebPlatform
packages/
  sync/            protocol messages and the client state machine (no I/O)
  storage-remote/  Postgres store: migrations, doc log, users, sessions, files metadata
infra/
  docker-compose.yml, Caddyfile, .env.example, workspace.service, backup.sh
```

New dependencies: `fastify`, `@fastify/cookie`, `@fastify/rate-limit`, `ws`, `pg`, `openid-client`, `@aws-sdk/client-s3` (S3 driver only), `pino`. Password hashing uses Node's `scrypt`, so there is no native module.

## Critical files

- **New:**
  - `apps/server/src/{main.ts, config.ts, http/*, sync/*, auth/*, files/*, search/*}`
  - `packages/storage-remote/src/{migrations/*, store.ts, doc-log.ts}`
  - `packages/sync/src/{messages.ts, client.ts, server.ts}`
  - `apps/desktop/src/main/sync/{service.ts, outbox.ts, auth.ts}`
  - `packages/app/src/sync-settings.tsx`
  - `apps/web/*`
  - `infra/*`
- **Modified:**
  - `packages/storage-local/src/{sqlite-store.ts, doc-manager.ts}` (migration 6: outbox and sync state; origin-aware updates)
  - `apps/desktop/src/main/{index.ts, files.ts, ipc.ts}` (sync service, fetch missing files)
  - `packages/app/src/{platform.ts, sidebar.tsx, app.tsx}` (sync status and settings, web feature flags)

## Verification

- **Unit tests (Vitest):**
  - protocol encode/decode and limits
  - the client state machine (backoff, outbox, acks)
  - convergence fuzzing
  - password hashing and session tokens
- **Integration tests (Vitest + throwaway Postgres):**
  - the doc log (append, catch-up, compaction)
  - auth flows, including OIDC against a fake provider
  - file upload/download
  - search
- **E2E (Playwright):**
  - two Electron instances and a server (the exit check)
  - the web app against the server
  - desktop sign-in and sync settings
- **Docker:** CI builds the image, runs `docker compose up`, and runs the smoke test through Caddy.
- Before every push: `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `xvfb-run -a pnpm test:e2e`, run twice.
- **Security review** before sign-off:
  - every endpoint and message checks the session and the workspace
  - sizes are limited
  - tokens are only stored hashed
  - cookies and CSRF are set up correctly
