# Workspace Calendar

A fast, keyboard-first desktop calendar (Electron) that shows Workspace's dated database rows
as events, through the Workspace server's public `/v1` API. The plan it follows is
[the handoff](../../docs/calendar-app/HANDOFF.md).

Status: **v1.0** (three milestones). It connects to Workspace and shows chosen databases' rows as
events (day, week, 2–6 days, month and agenda), edits them (drag to create, move and resize, the
event panel, delete with Undo), notifies before events, and has a tray icon. Edits are sent in
the background and queued while offline. Packaged as `.deb`, AppImage and a Windows installer.
The user guide is [docs/calendar-app/README.md](../../docs/calendar-app/README.md).

## Develop

```sh
pnpm --filter @workspace/calendar dev        # run it with hot reload
pnpm --filter @workspace/calendar test       # unit tests, and integration tests against a real server
pnpm --filter @workspace/calendar build
xvfb-run -a pnpm --filter @workspace/calendar test:e2e   # end-to-end, on the built app
pnpm --filter @workspace/calendar package:linux          # .deb and AppImage in dist/
pnpm --filter @workspace/calendar package:win            # the NSIS installer (on Windows)
```

`--smoke-test` starts the app on a throwaway data folder, loads the window and quits (CI runs it
on the installed packages).

The integration and end-to-end tests start a real Workspace server (built from `apps/server`,
on a throwaway Postgres from the installed PostgreSQL), through `@workspace/server/testing`.

## How it's built

- `src/shared`: the date rules (Workspace's dates are wall-clock times with no zone), the
  mapping between rows and events, and the IPC types.
- `src/main`: the API client (rate limited, waits on `429`), the Workspace source, the SQLite
  cache (`node:sqlite`), syncing, the outbox (edits waiting to be sent), and the window.
- `src/preload`: the window's only way to the main process. Tokens never reach the window.
- `src/renderer`: the React UI, on `@workspace/ui`.
