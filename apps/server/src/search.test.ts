import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_DOC_ID,
  createPage,
  getPageContent,
  setPageTitle,
  trashPage,
} from '@workspace/core';
import { addProperty, addRow, initDatabase } from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { runAdmin } from './admin-commands';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-search-'));
});
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
  rmSync(dir, { recursive: true, force: true });
});

const paragraph = (text: string) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};

async function setup() {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
  });
  const app = buildServer({ config, store, files: new FsStorage(dir), indexDelayMs: 20 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'x-workspace-client': 't' },
    payload: { email: 'ada@lab.io', name: 'Ada', password: 'long password', client: 'desktop' },
  });
  const { token, user } = res.json() as { token: string; user: { id: string } };
  const ws = await store.createWorkspace('Lab', user.id);
  const port = (app.server.address() as AddressInfo).port;
  const device = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws.id}`,
    token,
    deviceId: 'laptop',
  });
  cleanups.push(() => device.client.stop());
  const search = async (q: string, auth = token) =>
    (
      await app.inject({
        url: `/api/workspaces/${ws.id}/search?q=${encodeURIComponent(q)}`,
        headers: { authorization: `Bearer ${auth}` },
      })
    ).json() as {
      results: { id: string; title: string; databaseId: string | null; snippet: string }[];
    };
  return { app, store, ws, token, device, search };
}

const eventually = async <T>(fn: () => Promise<T>, check: (value: T) => boolean) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() - start > 10_000) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('server search', () => {
  it('indexes what devices sync: pages, content and database rows', async () => {
    const s = await setup();
    s.device.client.start();
    const workspace = s.device.doc(WORKSPACE_DOC_ID);
    const pageId = createPage(workspace, { title: 'Gripper design' });
    getPageContent(s.device.doc(pageId)).insert(0, [
      paragraph('The fingers are driven by a harmonic drive.'),
    ]);
    const dbId = createPage(workspace, { title: 'Parts', kind: 'database' });
    const db = s.device.doc(dbId);
    initDatabase(db, { databaseId: dbId });
    const supplier = addProperty(db, { name: 'Supplier', type: 'text' });
    const rowId = addRow(db, {
      actor: null,
      title: 'Servo motor',
      values: { [supplier]: 'Dynamixel' },
    });
    getPageContent(s.device.doc(rowId)).insert(0, [paragraph('Stall torque 2.5 Nm')]);

    const byContent = await eventually(
      () => s.search('harm'),
      (r) => r.results.length > 0,
    );
    expect(byContent.results).toEqual([
      expect.objectContaining({
        id: pageId,
        title: 'Gripper design',
        databaseId: null,
        snippet: expect.stringContaining('[harmonic]'),
      }),
    ]);
    const byProperty = await eventually(
      () => s.search('dynamix'),
      (r) => r.results.length > 0,
    );
    expect(byProperty.results).toEqual([
      expect.objectContaining({ id: rowId, title: 'Servo motor', databaseId: dbId }),
    ]);
    expect(
      (
        await eventually(
          () => s.search('stall torque'),
          (r) => r.results.length > 0,
        )
      ).results[0]!.id,
    ).toBe(rowId);

    // Renames and the trash follow.
    setPageTitle(workspace, pageId, 'End effector');
    expect(
      (
        await eventually(
          () => s.search('effector'),
          (r) => r.results.length > 0,
        )
      ).results[0]!.title,
    ).toBe('End effector');
    trashPage(workspace, dbId);
    expect(
      (
        await eventually(
          () => s.search('servo'),
          (r) => r.results.length === 0,
        )
      ).results,
    ).toEqual([]);
  });

  it('catches up at startup and rebuilds with workspace-admin reindex', async () => {
    const s = await setup();
    // Written straight into the log (as if before the server had search).
    const workspace = new Y.Doc();
    const pageId = createPage(workspace, { title: 'Calibration notes' });
    const content = new Y.Doc();
    getPageContent(content).insert(0, [paragraph('Use the checkerboard target.')]);
    await s.store.appendUpdates(s.ws.id, [
      { docId: WORKSPACE_DOC_ID, data: Y.encodeStateAsUpdate(workspace) },
      { docId: pageId, data: Y.encodeStateAsUpdate(content) },
    ]);
    expect((await s.search('checkerboard')).results).toEqual([]);
    await s.app.indexer.catchUp();
    expect(
      (
        await eventually(
          () => s.search('checkerboard'),
          (r) => r.results.length > 0,
        )
      ).results[0]!.id,
    ).toBe(pageId);

    await s.store.search.clear(s.ws.id);
    expect((await s.search('checkerboard')).results).toEqual([]);
    const out: string[] = [];
    const code = await runAdmin(s.store, ['reindex', s.ws.id], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
    });
    expect([code, out]).toEqual([0, ['Reindexed 1 workspace']]);
    expect((await s.search('calib')).results.map((r) => r.id)).toEqual([pageId]);
  });

  it('only searches workspaces you belong to', async () => {
    const s = await setup();
    const other = await s.app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 't' },
      payload: { email: 'eve@x.io', name: 'Eve', password: 'long password', client: 'desktop' },
    });
    const res = await s.app.inject({
      url: `/api/workspaces/${s.ws.id}/search?q=anything`,
      headers: { authorization: `Bearer ${other.json().token}` },
    });
    expect(res.statusCode).toBe(404);
    expect((await s.search('')).results).toEqual([]);
  });
});
