import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStore, SqliteStore, isFileId, parseLinkPreview } from './index';

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-files-'));
  store = new SqliteStore(join(dir, 'workspace.db'));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FileStore', () => {
  it('stores files by content hash and keeps metadata', () => {
    const files = new FileStore(dir, store);
    const bytes = new TextEncoder().encode('hello');
    const a = files.import(bytes, 'Notes.TXT', 'text/plain');
    expect(a.id).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.txt');
    expect(a).toMatchObject({ name: 'Notes.TXT', mime: 'text/plain', size: 5 });
    expect(readFileSync(files.resolve(a.id)!, 'utf8')).toBe('hello');

    // Same content again: same id, original metadata kept.
    const b = files.import(bytes, 'copy.txt', 'text/plain');
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('Notes.TXT');
  });

  it('rejects ids that could escape the files directory', () => {
    const files = new FileStore(dir, store);
    expect(files.resolve('../workspace.db')).toBeNull();
    expect(files.resolve('a'.repeat(64) + '.png')).toBeNull(); // valid shape, not stored
    expect(isFileId('a'.repeat(64) + '/x')).toBe(false);
    expect(isFileId('A'.repeat(64))).toBe(false);
  });

  it('survives reopening the database (migration 2 applied once)', () => {
    const files = new FileStore(dir, store);
    const { id } = files.import(new Uint8Array([1, 2, 3]), 'x.bin', '');
    store.close();
    store = new SqliteStore(join(dir, 'workspace.db'));
    expect(store.getFileRecord(id)).toMatchObject({ mime: 'application/octet-stream', size: 3 });
    expect(existsSync(join(dir, 'files', id))).toBe(true);
  });
});

describe('link previews', () => {
  it('prefers Open Graph tags and resolves relative URLs', () => {
    const html = `<!doctype html><html><head>
      <title>Fallback title</title>
      <meta property="og:title" content="ROS 2 &amp; Navigation">
      <meta name="description" content="Plain description">
      <meta property="og:description" content="Open Graph description">
      <meta property="og:image" content="/img/card.png">
      <meta property="og:site_name" content="Robotics Docs">
      <link rel="icon" href="/favicon.svg">
      </head><body><meta property="og:title" content="ignored"></body></html>`;
    expect(parseLinkPreview(html, 'https://docs.example.org/nav/intro')).toEqual({
      url: 'https://docs.example.org/nav/intro',
      title: 'ROS 2 & Navigation',
      description: 'Open Graph description',
      image: 'https://docs.example.org/img/card.png',
      icon: 'https://docs.example.org/favicon.svg',
      siteName: 'Robotics Docs',
    });
  });

  it('falls back to <title>, the host and /favicon.ico', () => {
    const preview = parseLinkPreview('<title> Plain\n page </title>', 'http://example.com/a');
    expect(preview).toMatchObject({
      title: 'Plain page',
      description: '',
      image: null,
      icon: 'http://example.com/favicon.ico',
    });
    expect(parseLinkPreview('', 'https://empty.example/').title).toBe('empty.example');
  });

  it('caches previews with an expiry', () => {
    store.putLinkPreview('https://a.example/', { title: 'A' });
    expect(store.getLinkPreview('https://a.example/', 60_000)).toEqual({ title: 'A' });
    expect(store.getLinkPreview('https://a.example/', -1)).toBeNull();
  });
});
