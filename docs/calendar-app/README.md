# Workspace Calendar: user guide

Workspace Calendar is a desktop calendar for Linux and Windows. It shows the dated rows of your
Workspace databases (tasks, meetings, deadlines, plans) as events, lets you create, move and
change them, and notifies you before they start. It talks to your Workspace server through its
API, so it shows what's on the server.

Version 1.0 works with Workspace databases. Version 1.1 adds Google Calendar: its calendars show
beside Workspace's and can be changed here, recurring events included. Version 1.2 adds
CalDAV accounts (Nextcloud, Fastmail, Radicale, iCloud), shown and changed here, and calendars
subscribed to by address (ICS feeds, such as public holidays). See [the build plan](HANDOFF.md).

## Install

- **Ubuntu 24.04 or later:** install the `.deb` (`sudo apt install ./workspace-calendar_*_amd64.deb`)
  or run the AppImage (`chmod +x Workspace-Calendar-*.AppImage`, then open it).
- **Windows:** run `Workspace-Calendar-Setup-*.exe`. It installs for your user, with a Start menu
  shortcut.

Download them from the repository's [Releases](https://github.com/Ariehant/Workspace/releases)
(each release has both apps, Workspace and Workspace Calendar), or the
[latest build](https://github.com/Ariehant/Workspace/releases/tag/latest-build) of `main`, which CI
publishes after its tests pass. CI also builds them for every pull request, as the
`calendar-linux-packages` and `calendar-windows-installer` artifacts of its run.

**Updates:** the AppImage and the Windows app update themselves: a new version downloads in the
background, and **Settings → Updates** (or the tray menu) offers **Restart to update**; it's also
installed the next time the calendar quits. Turn that off, or **Check now**, in Settings →
Updates. Installed from a release candidate (`1.0.0-rc.1`), the calendar gets the next candidates
and releases; from a release, releases only. The `.deb` updates with the system once it's in the
project's apt repository (from 1.0.0; see [Install](../desktop.md#install) in the Workspace guide,
then `sudo apt install workspace-calendar`).

## Connect Workspace

The calendar reads and writes Workspace through an **integration** (a bot with a token). You need
a Workspace owner or admin for the first step.

1. **Make an integration.** In Workspace, open **Members → Integrations** and make a new one (for
   example "Calendar"). It needs to read, update and insert content, and to read user information
   (without emails is enough). Copy its token, which starts with `ntn_`. It's shown once.
2. **Connect your databases to it.** Open each database you want on the calendar (or a page above
   it: pages and databases under a connected page are included), choose **Share → Connections**,
   and add the integration.
3. **In the calendar,** choose **Connect Workspace**. Enter your server's address (the one you open
   Workspace at, like `https://notes.example.com`) and the token.
4. **Choose databases.** For each one:
   - **Date property:** which date is the event's time (a database can be added twice, with two
     date properties).
   - **Rows:** the whole database, or one of its calendar views (only the rows its filter keeps).
   - **Colour by:** the calendar's colour, or a select or status property's option colours.
   - **Only mine:** only rows with you in a people property. Choose the property and yourself.
   - **Notify:** none, at the start, or 5, 10 (the default), 30 or 60 minutes before.

The token is kept encrypted with your system's keyring (GNOME Keyring, KWallet, Windows' DPAPI).
If the system has none, the sidebar says so, and the token is stored as is on this computer.

## Connect Google Calendar

1. **In the calendar,** choose **Connect Google Calendar** (in the sidebar).
2. **Sign in with Google.** Your browser opens Google's page; allow access, then go back to the
   calendar. It asks to see your calendars and to read and change their events.
3. **Choose calendars** to show. Each keeps its Google colour (change it in the calendar's ⋯
   menu).

