#!/usr/bin/env bash
# An AppImage updates itself: build the current version and a newer one, serve the newer one
# as an update feed, run the older one with --update-check, and check that it was replaced by
# the newer one. Run from the repository root; needs xvfb-run. Used by the release workflow.
set -euo pipefail

work="$(mktemp -d)"
trap 'kill "${server_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
current="$(node -p "require('./apps/desktop/package.json').version")"
newer="$(node -p "const [a, b, c] = '$current'.split('-')[0].split('.').map(Number); [a, b, c + 1].join('.')")"
# Built outside dist/, so the release's own packages are left alone.
package() { (cd apps/desktop && npx electron-builder --linux AppImage --publish never \
  "--config.directories.output=$1" >/dev/null); }

echo "Building $current and $newer…"
pnpm --filter @workspace/desktop exec electron-vite build >/dev/null
package "$work/current"
mkdir -p "$work/install" "$work/feed"
cp "$work"/current/*.AppImage "$work/install/"
node scripts/version.mjs set "$newer"
trap 'node scripts/version.mjs set "$current" >/dev/null; kill "${server_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
package "$work/newer"
cp "$work"/newer/*.AppImage "$work"/newer/latest-linux.yml "$work/feed/"
node scripts/version.mjs set "$current" >/dev/null

port=$((20000 + RANDOM % 20000))
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/feed" >/dev/null 2>&1 &
server_pid=$!
sleep 1

old="$(ls "$work"/install/*.AppImage)"
chmod +x "$old"
echo "Running $current with an update feed…"
APPIMAGE_EXTRACT_AND_RUN=1 WORKSPACE_DATA_DIR="$work/data" \
  WORKSPACE_UPDATE_URL="http://127.0.0.1:$port" \
  xvfb-run -a "$old" --no-sandbox --update-check 2>&1 | grep 'update-check' | tee "$work/log"
grep -q "update-check: downloaded $newer" "$work/log"

installed="$(ls "$work"/install/*.AppImage)"
chmod +x "$installed"
# Unpacked once, so the version isn't mixed into the extraction listing.
(cd "$work" && "$installed" --appimage-extract >/dev/null)
got="$("$work/squashfs-root/workspace-app" --no-sandbox --print-version 2>/dev/null)"
echo "Installed now: $(basename "$installed"), version $got"
test "$got" = "$newer"
echo "AppImage update: ok"
