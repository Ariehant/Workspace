# Workspace Calendar: user guide

Workspace Calendar is a desktop calendar for Linux and Windows. It shows the dated rows of your
Workspace databases (tasks, meetings, deadlines, plans) as events, lets you create, move and
change them, and notifies you before they start. It talks to your Workspace server through its
API, so it shows what's on the server.

Version 1.0 works with Workspace databases. Google Calendar (1.1) and ICS feeds and CalDAV (1.2)
are planned: see [the build plan](HANDOFF.md).

## Install

- **Ubuntu 24.04 or later:** install the `.deb` (`sudo apt install ./workspace-calendar_*_amd64.deb`)
  or run the AppImage (`chmod +x Workspace-Calendar-*.AppImage`, then open it).
- **Windows:** run `Workspace-Calendar-Setup-*.exe`. It installs for your user, with a Start menu
  shortcut.

Until there's a release, CI builds the packages for every change: they're the
`calendar-linux-packages` and `calendar-windows-installer` artifacts of a CI run.

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
  extension (Ubuntu has it; the `.deb` recommends it). Without it, everything else works.
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

| What you see                                     | What to do                                                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| "The token was not accepted"                     | The integration was deleted or its token renewed. Remove the account (its ⋯ menu) and connect again.  |
| A calendar with ⚠ "no longer connected"          | In Workspace, add the integration to the database again (Share → Connections).                        |
| A calendar with ⚠ about its date property        | The property was renamed to another type or deleted. Remove the calendar and add it again.            |
| "No databases are connected to this integration" | Do step 2 above, then **Look again**.                                                                 |
| No tray icon on GNOME                            | Install and turn on the AppIndicator extension (`gnome-shell-extension-appindicator`).                |
| An edit "couldn't be saved to Workspace"         | Workspace refused it five times (the message says why); the calendar shows Workspace's version again. |

**Logs** are in the calendar's data folder, in `logs/` (`~/.config/Workspace Calendar/logs` on
Linux, `%APPDATA%\Workspace Calendar\logs` on Windows). They have what the calendar did and what
failed, never tokens or event contents.

## For developers

The code is in [`apps/calendar`](../../apps/calendar/README.md). Its integration and end-to-end
tests start a real Workspace server themselves (from `apps/server`, on a throwaway Postgres), so
`pnpm --filter @workspace/calendar test` and `test:e2e` need only PostgreSQL installed.

To try it against a server of your own:

```sh
git clone https://github.com/Ariehant/Workspace.git
cd Workspace/infra
cp .env.example .env     # set DOMAIN=localhost and POSTGRES_PASSWORD
docker compose up -d --build
```

Sign up in the browser (the first account is the admin), make a database with a date property,
then follow [Connect Workspace](#connect-workspace) above.
