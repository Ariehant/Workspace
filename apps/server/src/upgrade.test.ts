/**
 * Upgrading a server (Phase 7 release check): an older build (`WORKSPACE_UPGRADE_FROM`, the
 * path to its `dist/main.js`; see `scripts/test-server-upgrade.sh`) writes a workspace (a
 * desktop syncing pages, content and a database; an integration), then this build starts on
 * the same database and files. Everything reads back, and what's new works on the old data.
 * Skipped without an older build.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPage, getPageContent, listPages } from '@workspace/core';
import {
  addOption,
  addProperty,
  addRow,
  initDatabase,
  readDatabase,
  richOf,
} from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { unzipSync } from 'fflate';
import { afterAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';
import { VERSION } from './version';

const OLD = process.env.WORKSPACE_UPGRADE_FROM;
const cleanups: (() => unknown)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
const paragraph = (id: string, text: string) => {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('id', id);
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ROOT = '0e1f2a3b-0000-4000-8000-0000000000a1';
const NOTES = '0e1f2a3b-0000-4000-8000-0000000000a2';
const PARTS = '0e1f2a3b-0000-4000-8000-0000000000a3';
const SERVO = '0e1f2a3b-0000-4000-8000-0000000000a4';

describe.skipIf(!OLD)('upgrading from an older server', () => {
  it('keeps the workspace, accounts and integrations, and the new features work on it', async () => {
    const databaseUrl = await createTestDatabase(inject('pgUrl'));
    const dir = mkdtempSync(join(tmpdir(), 'workspace-upgrade-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = {
      DATABASE_URL: databaseUrl,
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_URL: base,
      FILES_DIR: join(dir, 'files'),
      SIGNUP: 'open',
      LOG_LEVEL: 'warn',
    };
    const http = async (method: string, path: string, token?: string, body?: object) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'x-workspace-client': 'test',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(path.startsWith('/v1') ? { 'notion-version': '2022-06-28' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: (await res.json().catch(() => null)) as Json };
    };

    // --- The older server writes a workspace. ---------------------------------------
    const old: ChildProcess = spawn('node', [OLD!], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const stopOld = () =>
      old.exitCode === null
        ? new Promise((resolve) => {
            old.once('exit', resolve);
            old.kill('SIGTERM');
          })
        : undefined;
    cleanups.push(stopOld);
    await until(
      () =>
        fetch(`${base}/api/ready`).then(
          (r) => r.ok,
          () => false,
        ),
      'old server up',
    );
    const oldVersion = (await http('GET', '/api/auth/config')).body.version as string;

    const signup = await http('POST', '/api/auth/signup', undefined, {
      email: 'ada@lab.io',
      name: 'Ada',
      password: 'long password',
      client: 'desktop',
    });
    const ada = { token: signup.body.token as string, id: signup.body.user.id as string };
    const ws = (await http('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
      .id as string;

    const device = new TestDevice({
      url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
      token: ada.token,
      deviceId: 'ada-old',
    });
    device.client.start();
    await until(() => device.client.state.state === 'live', 'desktop live on the old server');
    createPage(device.doc('workspace'), { id: ROOT, title: 'Robots' });
    createPage(device.doc('workspace'), { id: NOTES, title: 'Arm notes', parentId: ROOT });
    createPage(device.doc('workspace'), {
      id: PARTS,
      title: 'Parts',
      parentId: ROOT,
      kind: 'database',
    });
    getPageContent(device.doc(NOTES)).insert(0, [paragraph('n1', 'Torque limit 2 Nm.')]);
    const db = device.doc(PARTS);
    initDatabase(db, { databaseId: PARTS });
    const stock = addProperty(db, { name: 'Stock', type: 'number' });
    const kind = addProperty(db, { name: 'Kind', type: 'select' });
    addOption(db, kind, { id: 'k-motor', name: 'Motor', color: 'blue' });
    const notes = addProperty(db, { name: 'Notes', type: 'text' });
    addRow(db, {
      id: SERVO,
      actor: ada.id,
      title: 'Servo',
      values: { [stock]: 4, [kind]: 'k-motor', [notes]: 'Spare in drawer' },
    });
    await until(() => device.outbox.length === 0, 'the desktop’s changes on the old server');
    device.client.stop();

    // An integration, shared the pages.
    const made = await http('POST', `/api/workspaces/${ws}/integrations`, ada.token, {
      name: 'Lab bot',
    });
    const bot = { id: made.body.integration.id as string, token: made.body.token as string };
    const T = (await http('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
      .defaultScopeId as string;
    const shared = (
      await http('POST', `/api/workspaces/${ws}/pages/${ROOT}/share`, ada.token, { scope: T })
    ).body.scope as { id: string };
    expect(
      (
        await http('PUT', `/api/workspaces/${ws}/scopes/${shared.id}/access`, ada.token, {
          principal: `user:${bot.id}`,
          role: 'edit',
        })
      ).status,
    ).toBe(200);
    expect((await http('GET', `/v1/pages/${SERVO}`, bot.token)).status).toBe(200);
    await stopOld();

    // --- This server, on the same database and files. -------------------------------
    const store = new PgStore(databaseUrl, { max: 4 });
    await store.migrate();
    const app = buildServer({
      config: loadConfig(env),
      store,
      files: new FsStorage(env.FILES_DIR),
      mailer: null,
      indexDelayMs: 0,
    });
    await app.listen({ host: '127.0.0.1', port });
    cleanups.push(
      () => app.close(),
      () => store.close(),
    );
    expect((await http('GET', '/api/auth/config')).body.version).toBe(VERSION);
    expect(VERSION).not.toBe('');
    void oldVersion;

    // The same session still works; the desktop syncs and has everything.
    const after = new TestDevice({
      url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
      token: ada.token,
      deviceId: 'ada-new',
    });
    cleanups.push(() => after.client.stop());
    after.client.start();
    await until(() => after.client.state.state === 'live', 'desktop live on this server');
    // The pages (sharing Robots moved it, and what's under it, to a scope of its own).
    const titles = () =>
      [...after.docs.values()]
        .flatMap((doc) => listPages(doc))
        .map((p) => p.title)
        .filter((t) => ['Robots', 'Arm notes', 'Parts'].includes(t));
    await until(() => new Set(titles()).size === 3, 'the page tree');
    await until(() => getPageContent(after.doc(NOTES)).length > 0, 'page content');
    expect(getPageContent(after.doc(NOTES)).toString()).toContain('Torque limit 2 Nm.');
    await until(() => readDatabase(after.doc(PARTS)).rows.length === 1, 'the database');
    const row = readDatabase(after.doc(PARTS)).rows[0]!;
    expect(row.values).toMatchObject({ [stock]: 4, [kind]: 'k-motor', [notes]: 'Spare in drawer' });

    // The integration's token, its access and the API.
    const page = await http('GET', `/v1/pages/${SERVO}`, bot.token);
    expect(page.status).toBe(200);
    expect(page.body.properties).toMatchObject({
      Stock: { number: 4 },
      Kind: { select: { name: 'Motor' } },
      Notes: { rich_text: [{ plain_text: 'Spare in drawer' }] },
    });
    const query = await http('POST', `/v1/databases/${PARTS}/query`, bot.token, {});
    expect(query.body.results).toHaveLength(1);

    // New here: formatted text, on an old row; search; exports.
    const formatted = await http('PATCH', `/v1/pages/${SERVO}`, bot.token, {
      properties: {
        Notes: {
          rich_text: [
            { text: { content: 'Spare in ' } },
            { text: { content: 'drawer 3' }, annotations: { bold: true } },
          ],
        },
      },
    });
    expect(formatted.status).toBe(200);
    await until(
      () =>
        richOf(readDatabase(after.doc(PARTS)).rows[0]!, notes).some(
          (s) => s.bold && s.text === 'drawer 3',
        ),
      'formatted text on the desktop',
    );
    // Search (this server indexes what the old one hadn't yet).
    await until(
      async () =>
        JSON.stringify(
          (await http('GET', `/api/workspaces/${ws}/search?q=torque`, ada.token)).body,
        ).includes('Arm notes'),
      'search',
    );
    const exported = await fetch(`${base}/api/workspaces/${ws}/export`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ada.token}`,
        'content-type': 'application/json',
        'x-workspace-client': 'test',
      },
      body: JSON.stringify({ format: 'markdown', pageId: ROOT, includeSubpages: true }),
    });
    expect(exported.status).toBe(200);
    const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
    const notesFile = Object.entries(files).find(([path]) => path.includes('Arm notes'));
    expect(new TextDecoder().decode(notesFile?.[1])).toContain('Torque limit 2 Nm.');
  });
});
