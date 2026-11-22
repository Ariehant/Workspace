# Workspace Calendar: context for the chat that builds it

This file hands a new chat (you) everything an earlier chat knew about the calendar app, so you
can start without re-asking what's already decided. Read it whole, then read
[HANDOFF.md](HANDOFF.md), the specification.

## 1. Your task

Build **Workspace Calendar**, a desktop calendar app (Electron, Linux with GNOME and Windows), in
this monorepo as **`apps/calendar`**. It reads and writes Workspace's database rows as events
through the Workspace server's public **`/v1` API**.

Follow [HANDOFF.md](HANDOFF.md) version by version:

- **v1.0:** Workspace databases.
- **v1.1:** Google Calendar.
- **v1.2:** ICS feeds and CalDAV.

Each version needs its tests passing and packaging working before the next starts.

The handoff was written for a builder in a separate repository. Section 3 below says how it adapts
to this monorepo. Where the two disagree, this file wins for repo matters (layout, CI, rules), and
the handoff wins for the product and the API facts.

## 2. Decisions already made by the owner (don't ask again)

- **Who builds it:** you, a Claude chat, not ChatGPT. That's why this file exists.
- **Platform:** desktop, Electron, Linux (GNOME) and Windows. macOS later (signing).
- **Where:** this repository, `apps/calendar`, on its **own branch**: the branch your session is
  given, separate from other work and never `main`. Changes reach `main` through PRs.
- **How it connects to Workspace:** only through the server's REST API (`/v1`, Notion-shaped,
  with an integration token). No sync protocol, no local Workspace storage.
- **Data sources, in this order:**
  - v1.0: Workspace databases;
  - v1.1: Google Calendar;
  - v1.2: ICS and CalDAV.
- **Name:** "Workspace Calendar". It's in the spirit of Notion Calendar's design (fast,
  keyboard-first, clean) but must not use Notion's name, logo or artwork.
- **License:** AGPL-3.0, like the rest of the repo.

## 3. How the monorepo changes the handoff

**What to reuse:**

