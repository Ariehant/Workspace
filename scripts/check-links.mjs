#!/usr/bin/env node
/**
 * Check the links in the repository's Markdown files (tracked, or new and not ignored).
 *
 * - Relative links must point at a file or folder that exists.
 * - `#anchors` must match a heading in the target file (GitHub's slugs), or an explicit
 *   `<a id="…">` / `<a name="…">`.
 * - With `--external`, http(s) links are fetched too (HEAD, then GET), and must not
 *   answer 404 or 410 or fail to resolve. Off by default: CI checks what the repo controls.
 *
 * Usage: node scripts/check-links.mjs [--external] [files…]
 * Exits with 1 and lists every broken link if there are any.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2);
const external = args.includes('--external');
const given = args.filter((a) => !a.startsWith('--'));

const files = given.length
  ? given.map((f) => resolve(f))
  : execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((f) => join(root, f));

/** Markdown without fenced code blocks and inline code (links there aren't links). */
function prose(text) {
  const lines = text.split('\n');
  let fence = null;
  return lines
    .map((line) => {
      const open = /^\s*(```+|~~~+)/.exec(line);
      if (fence) {
        if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
        return '';
      }
      if (open) {
        fence = open[1];
        return '';
      }
      return line.replace(/(`+)[^`]*?\1/g, '');
    })
    .join('\n');
}

/** GitHub's heading slugs for a file, duplicates numbered as GitHub does. */
const anchorCache = new Map();
function anchorsOf(file) {
  let anchors = anchorCache.get(file);
  if (anchors) return anchors;
  anchors = new Set();
  const counts = new Map();
  const text = prose(readFileSync(file, 'utf8'));
  for (const line of text.split('\n')) {
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[1]);
      const n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      anchors.add(n === 0 ? base : `${base}-${n}`);
    }
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(m[1]);
  }
  anchorCache.set(file, anchors);
  return anchors;
}

function slug(heading) {
  return heading
    .replace(/<[^>]+>/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

/** Every link target in a file: inline links, images, reference definitions, and HTML. */
function linksOf(text) {
  const found = [];
  const body = prose(text);
  body.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(
      /!?\[(?:[^\]]|\][^(])*?\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    )) {
      found.push({ target: m[1], line: i + 1 });
    }
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+".*")?\s*$/.exec(line);
    if (def) found.push({ target: def[1], line: i + 1 });
    for (const m of line.matchAll(/<(?:a|img|source)\s[^>]*?(?:href|src|srcset)="([^"]+)"/g)) {
      found.push({ target: m[1].split(/\s/)[0], line: i + 1 });
    }
  });
  return found;
}

const problems = [];
const externalLinks = new Map();

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  for (const { target, line } of linksOf(text)) {
    const where = `${relative(root, file)}:${line}`;
    if (/^https?:\/\//.test(target)) {
      if (!externalLinks.has(target)) externalLinks.set(target, where);
      continue;
    }
    if (/^(mailto|tel|data|workspace):/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const decoded = decodeURIComponent(path ?? '');
    const dest = decoded ? resolve(dirname(file), decoded) : file;
    if (decoded && !existsSync(dest)) {
      problems.push(`${where}: ${target} (no such file)`);
      continue;
    }
    if (anchor !== undefined && anchor !== '' && dest.endsWith('.md') && statSync(dest).isFile()) {
      if (!anchorsOf(dest).has(decodeURIComponent(anchor).toLowerCase())) {
        problems.push(`${where}: ${target} (no heading #${anchor} in ${relative(root, dest)})`);
      }
    }
  }
}

if (external) {
  const check = async (url) => {
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, {
          method,
          redirect: 'follow',
          signal: AbortSignal.timeout(15_000),
          headers: { 'user-agent': 'workspace-link-check' },
        });
        if (res.status === 404 || res.status === 410) return `HTTP ${res.status}`;
        if (res.ok || method === 'GET') return null;
      } catch (error) {
        if (method === 'GET') return error instanceof Error ? error.message : String(error);
      }
    }
    return null;
  };
  const entries = [...externalLinks];
  const results = await Promise.all(entries.map(([url]) => check(url)));
  results.forEach((problem, i) => {
    if (problem) problems.push(`${entries[i][1]}: ${entries[i][0]} (${problem})`);
  });
}

const checked = files.length;
if (problems.length) {
  console.error(`Broken links (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Links OK in ${checked} Markdown files${external ? `, ${externalLinks.size} external links included` : ''}.`,
);
