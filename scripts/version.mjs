// The apps share one version, which a release sets from its tag (`v1.2.3`).
//
//   node scripts/version.mjs check        the apps' versions agree (part of `pnpm lint`)
//   node scripts/version.mjs set 1.2.3    set it in each app's package.json
import { readFileSync, writeFileSync } from 'node:fs';

const APPS = ['apps/calendar', 'apps/desktop', 'apps/server', 'apps/web'];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const file = (app) => new URL(`../${app}/package.json`, import.meta.url);
const read = (app) => JSON.parse(readFileSync(file(app), 'utf8'));

const [command, value] = process.argv.slice(2);
if (command === 'set') {
  const version = value?.replace(/^v/, '');
  if (!version || !SEMVER.test(version)) {
    console.error(`Not a version: ${value ?? '(none)'} (expected 1.2.3 or v1.2.3-rc.1)`);
    process.exit(1);
  }
  for (const app of APPS) {
    const pkg = read(app);
    pkg.version = version;
    writeFileSync(file(app), `${JSON.stringify(pkg, null, 2)}\n`);
  }
  console.log(`Version ${version}`);
} else if (command === 'check' || command === undefined) {
  const versions = APPS.map((app) => [app, read(app).version]);
  const distinct = new Set(versions.map(([, v]) => v));
  if (distinct.size !== 1) {
    console.error('The apps have different versions:');
    for (const [app, v] of versions) console.error(`  ${app}: ${v}`);
    process.exit(1);
  }
  console.log(`Version ${[...distinct][0]} in every app.`);
} else {
  console.error('Usage: node scripts/version.mjs [check | set <version>]');
  process.exit(1);
}
