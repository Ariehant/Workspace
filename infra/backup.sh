#!/bin/sh
# Back up the sync server: a Postgres dump and the attachments.
#   ./backup.sh [target-dir]   (run from the folder with docker-compose.yml and .env)
# With docker-compose.s3.yml, attachments live in your S3 bucket: back that up with
# the provider's tools (e.g. `mc mirror` or `aws s3 sync`) instead.
set -eu
target="${1:-./backups}/$(date +%Y-%m-%d_%H%M%S)"
mkdir -p "$target"
compose="docker compose --env-file ${ENV_FILE:-.env}"

echo "Dumping the database..."
$compose exec -T postgres pg_dump -U workspace -Fc workspace > "$target/workspace.dump"

echo "Copying attachments..."
$compose cp server:/data/files "$target/files"

echo "Backup written to $target"
echo "Restore: docker compose exec -T postgres pg_restore -U workspace -d workspace --clean < workspace.dump"
echo "         docker compose cp files/. server:/data/files"
