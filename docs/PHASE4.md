# Phase 4: Sync server

**Status:** planned.

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

### M1: server foundation

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

### M2: accounts and auth

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
