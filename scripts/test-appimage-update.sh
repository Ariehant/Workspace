#!/usr/bin/env bash
# An AppImage updates itself: build the current version and a newer one, serve the newer one
# as an update feed, run the older one with --update-check, and check that it was replaced by
# the newer one. Run from the repository root; needs xvfb-run. Used by the release workflow.
#
#   scripts/test-appimage-update.sh [desktop | calendar]     (default: desktop)
set -euo pipefail

app="${1:-desktop}"
case "$app" in
  desktop)
    dir=apps/desktop
    filter=@workspace/desktop
    exe=workspace-app
    feed_var=WORKSPACE_UPDATE_URL
    data_var=WORKSPACE_DATA_DIR
    channel=latest
    ;;
  calendar)
    dir=apps/calendar
    filter=@workspace/calendar
    exe=workspace-calendar
    feed_var=CALENDAR_UPDATE_URL
    data_var=CALENDAR_DATA_DIR
    channel=calendar
    ;;
  *)
    echo "Usage: $0 [desktop | calendar]" >&2
    exit 2
    ;;
esac

work="$(mktemp -d)"
trap 'kill "${server_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
current="$(node -p "require('./$dir/package.json').version")"
newer="$(node -p "const [a, b, c] = '$current'.split('-')[0].split('.').map(Number); [a, b, c + 1].join('.')")"
# Built outside dist/, so the release's own packages are left alone.
package() { (cd "$dir" && npx electron-builder --linux AppImage --publish never \
  "--config.directories.output=$1" >/dev/null); }

echo "$app: building $current and $newer…"
pnpm --filter "$filter" exec electron-vite build >/dev/null
package "$work/current"
mkdir -p "$work/install" "$work/feed"
cp "$work"/current/*.AppImage "$work/install/"
node scripts/version.mjs set "$newer"
trap 'node scripts/version.mjs set "$current" >/dev/null; kill "${server_pid:-0}" 2>/dev/null || true; rm -rf "$work"' EXIT
pnpm --filter "$filter" exec electron-vite build >/dev/null
package "$work/newer"
# The feed as the Release workflow publishes it, under the channel the current version follows
# (a release candidate's: rc, calendar-rc).
track="$channel"
if [[ "$current" == *-* ]]; then
  if [ "$app" = desktop ]; then track=rc; else track="$channel-rc"; fi
fi
cp "$work"/newer/*.AppImage "$work/feed/"
cp "$work/newer/$channel-linux.yml" "$work/feed/$track-linux.yml"
node scripts/version.mjs set "$current" >/dev/null

port=$((20000 + RANDOM % 20000))
python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/feed" >/dev/null 2>&1 &
server_pid=$!
sleep 1

old="$(ls "$work"/install/*.AppImage)"
chmod +x "$old"
echo "Running $current with an update feed…"
env APPIMAGE_EXTRACT_AND_RUN=1 "$data_var=$work/data" "$feed_var=http://127.0.0.1:$port" \
  xvfb-run -a "$old" --no-sandbox --update-check 2>&1 | grep 'update-check' | tee "$work/log"
grep -q "update-check: downloaded $newer" "$work/log"

installed="$(ls "$work"/install/*.AppImage)"
chmod +x "$installed"
# Unpacked once, so the version isn't mixed into the extraction listing.
(cd "$work" && "$installed" --appimage-extract >/dev/null)
got="$("$work/squashfs-root/$exe" --no-sandbox --print-version 2>/dev/null)"
echo "Installed now: $(basename "$installed"), version $got"
test "$got" = "$newer"
echo "$app: AppImage update ok"
