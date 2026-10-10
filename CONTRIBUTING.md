# Contributing

Thanks for helping with Workspace. This page covers setting up, how the repository is laid out,
and what a change needs before it's merged.

## Set up

You need Node.js 22.13 or later (24 LTS recommended) and pnpm 10.

```sh
corepack enable        # pnpm, at the version package.json pins
pnpm install
pnpm dev               # the desktop app with hot reload
```

The server's tests start a throwaway Postgres on their own; nothing else needs installing. For
the end-to-end tests on a machine without a display, use `xvfb-run`.

## Where things are

The [README](README.md#architecture) has a map of the packages. In short: `apps/` are the things
you run (desktop, server, web), `packages/` are the libraries they share, and `infra/` deploys
the server. The design and the reasons behind it are in [docs/PLAN.md](docs/PLAN.md), and each
phase's plan and notes (what changed from the plan, and why) are in `docs/PHASE*.md`.

## Before you push

Run what CI runs:

```sh
pnpm format:check      # Prettier
pnpm lint              # ESLint, and every link in the Markdown docs
pnpm typecheck
pnpm test              # unit and integration tests
```

If you changed the UI, the desktop app or the server, run the end-to-end tests too:

```sh
pnpm --filter @workspace/desktop build
pnpm --filter @workspace/web build
xvfb-run -a pnpm test:e2e
pnpm test:e2e:web
```

## Performance

`packages/perf` generates a large workspace (a page of 10,000 blocks and a database of
50,000 rows with formulas, relations and rollups) and measures it against the budgets in
[`packages/perf/src/budgets.ts`](packages/perf/src/budgets.ts). CI runs both suites on every
pull request and fails on a result over its limit, or 20% slower than the base branch's last
run.

```sh
pnpm --filter @workspace/perf bench          # the pure code: decode, views, search
pnpm --filter @workspace/desktop build
cd apps/desktop
PERF=1 xvfb-run -a npx playwright test e2e/perf.spec.ts   # the app: open, type, filter, scroll, sync
```

Set `PERF_RESULTS=<file>` to record the results as JSON, and compare two runs with
`node --experimental-strip-types packages/perf/src/report.ts results.json [baseline.json]`.
`PERF_ROWS` and `PERF_BLOCKS` change the sizes. To profile the app, build it with
`WORKSPACE_NO_MINIFY=1` so function names stay readable.

## What a change needs

- **Tests** for the behaviour it adds or fixes: unit tests next to the code, and an end-to-end
  test for anything a person does in the app.
- **Docs:** update the user guides in [`docs/`](docs/README.md) when behaviour changes, and the
  current phase's notes when the plan changes.
- **Plain, specific writing:** short sentences, the terms the code and the app use, and no
  marketing words, in code comments and docs alike.
- **No secrets or personal data** in code, tests, fixtures or screenshots.

## Screenshots

The README's screenshots come from a Playwright spec that builds a workspace from the built-in
templates. To make them again after a UI change:

```sh
pnpm --filter @workspace/desktop build
cd apps/desktop
README_SHOTS=../../docs/images xvfb-run -a npx playwright test e2e/readme-shots.spec.ts
```

The comments, automations and API screenshots come from the end-to-end tests that cover those
features (`WORKSPACE_SHOTS=<dir>` saves their screenshots).

## Links

`pnpm lint` checks every relative link and `#anchor` in the repository's Markdown files. To check
the external links too (it needs network access):

```sh
pnpm check:links --external
```
