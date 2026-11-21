# Workspace Calendar: build plan (handoff)

This document is written to be given, whole, to an AI coding assistant (or a developer) who will
build the app in a new repository. It's self-contained: everything needed about Workspace is
here.

---

## Prompt

> You are building **Workspace Calendar**, a desktop calendar app (Electron, for Linux with
> GNOME and for Windows) that works with **Workspace**, a self-hosted, Notion-style app for notes
> and databases. Workspace Calendar reads and writes Workspace through Workspace's public REST
> API, which has the same shape as Notion's API. Build it in three versions, in order: v1.0
> shows and edits Workspace database rows as events; v1.1 adds Google Calendar; v1.2 adds ICS
> feeds and CalDAV. Follow the spec below exactly where it states facts about Workspace's API
> (they differ from Notion's in places). Work version by version: finish v1.0, with its tests
> passing and the app packaged, before starting v1.1. Ask the owner for anything listed under
> "What to ask the owner" when you reach it.

---

## 1. The product

**What it is:** a fast, keyboard-first calendar with a clean look, in the spirit of Notion
Calendar, that puts Workspace's dated database rows (tasks, meetings, deadlines, plans) next to
the user's other calendars.

**Name and branding:** "Workspace Calendar". Don't use Notion's name, logo, icons or artwork
anywhere in the app or its packaging. License: AGPL-3.0, the same as Workspace.

### Features (v1.0 unless marked)

- **Views:** day, week (the default), month, and a scrolling agenda list. A custom range of
  1–7 days. A mini month in the sidebar. "Today" and "Go to date".
- **Calendars:** a sidebar list of calendars grouped by account, each with a colour and a
  checkbox to show or hide it.
- **Events:**
  - Drag on the grid to create; drag to move; drag the bottom edge to resize. All-day events in
    a row at the top; drag between the grid and that row to switch.
  - An event panel (opens on click, closes with Esc): title, start and end, all-day, the
    description (for sources that have one), the calendar, and for Workspace events their other
    properties, read-only, and an **Open in Workspace** button.
  - Delete with the Delete key or from the panel, with Undo for a few seconds (the delete is
    sent to the source only after that).
- **Keyboard:** a command bar on Ctrl+K (go to date, switch view, create event, search, open
  settings); single keys: `t` today, `d`/`w`/`m` views, `j`/`k` (or arrows) previous/next
  period, `c` create, `Delete` delete, `Esc` close; a shortcuts sheet on `?`.
- **Search:** over cached events, by title.
- **Time zones:** the system's zone; optionally one more zone shown as a second time column.
- **Theme:** light and dark, following the system, with a manual override.
- **Notifications:** operating-system notifications before events. A default per calendar:
  none, at start, 5, 10 or 30 minutes before, 1 hour before; all-day events at 09:00 on the day.
  Actions: open, snooze 5 minutes. (Workspace's own reminders aren't readable through the API:
  see 3.6.)
- **Tray:** a tray icon with the next event and today's list, Open, Quit. On GNOME, tray icons
  need the AppIndicator extension (Ubuntu ships it); without it, the app still works and only
  the icon is missing. A setting keeps the app running in the tray when its window is closed,
  so notifications still arrive.
- **Start at login** (a setting, off by default).
- **Offline:** everything shown comes from a local cache; edits made offline are queued and
  sent when back online.
- **Light:** targets of under 150 MB of memory idle with a few calendars, and a cold start to
  the week view in under 2 seconds.

## 2. Architecture

- **Stack:** Electron, React, TypeScript (strict), Vite (electron-vite), packaged with
  electron-builder: AppImage and `.deb` for Linux, NSIS for Windows.
- **Processes:**
  - **Main:** all network access, the sync engines, the cache, the notification scheduler, the
    tray. Tokens and passwords never reach the renderer.
  - **Renderer:** the UI only, talking to main over a typed IPC bridge (`contextBridge`,
    `contextIsolation: true`, no `nodeIntegration`). A strict Content Security Policy.
- **Secrets:** tokens, OAuth refresh tokens and CalDAV passwords encrypted with Electron's
  `safeStorage`; never written in plain text or logged.
- **Cache:** SQLite (better-sqlite3) in the app's user-data folder.
- **Data model:**
  - `Account { id, kind: 'workspace' | 'google' | 'ics' | 'caldav', name, settings }`
  - `Calendar { id, accountId, sourceId, name, colour, visible, defaultReminder, readOnly,
settings }`
  - `Event { id, calendarId, sourceId, title, start, end, allDay, floating, description,
recurrence?, url?, extra (JSON), etag or lastEdited, deleted, pendingChange? }`
  - `floating: true` means the times are wall-clock times with no zone (Workspace's, see 3.4);
    they're shown at the same clock time in any zone.
- **Sync:** one engine per account kind with the same interface (`fullSync`, `incrementalSync`,
  `create`, `update`, `delete`), run by a scheduler; changes made in the UI are applied to the
  cache at once and sent in the background (a queue, retried with backoff).
- **Conflicts:** last write wins; if an event changed at the source while an edit was pending,
  the edit still goes, and the panel shows "Changed elsewhere" with the source's version.
- **Rate limits:** a token bucket per Workspace integration (3 requests a second, bursts up to
  30), and on `429` wait for `Retry-After`.
- **Logs:** a rotating log file in the user-data folder; no tokens or event contents in it.

## 3. v1.0: Workspace databases

### 3.1 How Workspace's API works

- The API is at `<server>/v1`, in the shape of Notion's API. The official Notion SDK works
  against it: `new Client({ auth: token, baseUrl: '<server>' })` from `@notionhq/client`. Using
  it is recommended.
- **Auth:** `Authorization: Bearer ntn_…`. The user makes an **integration** in Workspace
  (Members → Integrations, owners and admins only), copies its token (shown once), and connects
  the pages or databases it may use (a page's Share → Connections; pages under a connected page
  are included). The integration needs the capabilities to read, update and insert content, and
  user information (without emails is enough) for the "only mine" filter.
- **Every request** needs the header `Notion-Version: 2022-06-28` (in this version databases are
  queried directly).
- **Only what's on the server:** the calendar sees what's on the Workspace server. A Workspace
  desktop app that isn't synced to a server can't be reached; edits made on a synced desktop
  show once they've synced.
- **Limits:** 3 requests a second per integration on average, bursts up to 30, then `429` with
  `Retry-After`; results in pages of up to 100 (`start_cursor`, `page_size`; responses have
  `has_more` and `next_cursor`); 500 KB per request.
- **Errors:** `{ "object": "error", "status", "code", "message" }`, with Notion's codes
  (`unauthorized`, `restricted_resource`, `object_not_found`, `validation_error`,
  `rate_limited`, …). Show the message to the user where it helps (a bad token, a database no
  longer connected).
- **No webhooks for this app:** Workspace sends webhooks only to public `https://` addresses,
  so a desktop app polls (3.5).

### 3.2 Connecting

1. The user enters the server address (for example `https://notes.example.com`) and the token.
2. Check them with `GET /v1/users/me` (it answers with the integration's bot user). Show a clear
   error for a wrong address, a wrong token, or a server that isn't Workspace.
3. List databases with
   `POST /v1/search` and the body `{ "filter": { "property": "object", "value": "database" } }`
   (paged).
4. The user picks databases to show. For each one, fetch its schema with `GET /v1/databases/:id`
   and let them choose:
   - **the date property** (required; among properties of type `date`),
   - **the title** (the property of type `title`, chosen automatically),
   - optionally **"only mine"**: a `people` property and which person the user is (from
     `GET /v1/users`; the integration itself is a bot, so the user picks themselves),
   - optionally **colour by** a `select` or `status` property (the option's colour), else the
     calendar's colour.

   Each chosen database (with its date property) is one calendar. The same database can be added
   twice with different date properties.

5. Optionally offer the database's own calendar views: `GET /v1/databases/:id/views` (Workspace's
   own endpoint) lists views (`{ "object": "view", "id", "name", "type", "sorts", "has_filter",
… }`); views of `type: "calendar"` can be used as the calendar instead of the whole database,
   queried with `POST /v1/databases/:id/views/:view/query` (the rows that view shows, with paging,
   and an extra Notion `filter` if sent).

### 3.3 Reading events

Query a database's rows in a range with Notion's filter JSON. Use **dates without times** for
range bounds:

```http
POST /v1/databases/{database_id}/query
Notion-Version: 2022-06-28
Authorization: Bearer ntn_…
Content-Type: application/json

{
  "filter": {
    "and": [
      { "property": "When", "date": { "on_or_after": "2026-05-01" } },
      { "property": "When", "date": { "on_or_before": "2027-11-30" } }
    ]
  },
  "page_size": 100
}
```

A row comes back as a Notion page object; the parts the calendar uses:

```json
{
  "object": "page",
  "id": "9b2c…",
  "url": "https://notes.example.com/w/4f1e…#page=9b2c…",
  "last_edited_time": "2026-11-20T08:12:00.000Z",
  "properties": {
    "Name": { "id": "title", "type": "title", "title": [{ "plain_text": "Design review" }] },
    "When": {
      "id": "x1",
      "type": "date",
      "date": {
        "start": "2026-11-24T10:00:00.000+00:00",
        "end": "2026-11-24T11:00:00.000+00:00",
        "time_zone": null
      }
    }
  }
}
```

- The title is the concatenated `plain_text` of the title property; empty means "Untitled".
- `url` opens the row in Workspace (**Open in Workspace**: open it with the system browser,
  `shell.openExternal`).
- Rows whose date property is empty aren't shown.

### 3.4 Dates: the rules (read carefully)

Workspace stores times as **wall-clock times with no time zone**. The API writes them with
`+00:00`, but that isn't real UTC: it's the time as the user typed it.

- **Reading:**
  - `"2026-11-24"` (no time): an **all-day** event on that day. With `"end": "2026-11-26"`, it
    spans the 24th to the 26th, including the 26th.
  - `"2026-11-24T10:00:00.000+00:00"`: a timed event at **10:00 local wall-clock time**. Take the
    digits, ignore the `+00:00`, and store the event as `floating`. Don't convert it from UTC.
  - `end: null` with a time: a 1-hour event for display (don't write an end back unless the user
    resizes it).
- **Writing:** send times with **no zone**: `"2026-11-24T10:00"` (minutes, no seconds needed);
  all-day as `"2026-11-24"`. A time without a zone is stored exactly as written.
- **Real UTC:** `last_edited_time` and `created_time` (on page objects and in timestamp filters)
  are real UTC instants, unlike date property values.
- **Unit tests must cover:** all-day single and range, timed with and without an end, a time
  near midnight, and a user in a zone far from UTC (for example UTC+5:30 and UTC−8): a row at
  "10:00" shows at 10:00 for both, and a moved event writes back the clock time that was shown.

### 3.5 Keeping in sync

- **First sync:** the range query above for 6 months back to 12 months ahead, all pages.
- **Changes:** every 60 seconds while the window is open (every 5 minutes when it's only in the
  tray), and at once on window focus and when the computer wakes, query the rows changed since
  the last sync (minus a minute of slack), whatever their date:

  ```json
  {
    "filter": {
      "timestamp": "last_edited_time",
      "last_edited_time": { "on_or_after": "2026-11-20T08:11:00.000Z" }
    },
    "page_size": 100
  }
  ```

  Update the cache from what comes back (a row whose date moved out of the window or was
  cleared leaves the calendar).

- **Deletions:** trashed rows simply stop being returned, and no event says so. Every 15 minutes
  (and on manual refresh), list the ids in the window (the range query) and drop cached events
  that aren't there any more.
- **Schema changes:** if the chosen date property is gone or changed type (a `validation_error`
  naming it), mark the calendar as needing setup and ask the user.
- **Access lost:** `object_not_found` or `restricted_resource` for a database means it's no longer
  connected to the integration: mark the calendar and tell the user how to reconnect it.

### 3.6 Writing

- **Create** (drag on the grid in a Workspace calendar):

  ```json
  POST /v1/pages
  {
    "parent": { "database_id": "{database_id}" },
    "properties": {
      "Name": { "title": [{ "text": { "content": "Design review" } }] },
      "When": { "date": { "start": "2026-11-24T10:00", "end": "2026-11-24T11:00" } }
    }
  }
  ```

  Use the database's actual title property name and the calendar's date property name. With
  "only mine" set, also set the people property to the user:
  `"Owner": { "people": [{ "id": "{user_id}" }] }`.

- **Move or resize:** `PATCH /v1/pages/{page_id}` with
  `{ "properties": { "When": { "date": { "start": "…", "end": "…" } } } }`.
- **Rename:** `PATCH /v1/pages/{page_id}` with the title property.
- **Delete:** `PATCH /v1/pages/{page_id}` with `{ "in_trash": true }` (`"archived": true` also
  works). It goes to Workspace's trash, where it can be restored in Workspace. The calendar's
  Undo works by waiting: the event disappears at once, and the request is sent only when the
  few seconds for Undo have passed.
- **Reminders:** Workspace's own date reminders aren't part of the API, so the calendar can't
  read or set them; its notifications come from its own settings (section 1).

### 3.7 Done when

- An event created, moved, resized, renamed and deleted in the calendar shows that way in
  Workspace (the row and its date), and a row changed in Workspace shows in the calendar within
  a minute.
- Notifications fire at the configured time; the tray shows the next event.
- The tests in section 6 pass, and the AppImage, `.deb` and Windows installer build in CI.

## 4. v1.1: Google Calendar

- **Sign-in:** OAuth 2.0 for desktop apps: a loopback redirect (`http://127.0.0.1:<port>`) with
  PKCE, opened in the system browser. The user (or owner) provides a Google Cloud OAuth client
  id (and its client secret, which Google issues for desktop apps but isn't secret) in Settings;
  don't ship a shared one. Scopes: `https://www.googleapis.com/auth/calendar.readonly` (to list
  calendars) and `https://www.googleapis.com/auth/calendar.events` (to edit events). Keep the
  refresh token with `safeStorage`.
- **Calendars:** `calendarList.list`; show each with Google's colour, allow hiding.
- **Events:** `events.list` per calendar with a `syncToken` for incremental sync after the first
  full sync; on `410 Gone`, do a full sync again. Keep recurring events as their series (RRULE)
  plus exceptions, and expand them locally with the same recurrence engine as v1.2.
- **Editing:** create, move, resize, rename, delete. For a recurring event, ask "This event" or
  "All events" (and "This and following" where the API allows); use the event's `etag` to detect
  conflicts.
- **Video calls:** if an event has a Google Meet link (`hangoutLink` or `conferenceData`), show a
  **Join** button in the panel and in the notification.
- **Done when:** Google events sync both ways, recurring events show and edit correctly, a token
  refresh works after an hour, and its tests pass (with a mocked Google API).

## 5. v1.2: ICS feeds and CalDAV

- **ICS (read-only):** subscribe by URL (`http`, `https`, or `webcal://` read as `https://`).
  Refresh every 30 minutes and on demand, with `If-None-Match`/`If-Modified-Since`. Parse with
  `ical.js`, including `VTIMEZONE`s.
- **CalDAV (read and write):** with the `tsdav` library: discover calendars from a server address
  and username and an app password (Nextcloud, Fastmail, Radicale, iCloud with an app password);
  sync with `sync-collection` (or ETags where unsupported); create, update and delete calendar
  objects with `If-Match` on their ETag.
- **Recurrence:** expand RRULE, RDATE and EXDATE (and `RECURRENCE-ID` exceptions) with `ical.js`
  or `rrule`, the same engine for Google, ICS and CalDAV.
- **Done when:** a public holiday feed and a Nextcloud calendar show, CalDAV edits round-trip, and
  the tests pass (with recorded fixtures and a Radicale server in CI).

## 6. Tests

- **Unit (Vitest):** the date rules of 3.4; the mapping from page objects to events and back;
  sync diffs (changed, moved out of range, deleted by the sweep); the rate limiter and retry on
  `429`; recurrence expansion; notification scheduling, including after the computer wakes.
- **Integration:** the Workspace sync engine against a mock `/v1` server (msw) that follows this
  spec, including paging, `429` with `Retry-After`, and errors.
- **Against a real Workspace server** (a documented recipe, run before each release):
  start one with Docker Compose, from Workspace's repository:

  ```sh
  git clone https://github.com/Ariehant/Workspace.git
  cd Workspace/infra
  cp .env.example .env     # set DOMAIN=localhost and POSTGRES_PASSWORD
  docker compose up -d --build
  ```

  Sign up in the browser (the first account is the admin), make a database with a date property,
  make an integration in Members → Integrations, connect the database to it, and run the
  integration tests with `WORKSPACE_URL` and `WORKSPACE_TOKEN` set.

- **End-to-end (Playwright with Electron, under `xvfb-run` in CI):** connect to the mock server,
  see events in the week view, drag to create, drag to move, delete and undo, open the command
  bar, and a notification is scheduled (mock `Notification` in main and assert it was shown).
- **CI (GitHub Actions):** lint (ESLint, Prettier), typecheck, unit, integration, end-to-end, and
  package (Linux on Ubuntu, Windows on a Windows runner).

## 7. Not in v1

Inviting people or sharing calendars, scheduling links, availability, a mobile app, editing
Workspace's own reminders (not in the API), and macOS builds (they need signing; later).

## 8. What to ask the owner

- **For v1.0:** a Workspace server address and an integration token for a test workspace (or use
  the Docker Compose recipe in section 6).
- **For v1.1:** a Google Cloud OAuth client id and secret (desktop app type) for testing.
- **For v1.2:** a CalDAV account to test with, if not the Radicale server in CI.
- **Before release:** the app icon, and where releases are published.
