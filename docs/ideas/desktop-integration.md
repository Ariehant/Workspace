# Idea: the desktop app as a native productivity app

**Status: parked (2026-11-21).** Written down to come back to; nothing here is built or
scheduled.

## The idea

From the owner: rather than a phone web app, make the existing desktop app better, with the kind
of features that native GNOME and Windows productivity apps have. For example, when you add an
event in GNOME Calendar, its notifications and the day's updates show in the top bar, every day.
Features like that, that don't make the app heavy on memory but make day-to-day work flow better.

## Candidates

Each of these should cost little memory or CPU when idle:

- **Notifications for dated rows and reminders,** from the operating system, even when the
  window is closed (the app keeps running in the tray).
- **Today in the top bar or tray:** a tray icon (an AppIndicator in GNOME's top bar, the
  notification area on Windows) with today's dated items and the next one, and a click to open
  it.
- **Start at login,** minimised to the tray.
- **Quick capture:** a global shortcut that opens a small window to add a page or a row to a
  chosen database without bringing up the whole app.
- **Deep links:** `workspace://` links that open a page in the app (from other apps, mail,
  the calendar app below).
- **Taskbar and launcher:** Windows jump lists (recent pages, quick capture) and a badge for
  unread inbox items; `.desktop` file actions on Linux.
- **A GNOME search provider,** so pages show in the Activities search.
- **Do Not Disturb:** follow the system's setting for notifications.
- **Power:** pause background sync and indexing on suspend and on battery (`powerMonitor`).

## Before starting

What the desktop app already has here (date reminders already notify inside the app; the inbox)
wasn't mapped when the idea was parked: do that first, then plan.

A related piece, a calendar app that works with Workspace through its API, is planned
separately: [calendar app handoff](../calendar-app/HANDOFF.md).
