#!/usr/bin/env bash
# Build (or add to) the apt repository that GitHub Pages serves, so `apt upgrade` updates the
# .deb. Signs the index with a GPG key when one is given.
#
#   scripts/apt-repo.sh <repo-dir> <deb>... [--key <gpg key id>]
#
# The repository: pool/main/ holds every release's .deb; dists/stable/ is the index, made
# again from the pool each time (needs apt-ftparchive, from apt-utils). Signed, it has
# InRelease and Release.gpg, and the public key as workspace-archive-keyring.gpg.
set -euo pipefail

repo="$1"
shift
debs=()
key=""
while [ $# -gt 0 ]; do
  case "$1" in
    --key) key="$2"; shift 2 ;;
    *) debs+=("$1"); shift ;;
  esac
done

mkdir -p "$repo/pool/main" "$repo/dists/stable/main/binary-amd64"
for deb in "${debs[@]}"; do cp "$deb" "$repo/pool/main/"; done

cd "$repo"
apt-ftparchive packages pool/main > dists/stable/main/binary-amd64/Packages
gzip -9 -k -f dists/stable/main/binary-amd64/Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Workspace \
  -o APT::FTPArchive::Release::Label=Workspace \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  -o APT::FTPArchive::Release::Description="Workspace for Ubuntu" \
  release dists/stable > dists/stable/Release

if [ -n "$key" ]; then
  rm -f dists/stable/InRelease dists/stable/Release.gpg
  gpg --batch --yes --default-key "$key" --clearsign -o dists/stable/InRelease dists/stable/Release
  gpg --batch --yes --default-key "$key" -abs -o dists/stable/Release.gpg dists/stable/Release
  gpg --batch --yes --export "$key" > workspace-archive-keyring.gpg
fi
echo "apt repository: $(ls pool/main | wc -l) package(s) in $repo"