The packages CI and releases make have the calendar's own Google client built in
([how it's set up](../google-oauth.md)). **Your own client (optional,** and needed in a build
without one, such as a local `pnpm package`): in the
[Google Cloud console](https://console.cloud.google.com/), make or pick a project, turn on the
**Google Calendar API**, set up the **OAuth consent screen** (for yourself, "External" in testing
mode with your address as a test user is enough), and make an **OAuth client ID** of type
**Desktop app**. Then in **Settings → Google Calendar**, **Use my own client** and paste its ID
and secret. **Use the calendar's client** goes back to the built-in one. A sign-in belongs to the
client it was made with: after changing it, sign in with Google again.

The sign-in is kept encrypted like Workspace tokens. Removing the account (its ⋯ menu) also tells
Google to forget it.

Google events happen at a real moment, so they show at your computer's clock time for it (a
10:00 meeting in Berlin shows at 14:30 in India), and move if you change time zone. Workspace
dates have no zone and stay as written.

**Changing Google events** works as for Workspace rows: drag, resize, the panel, Delete with
Undo. Calendars your account may only see (shared as "See all event details" or "See only
free/busy") show without editing. A recurring event asks which occurrences a change or delete is
for:

- **This event:** only this one (Google keeps it as an exception of the series).
- **This and following events:** the series ends before this one, and a new series with the
  change goes on from it.
- **All events:** the whole series, moved by as much as you moved this one.

If someone changed the event in Google while your change waited (offline, say), your change
still goes and the panel shows **Changed elsewhere** with what Google had.

**Google Meet:** an event with a Meet call has **Join Google Meet** in its panel. On Windows the
reminder notification has a **Join** button too; on Linux, click the notification to open the
event.

## Connect a CalDAV account

CalDAV is how Nextcloud, Fastmail, Radicale, iCloud, mailbox.org and many other services share
calendars. Choose **Connect CalDAV** (in the sidebar), and enter:

- **Server address:** your service's address, such as `https://cloud.example.com` for
  Nextcloud, `https://caldav.fastmail.com` for Fastmail, or `https://caldav.icloud.com` for
  iCloud. The calendar finds the account's calendars from there.
- **Username**, and an **app password**: make one for this calendar in your account's security
  settings (Nextcloud: Settings → Security → Devices & sessions; Fastmail: Settings → Privacy &
  Security → App passwords; iCloud: appleid.apple.com → App-Specific Passwords). The calendar
  keeps it encrypted like the other accounts' sign-ins; addresses must be `https://` (except on
  this computer), because the password goes with every request.

Then choose the calendars to show. Their events can be changed here as anywhere: drag, resize,
the panel, Delete with Undo, and for recurring events **This event**, **This and following
events** or **All events**. Changes reach the server at once (or when it's back, if you're
offline); changes made elsewhere show within a minute, or at once with **Sync now**. If an event
changed on the server while your change waited, your change still goes, and the panel shows
**Changed elsewhere** with what the server had.

## Subscribe to a calendar (ICS)

Many calendars are published as an address: public holidays, sports fixtures, a school's terms,
a team's schedule, or another calendar app's "secret address in iCal format". Choose
**Subscribe to a calendar** (in the sidebar), paste the address (`https://…`, `http://…` or
`webcal://…`), and optionally give it a name (otherwise the feed's own name is used).

- Subscribed calendars are **read-only** here, and have **no reminders** until you choose some
  in the calendar's ⋯ menu.
- They're checked for changes **every 30 minutes**, and at once with **Sync now** (the
  sidebar's ↻). A feed that hasn't changed costs almost nothing to check.
- Recurring events, exceptions and time zones in the feed are followed, including Outlook's
  zone names. Times a feed gives without a zone show at the same clock time wherever you are.
- If the feed moves away (its address answers "not found"), the calendar shows ⚠ and keeps the
  events it had; remove it (its ⋯ menu) or subscribe to the new address.

## Use it

- **Views:** day, week, 2–6 days, month and agenda (the next 30 days). The mini month in the
  sidebar jumps to any day; the checkboxes show and hide calendars; a calendar's menu (⋯) sets
  its colour and notifications, or removes it.
- **Create:** drag on empty space in the day or week view, or press `c`. Name it in the panel and
  press Enter. In the month view, click a day's empty space for an all-day event.
- **Change:** drag an event to move it, drag its bottom edge to change when it ends, or drag it
  onto the row of all-day events (and back). Click an event to open its panel: title, start and
  end, all day. The row's other properties show there too (read-only), with **Open in
  Workspace**.
- **Delete:** Delete in the panel, or the Delete key. **Undo** (or Ctrl+Z) takes it back for a few
  seconds; after that the row goes to Workspace's trash, where it can be restored.
- **Find:** Ctrl+K opens the command bar. Type a date (`friday`, `dec 25`, `2027-03-15`), a
  command (`month view`, `sync now`) or part of an event's title.
- **Keyboard:** `t` today, `d`/`w`/`m`/`a` views, `1`–`7` that many days, `j`/`k` or the arrows to
  move, `c` create, `Delete`, `Esc` to close, `?` for the full list.

**Times and time zones.** Workspace dates have no time zone: an event at 10:00 is at 10:00
wherever you are, in the calendar as in Workspace. Settings can show a second time zone as
another column of hours.

## Notifications and the tray

- **Notifications** come from your system before events, as set for each calendar. All-day events
  notify at 09:00. Clicking a notification opens the event; on Windows the notification has a
  **Snooze 5 minutes** button, and on Linux the panel it opens has **Remind me in 5 minutes**.
  Workspace's own date reminders aren't available to the calendar (the API doesn't have them), so
  set the calendar's own.
- **The tray icon** shows the next event and today's list. On GNOME it needs the AppIndicator
  extension (Ubuntu has it; the `.deb` suggests it). Without it, everything else works.
- **In the background:** in Settings, "Keep running in the tray when the window is closed" keeps
  notifications coming with the window closed. "Start when I log in" starts the calendar in the
  tray.

## Offline, and how it stays in sync

- Everything shown comes from a copy on your computer, so the calendar opens and works offline.
  Changes you make offline wait and are sent when the server is back (the sidebar says
  "Offline").
- It reads changes every minute while open (every 5 minutes in the tray), and at once when the
  window comes to the front or the computer wakes. **Sync now** (the sidebar's ↻) also checks for
  rows deleted in Workspace; it happens on its own every 15 minutes.
- If a row was changed in Workspace while your change to it was waiting, your change still goes,
  and the panel shows **Changed elsewhere** with what Workspace had.

## When something's wrong

| What you see                                      | What to do                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| "The token was not accepted"                      | The integration was deleted or its token renewed. Remove the account (its ⋯ menu) and connect again.  |
| A calendar with ⚠ "no longer connected"           | In Workspace, add the integration to the database again (Share → Connections).                        |
| A calendar with ⚠ about its date property         | The property was renamed to another type or deleted. Remove the calendar and add it again.            |
| "No databases are connected to this integration"  | Do step 2 above, then **Look again**.                                                                 |
| No tray icon on GNOME                             | Install and turn on the AppIndicator extension (`gnome-shell-extension-appindicator`).                |
| An edit "couldn't be saved to Workspace"          | Workspace refused it five times (the message says why); the calendar shows Workspace's version again. |
| "Google signed this account out"                  | The access was removed in your Google account, or the client changed. Sign in with Google again.      |
| A Google calendar with ⚠ "can no longer see"      | The calendar was deleted or unshared in Google. Remove it here.                                       |
| A subscribed calendar with ⚠                      | The feed moved, went away or isn't a calendar any more. Remove it and subscribe to its new address.   |
| "The server refused the username or app password" | The app password was revoked or mistyped. Make a new one, then Connect CalDAV again with it.          |

**Logs** are in the calendar's data folder, in `logs/` (`~/.config/Workspace Calendar/logs` on
Linux, `%APPDATA%\Workspace Calendar\logs` on Windows). They have what the calendar did and what
failed, never tokens or event contents.

## For developers

The code is in [`apps/calendar`](../../apps/calendar/README.md). Its integration and end-to-end
tests start a real Workspace server themselves (from `apps/server`, on a throwaway Postgres), and
a real CalDAV server (Radicale) for the CalDAV tests, so `pnpm --filter @workspace/calendar test`
and `test:e2e` need PostgreSQL and Radicale installed (`pip install radicale==3.9.2`, or set
`RADICALE_PYTHON` to a Python that has it).

To try it against a server of your own:

```sh
git clone https://github.com/Ariehant/Workspace.git
cd Workspace/infra
cp .env.example .env     # set DOMAIN=localhost and POSTGRES_PASSWORD
docker compose up -d --build
```

Sign up in the browser (the first account is the admin), make a database with a date property,
then follow [Connect Workspace](#connect-workspace) above.
