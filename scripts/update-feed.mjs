// The update feed (the `updates` release): from a release's electron-builder feed files, the
// files the apps read (src/main/update-channel.ts in each app), pointing at that release's
// packages by absolute URL.
//
//   node scripts/update-feed.mjs <tag> <dir with latest.yml, latest-linux.yml, calendar.yml,
//                                calendar-linux.yml> <out dir>
//
// A release candidate (v1.2.3-rc.1) writes the candidates' channels only (rc, calendar-rc), so
// people on releases never get one. A release writes both, so people on candidates move up to it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.GITHUB_REPOSITORY || 'Ariehant/Workspace';
const [tag, from, out] = process.argv.slice(2);
if (!tag || !from || !out) {
  console.error('Usage: node scripts/update-feed.mjs <tag> <feed files dir> <out dir>');
  process.exit(1);
}
const candidate = tag.includes('-');
const base = `https://github.com/${REPO}/releases/download/${tag}/`;

/** electron-builder's channel file, with each file's `url` and the `path` made absolute. */
export function pointAt(yml, baseUrl) {
  return yml.replace(/^(\s*(?:- )?url: |path: )(.+)$/gm, (line, key, value) => {
    const name = value.trim().replace(/^['"]|['"]$/g, '');
    return /^https?:/.test(name) ? line : `${key}${baseUrl}${encodeURIComponent(name)}`;
  });
}

// Each app's release channel, and its candidates' channel.
const CHANNELS = [
  ['latest', 'rc'],
  ['calendar', 'calendar-rc'],
];
mkdirSync(out, { recursive: true });
for (const [release, rc] of CHANNELS) {
  for (const suffix of ['', '-linux']) {
    const yml = pointAt(readFileSync(join(from, `${release}${suffix}.yml`), 'utf8'), base);
    if (!yml.includes(base)) throw new Error(`${release}${suffix}.yml: no file to point at`);
    const names = candidate ? [rc] : [release, rc];
    for (const name of names) {
      writeFileSync(join(out, `${name}${suffix}.yml`), yml);
      console.log(`${name}${suffix}.yml → ${tag}`);
    }
  }
}