| Need                       | Use                                                                                                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI primitives and theme    | `@workspace/ui` (`packages/ui`): Radix-based `Menu*`, `Popover*`, `Dialog`, `IconButton`, `useAppliedTheme`, `styles.css` (Tailwind v4 tokens: `bg-surface`, `text-muted`, `border-line`…)                                                                |
| Build setup                | electron-vite, as `apps/desktop/electron.vite.config.ts` (main / preload / renderer, and its strict production CSP)                                                                                                                                       |
| Packaging                  | electron-builder, modelled on `apps/desktop/electron-builder.yml`, with its own `appId`, `productName` ("Workspace Calendar"), `executableName: workspace-calendar`, artifact names, desktop entry and icon. Linux `deb` and AppImage; Windows NSIS later |
| Secrets                    | Electron `safeStorage`, as in `apps/desktop/src/main/google.ts` (checks `isEncryptionAvailable()` and, on Linux, the selected backend)                                                                                                                    |
| Scheduled OS notifications | the pattern in `apps/desktop/src/main/reminders.ts`: keep references to live `Notification` objects (or they're garbage-collected before a click), and re-check at least every 60 s so sleep, resume and clock changes are picked up                      |
| E2E launching              | the pattern in `apps/desktop/e2e/helpers.ts` (`launchApp`): Playwright's `_electron`, a data directory per test through an env var, `--no-sandbox` when running as root, a launch timeout, and `xvfb-run -a` around the suite                             |

**What not to depend on:** `@workspace/sync`, `@workspace/storage-local`, `@workspace/database`
or `@workspace/core`. The calendar is an API client. Use `@notionhq/client` with
`baseUrl: <server>`, or plain `fetch` in the main process.

**Repo rules that will bite if missed:**

- **Shared version:** `scripts/version.mjs` keeps one version across the apps in its `APPS` list
  (`apps/desktop`, `apps/server`, `apps/web`). Add `apps/calendar` to `APPS` and give its
  `package.json` the same version (`0.1.0` now). `pnpm lint` runs this check.
- **Packages:** `pnpm-workspace.yaml` already includes `apps/*`, so the new package is picked up.
  Give it `build`, `typecheck` and `test` scripts so turbo runs them.
- **Turborepo:** `AGENTS.md` says to read the installed `turbo` package's `docs/` before changing
  Turborepo config. Resolve `turbo` from a workspace that depends on it.
- **CI** (`.github/workflows/ci.yml`):
  - The `check` job (format, lint, typecheck, unit tests) covers the new package through turbo.
  - The `e2e`, `package` and `latest-build` jobs are written for `apps/desktop` paths. Add
    calendar steps or jobs for its E2E and packaging.
  - Adding the calendar's packages to the `latest-build` pre-release and to
    `.github/workflows/release.yml` needs the owner's OK.

## 4. Workspace API facts, and where to check them

The handoff's section 3 has them all. These are the ones that differ from Notion, with the code
that proves them:

- **Dates are wall-clock times.** The API writes `…T09:30:00.000+00:00`, but `+00:00` isn't real
  UTC; it's the time as typed.
  - Read the digits as local time and store the event as "floating".
  - Write back with no zone (`YYYY-MM-DDTHH:mm`).
  - Check: `packages/api-model/src/properties.ts`, `apiDate`, `apiDateString` and
    `parseDateString`.
- **`last_edited_time` and `created_time` are real UTC.** Incremental sync can filter on them:
  `{ "timestamp": "last_edited_time", "last_edited_time": { "on_or_after": "<ISO>" } }`.
  - Check: `packages/api-model/src/filters.ts`, the `timestamp` branch.
- **Delete and restore:** `PATCH /v1/pages/:id` with `{ "in_trash": true }`, or `"archived"`.
  - Restoring a trashed row may not be reachable through the API once it's trashed. Hence the
    handoff's "send the delete only after Undo's few seconds".
  - Check: `apps/server/src/api/pages.ts`, the `update` function.
- **Page links:** a page's `url` is `<server>/w/<workspace>#page=<id>`, for "Open in Workspace".
  - Check: `apps/server/src/api/view.ts`, `pageUrl`.
- **People:** a `people` property can be written (`[{ "id": "<user id>" }]`, users of the
  workspace only) and filtered (`contains`).
  - Check: `packages/api-model/src/properties.ts` and `filters.ts`, the `person` cases.
- **Not available:** the date's reminder isn't exposed by the API. Webhooks go only to public
  https addresses, so a desktop app polls.
- **Limits, errors, versions, endpoints:** in [the API docs](../api.md). In short:
  - 3 requests a second, bursts of 30, then `429` with `Retry-After`;
  - pages of up to 100;
  - the `Notion-Version: 2022-06-28` header is required.

## 5. Testing against a real Workspace server, in this repo

You don't need Docker for integration tests. The repo already starts real servers in tests:

- **Starting a server:** `apps/web/e2e/server.ts`, `startServer(env)`.
  - It builds `apps/server` (`node build.mjs`) and starts a throwaway Postgres
    (`startTestPostgres` and `createTestDatabase` from `@workspace/storage-remote/testing`).
  - It runs the server on a free port with `SIGNUP=open` and polls `/api/ready`.
  - It returns `{ base, pause, resume, stop }`. (It expects the web app built; for the calendar
    you can copy the pattern without the web part.)
- **Making an integration and connecting pages**, as `apps/server/src/api.test.ts` does around its
  `world()` helper:
  1. Sign up through `POST /api/auth/signup` (send the `x-workspace-client` header). You get a
     user token.
  2. `POST /api/workspaces` with `{ name }` creates a workspace.
  3. `POST /api/workspaces/:id/integrations` with `{ name }` answers
     `{ integration: { id }, token }`.
  4. Share a page into a shared scope (`POST /api/workspaces/:id/pages/:pageId/share`), then
     connect the integration with `PUT /api/workspaces/:id/scopes/:scopeId/access` and
     `{ "principal": "user:<integration id>", "role": "edit" }`.
  5. Call `/v1` with the integration's token.
  6. Read `api.test.ts` for the exact shapes before writing your helper.
- **Docker Compose:** `infra/` has a stack for manual testing (`docs/self-hosting.md`).

## 6. Working with the owner

- An R&D robotics developer. They usually write in Hinglish, and Hinglish replies are welcome.
  Keep them plain and short, with the facts first.
- **Plan first:** for each version or big step, explore, write a plan, and get approval (plan
  mode) before building. Ask questions as multiple choice with a recommended option.
- **Report honestly:** say what passed and what didn't, with numbers and output.
  - A real failure is never called a "flake": find the root cause.
  - Never skip, disable or quarantine a test to get green.
- **Merging and releases:** PRs are merged only when the owner says so; releases and tags too.

## 7. Rules in this environment

- **Branches:**
  - Commit and push only to your session's own branch; retry a failed push up to 4 times with
    backoff.
  - Never push to `main` or anyone else's branch.
  - A merged PR means restarting your branch from the new `main`.
- **Denied operations:**
  - Pushing tags is refused (HTTP 403): ask the owner to push a tag.
  - Re-running GitHub Actions jobs through the API is refused (403): if a re-run is needed, ask
    the owner.
- **Attribution:**
  - End commit messages with the attribution lines your environment gives
    (`Co-Authored-By: …` and `Claude-Session: …`).
  - Don't put model names in commits, code or PR text.
  - End PR descriptions and GitHub comments with the footers your environment specifies.
- **Privacy:** keep the owner's email address private.
- **Before every push:**
  - `pnpm format:check`: read its full output, don't pipe it into `tail`;
  - `pnpm lint` (ESLint, the Markdown link check, the version check);
  - `pnpm typecheck`, the relevant unit tests, and E2E where the change needs it.
- **E2E runs:** don't rebuild an app while an E2E suite of it is running; the tests start the built
  app.
- **Browser:** Playwright and Chromium are preinstalled. Don't reinstall them.

## 8. State of the repo (2026-11-22)

- **Merged:** PR #1 (Phase 8 work, CI fixes) and PR #2 (download docs and the `latest-build`
  job). `main` is at `a91fd20` or later.
