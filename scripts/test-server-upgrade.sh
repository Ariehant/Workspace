#!/usr/bin/env bash
# A server upgrades in place: build an older server (default: the Phase 6 exit, the last
# release-ready state before Phase 7) from a git worktree, let it write a workspace, then start
# this one on the same database and files and check everything (apps/server/src/upgrade.test.ts).
# Run from the repository root: scripts/test-server-upgrade.sh [git ref]
set -euo pipefail

ref="${1:-e2cda2b}"
work="$(mktemp -d)"
trap 'git worktree remove --force "$work/old" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

echo "Building the server at $ref…"
git worktree add --detach "$work/old" "$ref" >/dev/null
(cd "$work/old" && pnpm install --frozen-lockfile --prefer-offline >/dev/null)
(cd "$work/old/apps/server" && node build.mjs)

echo "Upgrading from it…"
cd apps/server
WORKSPACE_UPGRADE_FROM="$work/old/apps/server/dist/main.js" npx vitest run src/upgrade.test.ts
