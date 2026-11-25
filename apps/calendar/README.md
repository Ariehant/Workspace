# Workspace Calendar

A fast, keyboard-first desktop calendar (Electron) that shows Workspace's dated database rows
as events, through the Workspace server's public `/v1` API. The plan it follows is
[the handoff](../../docs/calendar-app/HANDOFF.md).

Status: **v1.0, milestone 1**. It connects to Workspace, lets you choose databases, and shows
their rows in a week view, kept in sync and cached for offline use. Editing, the other views,
notifications, the tray and packaging come in the next milestones.

## Develop

```sh
pnpm --filter @workspace/calendar dev        # run it with hot reload
pnpm --filter @workspace/calendar test       # unit tests, and integration tests against a real server
pnpm --filter @workspace/calendar build
xvfb-run -a pnpm --filter @workspace/calendar test:e2e   # end-to-end, on the built app
```

The integration and end-to-end tests start a real Workspace server (built from `apps/server`,
on a throwaway Postgres from the installed PostgreSQL), through `@workspace/server/testing`.

## How it's built

- `src/shared`: the date rules (Workspace's dates are wall-clock times with no zone), the
  mapping between rows and events, and the IPC types.
- `src/main`: the API client (rate limited, waits on `429`), the Workspace source, the SQLite
  cache (`node:sqlite`), syncing, and the window.
- `src/preload`: the window's only way to the main process. Tokens never reach the window.
- `src/renderer`: the React UI, on `@workspace/ui`.