- **Downloads:**
  - [`latest-build`](https://github.com/Ariehant/Workspace/releases/tag/latest-build) is a
    pre-release that CI refreshes from `main` with the desktop app's `.deb` and AppImage.
  - The first real release, `v1.0.0-rc.1`, waits on the owner pushing its tag.
- **Open:** PR #3 has the Workspace Write handoff (`docs/docs-app/HANDOFF.md`), a CI fix and this
  file. Its CI fix saves the perf baseline on every push to `main`.
  - **Until PR #3 merges, the "Performance budgets" job fails on every PR:** the saved baseline is
    stuck on an unusually fast run (#50).
  - If your PR shows it, say once on the PR that it isn't yours and point to PR #3.
- **Related, parked:** [desktop integration ideas](../ideas/desktop-integration.md) for the main
  desktop app (tray agenda, notifications). The calendar's own tray and notifications are part of
  its spec (handoff section 1), not of that idea.

## 9. First steps

1. **Read:** [HANDOFF.md](HANDOFF.md) and this file. Skim `apps/desktop` for the patterns in
   section 3.
2. **Plan v1.0:**
   - the package layout;
   - the IPC surface;
   - the SQLite cache schema (better-sqlite3, or Node's `node:sqlite` as the desktop app uses);
   - the Workspace sync engine;
   - the UI views;
   - the tests, and the CI changes.

   Show the plan to the owner and get approval.

3. **Scaffold `apps/calendar`:**
   - `package.json` (`@workspace/calendar`, version as the other apps, AGPL);
   - electron-vite config, `src/main`, `src/preload`, `src/renderer`;
   - the `@workspace/ui` theme.

   Add it to `scripts/version.mjs`.

4. **Write the date-mapping unit tests first** (handoff 3.4: all-day, ranges, timed with and
   without an end, near midnight, zones far from UTC), then the mapping.
5. **Build the Workspace sync engine,** with integration tests against a real test server
   (section 5). Cover paging, `429`, incremental sync and the deletion sweep.
6. **Then the rest:**
   - the UI: week, day, month and agenda; drag to create, move and resize; the event panel; the
     command bar;
   - notifications and the tray;
   - E2E, packaging and the CI jobs;
   - a PR for v1.0.
