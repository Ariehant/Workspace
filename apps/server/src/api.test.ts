/**
 * Phase 6 M5: integrations and the public API (`/v1`). Real server, real Postgres.
 *
 * Ada (owner) has "Robots" (with a sub-page and a database "Parts") and "Secrets" in
 * the first teamspace. She makes an integration "Lab bot" and shares Robots with it.
 * Bob is a member.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  commentsDocId,
  createPage,
  createThread,
  getMembersMap,
  listPages,
  readThreads,
  setResolved,
} from '@workspace/core';
import { addOption, addProperty, addRow, initDatabase, readDatabase } from '@workspace/database';
import { appendContent, contentJson } from '@workspace/editor';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';

import { APIResponseError, Client, collectPaginatedAPI, isFullPage } from '@notionhq/client';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-api-'));
});
// Each test's server and pool go when it ends (Postgres has only so many connections).
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const until = async (done: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const start = Date.now();
  while (!(await done())) {
    if (Date.now() - start > ms) throw new Error(`Timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

async function world(
  api: { perSecond?: number; burst?: number } = { perSecond: 1000, burst: 1000 },
) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 8 });
  await store.migrate();
  const config = loadConfig({
    DATABASE_URL: 'postgres://unused',
    LOG_LEVEL: 'silent',
    FILES_DIR: dir,
    SIGNUP: 'open',
    PUBLIC_URL: 'http://app.test',
  });
  const app = buildServer({ config, store, files: new FsStorage(dir), mailer: null, api });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  cleanups.push(
    () => app.close(),
    () => store.close(),
  );
  const call = async (method: string, url: string, token: string, payload?: object) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as Json };
  };
  const v1 = async (
    method: string,
    path: string,
    token: string,
    payload?: object,
    version: string | null = '2022-06-28',
  ) => {
    const res = await app.inject({
      method: method as 'GET',
      url: `/v1${path}`,
      payload,
      headers: {
        authorization: `Bearer ${token}`,
        ...(version && { 'notion-version': version }),
      },
    });
    return { status: res.statusCode, body: res.json() as Json, headers: res.headers };
  };
  const signup = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/signup',
      headers: { 'x-workspace-client': 'test' },
      payload: { email: `${name}@lab.io`, name, password: 'long password', client: 'desktop' },
    });
    return { token: res.json().token as string, id: res.json().user.id as string };
  };
  const ada = await signup('ada');
  const bob = await signup('bob');
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).body.workspace
    .id as string;
  const invite = await call('POST', `/api/workspaces/${ws}/invites`, ada.token, {
    emails: ['bob@lab.io'],
    role: 'member',
  });
  const code = (invite.body.invites[0].link as string).split('/invite/')[1];
  await call('POST', `/api/invites/${code}/accept`, bob.token);
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body
    .defaultScopeId as string;

  const a = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
    token: ada.token,
    deviceId: 'ada-1',
  });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  const settled = () => until(() => a.outbox.length === 0, 'outbox sent');
  createPage(a.doc('workspace'), { id: ROBOTS, title: 'Robots' });
  createPage(a.doc('workspace'), { id: ARM, title: 'Arm design', parentId: ROBOTS });
  createPage(a.doc('workspace'), { id: PARTS, title: 'Parts', parentId: ROBOTS, kind: 'database' });
  createPage(a.doc('workspace'), { id: SECRETS, title: 'Secrets' });
  a.doc(ARM).getText('t').insert(0, 'arm notes');
  a.doc(SECRETS).getText('t').insert(0, 'hush');
  const db = a.doc(PARTS);
  initDatabase(db, { databaseId: PARTS });
  const stock = addProperty(db, { name: 'Stock', type: 'number' });
  const kind = addProperty(db, { name: 'Kind', type: 'select' });
  addOption(db, kind, { id: 'k-motor', name: 'Motor', color: 'blue' });
  addOption(db, kind, { id: 'k-gear', name: 'Gear', color: 'green' });
  addProperty(db, { name: 'Ordered', type: 'date' });
  addRow(db, {
    id: SERVO,
    actor: ada.id,
    title: 'Servo',
    values: { [stock]: 4, [kind]: 'k-motor' },
  });
  addRow(db, {
    id: SPUR,
    actor: ada.id,
    title: 'Spur gear',
    values: { [stock]: 40, [kind]: 'k-gear' },
  });
  await settled();

  const made = await call('POST', `/api/workspaces/${ws}/integrations`, ada.token, {
    name: 'Lab bot',
    icon: '🤖',
  });
  const bot = { id: made.body.integration.id as string, token: made.body.token as string };
  const share = async (role: string | null) => {
    let S = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).body.scopes.find(
      (s: Json) => s.kind === 'shared',
    );
    if (!S)
      S = (
        await call('POST', `/api/workspaces/${ws}/pages/${ROBOTS}/share`, ada.token, { scope: T })
      ).body.scope;
    const res = await call('PUT', `/api/workspaces/${ws}/scopes/${S.id}/access`, ada.token, {
      principal: `user:${bot.id}`,
      role,
    });
    expect(res.status).toBe(200);
    return S as { id: string; treeDoc: string };
  };
  return { app, store, ws, call, v1, ada, bob, bot, share, a, settled, port, ids: { stock, kind } };
}

const ROBOTS = '0e1f2a3b-0000-4000-8000-000000000001';
const ARM = '0e1f2a3b-0000-4000-8000-000000000002';
const PARTS = '0e1f2a3b-0000-4000-8000-000000000003';
const SECRETS = '0e1f2a3b-0000-4000-8000-000000000004';
const SERVO = '0e1f2a3b-0000-4000-8000-000000000005';
const SPUR = '0e1f2a3b-0000-4000-8000-000000000006';

describe('integrations', () => {
  it('are made by owners and admins; the token is shown once, rotated, and ends with them', async () => {
    const w = await world();
    const { ws, call, v1, bob, bot } = w;
    expect(bot.token).toMatch(/^ntn_/);
    expect(
      (await call('POST', `/api/workspaces/${ws}/integrations`, bob.token, { name: 'Mine' }))
        .status,
    ).toBe(403);
    // Members see names only; owners see the settings (never the token).
    const asBob = (await call('GET', `/api/workspaces/${ws}/integrations`, bob.token)).body
      .integrations;
    expect(asBob).toEqual([{ id: bot.id, name: 'Lab bot', icon: '🤖' }]);
    const asAda = (await call('GET', `/api/workspaces/${ws}/integrations`, w.ada.token)).body
      .integrations;
    expect(asAda[0]).toMatchObject({
      tokenHint: bot.token.slice(-4),
      capabilities: { readContent: true },
    });
    expect(JSON.stringify(asAda)).not.toContain(bot.token);

    // A bot isn't a person: not in the members list, named in the members doc as a former member.
    const members = (await call('GET', `/api/workspaces/${ws}/members`, w.ada.token)).body
      .members as Json[];
    expect(members.map((m) => m.name)).toEqual(['ada', 'bob']);
    await until(() => !!getMembersMap(w.a.doc('members')).get(bot.id), 'members doc');
    expect(getMembersMap(w.a.doc('members')).get(bot.id)).toMatchObject({
      name: 'Lab bot',
      removed: true,
    });

    expect((await v1('GET', '/users/me', bot.token)).status).toBe(200);
    const rotated = (
      await call('POST', `/api/workspaces/${ws}/integrations/${bot.id}/token`, w.ada.token)
    ).body.token;
    expect((await v1('GET', '/users/me', bot.token)).status).toBe(401);
    expect((await v1('GET', '/users/me', rotated)).body).toMatchObject({
      type: 'bot',
      name: 'Lab bot',
    });
    expect(
      (await call('DELETE', `/api/workspaces/${ws}/integrations/${bot.id}`, w.ada.token)).status,
    ).toBe(200);
    expect((await v1('GET', '/users/me', rotated)).status).toBe(401);
  });

  it('API tokens and sessions don’t stand in for each other; the version is required', async () => {
    const { v1, call, ws, ada, bot, app } = await world();
    expect((await call('GET', `/api/workspaces/${ws}/members`, bot.token)).status).toBe(401);
    const asSession = await v1('GET', '/users/me', ada.token);
    expect(asSession.status).toBe(401);
    expect(asSession.body).toEqual({
      object: 'error',
      status: 401,
      code: 'unauthorized',
      message: 'API token is invalid.',
    });
    const cookie = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { cookie: `ws_session=${ada.token}`, 'notion-version': '2022-06-28' },
    });
    expect(cookie.statusCode).toBe(401);
    expect((await v1('GET', '/users/me', bot.token, undefined, null)).body.code).toBe(
      'missing_version',
    );
    expect((await v1('GET', '/nowhere', bot.token)).body.code).toBe('invalid_request_url');
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/search',
      payload: '{"query":',
      headers: {
        authorization: `Bearer ${bot.token}`,
        'notion-version': '2022-06-28',
        'content-type': 'application/json',
      },
    });
    expect(bad.json()).toMatchObject({ object: 'error', code: 'invalid_json' });
  });

  it('is rate limited per integration, with Retry-After', async () => {
    const { v1, bot } = await world({ perSecond: 1, burst: 2 });
    expect((await v1('GET', '/users/me', bot.token)).status).toBe(200);
    expect((await v1('GET', '/users/me', bot.token)).status).toBe(200);
    const limited = await v1('GET', '/users/me', bot.token);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('the API sees only what is shared with the integration', () => {
  it('nothing, then a shared page and what is under it, then nothing again', async () => {
    const w = await world();
    const { v1, bot, share } = w;
    expect((await v1('POST', '/search', bot.token, {})).body.results).toEqual([]);
    expect((await v1('GET', `/pages/${ROBOTS}`, bot.token)).body.code).toBe('object_not_found');

    await share('edit');
    const robots = await v1('GET', `/pages/${ROBOTS.replace(/-/g, '')}`, bot.token);
    expect(robots.status).toBe(200);
    expect(robots.body).toMatchObject({
      object: 'page',
      id: ROBOTS,
      properties: { title: { type: 'title', title: [{ plain_text: 'Robots' }] } },
      in_trash: false,
    });
    // Inherited: the sub-page and the database's rows.
    expect((await v1('GET', `/pages/${ARM}`, bot.token)).body.parent).toEqual({
      type: 'page_id',
      page_id: ROBOTS,
    });
    expect((await v1('GET', `/pages/${SERVO}`, bot.token)).body).toMatchObject({
      parent: { type: 'database_id', database_id: PARTS },
      properties: {
        Name: { title: [{ plain_text: 'Servo' }] },
        Stock: { number: 4 },
        Kind: { select: { name: 'Motor' } },
      },
    });
    const search = await v1('POST', '/search', bot.token, { query: '' });
    const titles = (search.body.results as Json[]).map((r) =>
      r.object === 'database'
        ? r.title[0].plain_text
        : (Object.values(r.properties)[0] as Json).title[0].plain_text,
    );
    expect(titles.sort()).toEqual(['Arm design', 'Parts', 'Robots', 'Servo', 'Spur gear']);
    expect((await v1('GET', `/pages/${SECRETS}`, bot.token)).status).toBe(404);

    await share(null);
    expect((await v1('GET', `/pages/${ROBOTS}`, bot.token)).status).toBe(404);
    expect((await v1('POST', '/search', bot.token, {})).body.results).toEqual([]);
  });

  it('view access reads but doesn’t write; capabilities are checked', async () => {
    const w = await world();
    await w.share('view');
    expect((await w.v1('GET', `/pages/${ROBOTS}`, w.bot.token)).status).toBe(200);
    const write = await w.v1('PATCH', `/pages/${ARM}`, w.bot.token, {
      properties: { title: { title: [{ text: { content: 'X' } }] } },
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('restricted_resource');

    await w.share('edit');
    await w.call('PATCH', `/api/workspaces/${w.ws}/integrations/${w.bot.id}`, w.ada.token, {
      capabilities: { insertContent: false, userInfo: 'none' },
    });
    const insert = await w.v1('POST', '/pages', w.bot.token, {
      parent: { page_id: ROBOTS },
      properties: {},
    });
    expect(insert.body.code).toBe('restricted_resource');
    expect((await w.v1('GET', '/users', w.bot.token)).body.code).toBe('restricted_resource');
  });
});

describe('endpoints', () => {
  it('users: people without emails unless allowed, and bots', async () => {
    const w = await world();
    const list = await w.v1('GET', '/users', w.bot.token);
    expect(list.body).toMatchObject({ object: 'list', type: 'user', has_more: false });
    expect((list.body.results as Json[]).map((u) => [u.name, u.type, u.person?.email])).toEqual([
      ['ada', 'person', undefined],
      ['bob', 'person', undefined],
      ['Lab bot', 'bot', undefined],
    ]);
    await w.call('PATCH', `/api/workspaces/${w.ws}/integrations/${w.bot.id}`, w.ada.token, {
      capabilities: { userInfo: 'email' },
    });
    expect((await w.v1('GET', `/users/${w.ada.id}`, w.bot.token)).body.person).toEqual({
      email: 'ada@lab.io',
    });
  });

  it('pages: rows made, read, changed and trashed; sub-pages; property items; live on the desktop', async () => {
    const w = await world();
    const { v1, bot } = w;
    await w.share('edit');
    const made = await v1('POST', '/pages', bot.token, {
      parent: { database_id: PARTS },
      icon: { emoji: '⚙️' },
      properties: {
        Name: { title: [{ text: { content: 'Stepper' } }] },
        Stock: { number: 7 },
        Kind: { select: { name: 'Sensor' } },
        Ordered: { date: { start: '2026-10-12' } },
      },
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({
      object: 'page',
      icon: { type: 'emoji', emoji: '⚙️' },
      created_by: { id: bot.id },
      properties: {
        Name: { title: [{ plain_text: 'Stepper' }] },
        Stock: { number: 7 },
        Kind: { select: { name: 'Sensor' } },
        Ordered: { date: { start: '2026-10-12' } },
      },
    });
    const id = made.body.id as string;
    // Ada's desktop has it, written by the bot (and the new option).
    await until(
      () => readDatabase(w.a.doc(PARTS)).rows.some((r) => r.id === id),
      'row on the desktop',
    );
    const row = readDatabase(w.a.doc(PARTS)).rows.find((r) => r.id === id)!;
    expect(row.createdBy).toBe(bot.id);

    const changed = await v1('PATCH', `/pages/${id}`, bot.token, {
      properties: { Stock: { number: 9 }, Kind: { select: null } },
    });
    expect(changed.body.properties).toMatchObject({ Stock: { number: 9 }, Kind: { select: null } });
    expect(
      (await v1('PATCH', `/pages/${id}`, bot.token, { properties: { Nope: { number: 1 } } })).body,
    ).toMatchObject({
      code: 'validation_error',
      message: 'Nope is not a property that exists.',
    });
    expect(
      (await v1('PATCH', `/pages/${id}`, bot.token, { properties: { Stock: { number: 'nine' } } }))
        .body.code,
    ).toBe('validation_error');
    const title = await v1('GET', `/pages/${id}/properties/title`, bot.token);
    expect(title.body).toMatchObject({
      object: 'list',
      type: 'property_item',
      results: [{ type: 'title', title: { plain_text: 'Stepper' } }],
    });
    const stockId = w.ids.stock;
    expect((await v1('GET', `/pages/${id}/properties/${stockId}`, bot.token)).body).toEqual({
      object: 'property_item',
      id: stockId,
      type: 'number',
      number: 9,
    });
    expect((await v1('PATCH', `/pages/${id}`, bot.token, { in_trash: true })).body.in_trash).toBe(
      true,
    );

    const sub = await v1('POST', '/pages', bot.token, {
      parent: { page_id: ROBOTS },
      properties: { title: { title: [{ text: { content: 'Wiring' } }] } },
    });
    expect(sub.body.parent).toEqual({ type: 'page_id', page_id: ROBOTS });
    await until(
      () =>
        w.a.client.state.state === 'live' &&
        [...w.a.docs.values()].some((d) => listPages(d).some((p) => p.title === 'Wiring')),
      'sub-page on the desktop',
    );
    // Not under a page the integration can't see.
    expect(
      (await v1('POST', '/pages', bot.token, { parent: { page_id: SECRETS }, properties: {} }))
        .status,
    ).toBe(404);
  });

  it('databases: retrieve, query with filters and sorts, create, change the schema', async () => {
    const w = await world();
    const { v1, bot } = w;
    await w.share('edit');
    const parts = await v1('GET', `/databases/${PARTS}`, bot.token);
    expect(parts.body).toMatchObject({
      object: 'database',
      title: [{ plain_text: 'Parts' }],
      parent: { type: 'page_id', page_id: ROBOTS },
      properties: {
        Name: { type: 'title' },
        Stock: { type: 'number', number: { format: 'number' } },
        Kind: { type: 'select', select: { options: [{ name: 'Motor' }, { name: 'Gear' }] } },
      },
    });
    const q = await v1('POST', `/databases/${PARTS}/query`, bot.token, {
      filter: {
        or: [
          { property: 'Stock', number: { greater_than: 10 } },
          { property: 'Kind', select: { equals: 'Motor' } },
        ],
      },
      sorts: [{ property: 'Stock', direction: 'descending' }],
    });
    expect((q.body.results as Json[]).map((r) => r.properties.Name.title[0].plain_text)).toEqual([
      'Spur gear',
      'Servo',
    ]);
    const paged = await v1('POST', `/databases/${PARTS}/query`, bot.token, { page_size: 1 });
    expect(paged.body).toMatchObject({ has_more: true, next_cursor: SPUR });
    expect(
      (
        await v1('POST', `/databases/${PARTS}/query`, bot.token, {
          filter: { property: 'Stock', select: { equals: 'x' } },
        })
      ).body.code,
    ).toBe('validation_error');

    const made = await v1('POST', '/databases', bot.token, {
      parent: { page_id: ROBOTS },
      title: [{ text: { content: 'Builds' } }],
      properties: {
        Build: { title: {} },
        Hours: { number: { format: 'number_with_commas' } },
        Stage: { select: { options: [{ name: 'Design', color: 'blue' }] } },
        Uses: { relation: { database_id: PARTS, single_property: {} } },
      },
    });
    expect(made.status).toBe(200);
    expect(Object.keys(made.body.properties).sort()).toEqual(['Build', 'Hours', 'Stage', 'Uses']);
    expect(made.body.properties.Uses).toMatchObject({
      type: 'relation',
      relation: { database_id: PARTS },
    });
    const builds = made.body.id as string;
    const row = await v1('POST', '/pages', bot.token, {
      parent: { database_id: builds },
      properties: {
        Build: { title: [{ text: { content: 'Arm v1' } }] },
        Uses: { relation: [{ id: SERVO }] },
      },
    });
    expect(row.body.properties.Uses).toMatchObject({ relation: [{ id: SERVO }] });

    const changed = await v1('PATCH', `/databases/${builds}`, bot.token, {
      title: [{ text: { content: 'Builds 2026' } }],
      properties: { Hours: { name: 'Time' }, Stage: null, Done: { checkbox: {} } },
    });
    expect(changed.body.title[0].plain_text).toBe('Builds 2026');
    expect(Object.keys(changed.body.properties).sort()).toEqual(['Build', 'Done', 'Time', 'Uses']);
  });

  it('2025-09-03: databases have one data source, queried and retrieved by it', async () => {
    const w = await world();
    const { v1, bot } = w;
    await w.share('edit');
    const v = '2025-09-03';
    const db = await v1('GET', `/databases/${PARTS}`, bot.token, undefined, v);
    expect(db.body.data_sources).toEqual([{ id: PARTS, name: 'Parts' }]);
    expect(db.body.properties).toBeUndefined();
    const source = await v1('GET', `/data_sources/${PARTS}`, bot.token, undefined, v);
    expect(source.body).toMatchObject({
      object: 'data_source',
      properties: { Stock: { type: 'number' } },
    });
    const q = await v1(
      'POST',
      `/data_sources/${PARTS}/query`,
      bot.token,
      { filter: { property: 'Kind', select: { equals: 'Gear' } } },
      v,
    );
    expect(q.body.results).toHaveLength(1);
    expect(q.body.results[0].parent).toEqual({
      type: 'data_source_id',
      data_source_id: PARTS,
      database_id: PARTS,
    });
    expect((await v1('POST', '/data_sources', bot.token, {}, v)).body.code).toBe(
      'validation_error',
    );
    const search = await v1(
      'POST',
      '/search',
      bot.token,
      { filter: { property: 'object', value: 'data_source' } },
      v,
    );
    expect((search.body.results as Json[]).map((r) => r.object)).toEqual(['data_source']);
  });
});

describe('the official SDK', () => {
  it('works against the server (2025-09-03), errors included', async () => {
    const w = await world();
    await w.share('edit');
    const notion = new Client({
      auth: w.bot.token,
      baseUrl: `http://127.0.0.1:${w.port}`,
      retry: false,
    });
    const me = await notion.users.me({});
    expect(me).toMatchObject({ type: 'bot', name: 'Lab bot' });

    const source = await notion.dataSources.retrieve({ data_source_id: PARTS });
    expect(Object.keys((source as { properties: object }).properties)).toContain('Stock');
    const created = await notion.pages.create({
      parent: { data_source_id: PARTS },
      properties: {
        Name: { title: [{ text: { content: 'Bearing' } }] },
        Stock: { number: 120 },
      },
    });
    const page = await notion.pages.retrieve({ page_id: created.id });
    expect(isFullPage(page) && page.properties.Stock).toMatchObject({ number: 120 });
    await notion.pages.update({ page_id: created.id, properties: { Stock: { number: 119 } } });

    const rows = await collectPaginatedAPI(notion.dataSources.query, {
      data_source_id: PARTS,
      page_size: 1,
      sorts: [{ property: 'Stock', direction: 'ascending' }],
    });
    expect(
      rows.map((r) => (isFullPage(r) ? (r.properties.Stock as { number: number }).number : null)),
    ).toEqual([4, 40, 119]);

    const found = await notion.search({ query: 'bear' });
    expect(found.results.map((r) => r.id)).toEqual([created.id]);

    // Content and comments, through the SDK's own types.
    await notion.blocks.children.append({
      block_id: ARM,
      children: [
        { heading_2: { rich_text: [{ text: { content: 'Specs' } }] } },
        { to_do: { rich_text: [{ text: { content: 'Torque test' } }], checked: true } },
      ],
    });
    const content = await collectPaginatedAPI(notion.blocks.children.list, { block_id: ARM });
    expect(content.map((b) => ('type' in b ? b.type : null))).toEqual(['heading_2', 'to_do']);
    const comment = await notion.comments.create({
      parent: { page_id: ARM },
      rich_text: [{ text: { content: 'Looks right' } }],
    });
    const listed = await notion.comments.list({ block_id: ARM });
    expect(listed.results.map((c) => c.id)).toEqual([comment.id]);

    const missing = await notion.pages.retrieve({ page_id: SECRETS }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(APIResponseError);
    expect((missing as APIResponseError).code).toBe('object_not_found');
  });
});

describe('blocks and comments (M6)', () => {
  /** A page's content as the editor writes it (Markdown and editor JSON). */
  const CONTENT = [
    '# Plan\n\nIntro **bold** and [a link](https://lab.io)\n\n- One\n  - Nested\n- Two\n\n1. First\n\n> Quoted\n\n```cpp\nint x;\n```\n\n---',
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { icon: '⚠️' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful' }] }],
    },
    {
      type: 'details',
      content: [
        { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
        {
          type: 'detailsContent',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hidden' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: ['Part', 'Qty'].map((t) => ({
            type: 'tableHeader',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          })),
        },
        {
          type: 'tableRow',
          content: ['Servo', '4'].map((t) => ({
            type: 'tableCell',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          })),
        },
      ],
    },
  ];

  const plain = (b: Json) =>
    ((b[b.type]?.rich_text ?? []) as Json[]).map((r) => r.plain_text as string).join('');

  async function setup() {
    const w = await world();
    const S = await w.share('edit');
    w.a.hint = S.id;
    expect(appendContent(w.a.doc(ARM), CONTENT)).toEqual([]);
    await w.settled();
    /** A block's children, all the way down (as a client walks them). */
    const tree = async (id: string): Promise<Json[]> => {
      const res = await w.v1('GET', `/blocks/${id}/children`, w.bot.token);
      expect(res.status).toBe(200);
      return Promise.all(
        (res.body.results as Json[]).map(async (b) => ({
          ...b,
          children: b.has_children && !b.type.startsWith('child_') ? await tree(b.id) : [],
        })),
      );
    };
    /** Type and text only, to compare content. */
    const shape = (blocks: Json[]): unknown =>
      blocks.map((b) => ({
        type: b.type,
        text: plain(b),
        ...(b.type === 'table_row' && {
          cells: b.table_row.cells.map((c: Json[]) => c[0]?.plain_text),
        }),
        ...(b.children.length && { children: shape(b.children) }),
      }));
    return { ...w, S, tree, shape };
  }

  it('a page reads as blocks, and goes back in as a new page with nothing lost', async () => {
    const w = await setup();
    const blocks = await w.tree(ARM);
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_1',
      'paragraph',
      'bulleted_list_item',
      'bulleted_list_item',
      'numbered_list_item',
      'quote',
      'code',
      'divider',
      'to_do',
      'callout',
      'toggle',
      'table',
    ]);
    expect(blocks[1]!.paragraph.rich_text).toMatchObject([
      { plain_text: 'Intro ' },
      { plain_text: 'bold', annotations: { bold: true } },
      { plain_text: ' and ' },
      { plain_text: 'a link', href: 'https://lab.io' },
    ]);
    expect(blocks[2]!.children.map(plain)).toEqual(['Nested']);
    expect(blocks[6]!.code).toMatchObject({ language: 'c++' });
    expect(blocks[8]!.to_do.checked).toBe(true);
    expect(blocks[11]!.children.map((r: Json) => r.type)).toEqual(['table_row', 'table_row']);

    // A block, by id: its parent is the page, or the block it's in.
    const nested = blocks[2]!.children[0] as Json;
    const one = await w.v1('GET', `/blocks/${nested.id}`, w.bot.token);
    expect(one.body).toMatchObject({
      object: 'block',
      type: 'bulleted_list_item',
      parent: { type: 'block_id', block_id: blocks[2]!.id },
    });
    expect((await w.v1('GET', `/blocks/${blocks[0]!.id}`, w.bot.token)).body.parent).toEqual({
      type: 'page_id',
      page_id: ARM,
    });
    // The page is a block too: a child_page, with Robots' sub-pages after its content.
    expect((await w.v1('GET', `/blocks/${ARM}`, w.bot.token)).body).toMatchObject({
      type: 'child_page',
      child_page: { title: 'Arm design' },
      has_children: true,
    });
    expect((await w.tree(ROBOTS)).map((b) => b.type)).toEqual(['child_page', 'child_database']);
    // Unshared pages aren't there.
    expect((await w.v1('GET', `/blocks/${SECRETS}/children`, w.bot.token)).status).toBe(404);

    // Sent back as a new page's children: the same content.
    const asInput = (list: Json[]): Json[] =>
      list.map((b) => ({
        type: b.type,
        [b.type]: { ...b[b.type], ...(b.children.length && { children: asInput(b.children) }) },
      }));
    const copy = await w.v1('POST', '/pages', w.bot.token, {
      parent: { page_id: ROBOTS },
      properties: { title: { title: [{ text: { content: 'Arm design (copy)' } }] } },
      children: asInput(blocks),
    });
    expect(copy.status).toBe(200);
    expect(w.shape(await w.tree(copy.body.id))).toEqual(w.shape(blocks));
    // Ada's desktop has it, as content its editor reads.
    await until(() => w.a.has(copy.body.id), 'copy on the desktop');
    await until(
      () => contentJson(w.a.doc(copy.body.id)).length === contentJson(w.a.doc(ARM)).length,
      'copy content on the desktop',
    );
  });

  it('blocks are added (after one, or into one), changed and deleted, by id', async () => {
    const w = await setup();
    const { v1, bot } = w;
    const before = await w.tree(ARM);
    const intro = before[1]!;
    const added = await v1('PATCH', `/blocks/${ARM}/children`, bot.token, {
      after: intro.id,
      children: [
        { type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'Added after' } }] } },
        { type: 'to_do', to_do: { rich_text: [{ text: { content: 'Check it' } }] } },
      ],
    });
    expect(added.status).toBe(200);
    expect((added.body.results as Json[]).map(plain)).toEqual(['Added after', 'Check it']);
    let blocks = await w.tree(ARM);
    expect(blocks.slice(1, 4).map(plain)).toEqual([
      'Intro bold and a link',
      'Added after',
      'Check it',
    ]);

    // After a list item: into its list.
    const two = before[3]!;
    await v1('PATCH', `/blocks/${ARM}/children`, bot.token, {
      after: two.id,
      children: [
        {
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: [{ text: { content: 'Three' } }] },
        },
      ],
    });
    // Into a toggle, and under a list item.
    const toggle = blocks.find((b) => b.type === 'toggle')!;
    await v1('PATCH', `/blocks/${toggle.id}/children`, bot.token, {
      children: [{ type: 'quote', quote: { rich_text: [{ text: { content: 'Deep' } }] } }],
    });
    blocks = await w.tree(ARM);
    expect(blocks.filter((b) => b.type === 'bulleted_list_item').map(plain)).toEqual([
      'One',
      'Two',
      'Three',
    ]);
    expect(blocks.find((b) => b.type === 'toggle')!.children.map(plain)).toEqual([
      'Hidden',
      'Deep',
    ]);
    // Blocks that can't hold others, or ids not there, are refused.
    expect(
      (
        await v1('PATCH', `/blocks/${blocks[0]!.id}/children`, bot.token, {
          children: [{ type: 'divider', divider: {} }],
        })
      ).body.code,
    ).toBe('validation_error');
    expect(
      (
        await v1('PATCH', `/blocks/${ARM}/children`, bot.token, {
          after: SERVO,
          children: [{ type: 'divider', divider: {} }],
        })
      ).body.code,
    ).toBe('validation_error');

    // Changed: text and settings, the id kept.
    const todo = blocks.find((b) => b.type === 'to_do' && plain(b) === 'Done')!;
    const changed = await v1('PATCH', `/blocks/${todo.id}`, bot.token, {
      to_do: { rich_text: [{ text: { content: 'Done again' } }], checked: false },
    });
    expect(changed.body).toMatchObject({ id: todo.id, to_do: { checked: false } });
    expect(plain(changed.body)).toBe('Done again');
    const code = blocks.find((b) => b.type === 'code')!;
    expect(
      (await v1('PATCH', `/blocks/${code.id}`, bot.token, { code: { language: 'rust' } })).body
        .code,
    ).toMatchObject({ language: 'rust', rich_text: [{ plain_text: 'int x;' }] });
    expect(
      (await v1('PATCH', `/blocks/${code.id}`, bot.token, { paragraph: { rich_text: [] } })).body
        .code,
    ).toBe('validation_error');

    // Deleted: gone (a list left empty goes too).
    const added1 = blocks[2]!;
    const gone = await v1('DELETE', `/blocks/${added1.id}`, bot.token);
    expect(gone.body).toMatchObject({ id: added1.id, in_trash: true });
    expect((await v1('GET', `/blocks/${added1.id}`, bot.token)).status).toBe(404);
    const numbered = blocks.find((b) => b.type === 'numbered_list_item')!;
    await v1('PATCH', `/blocks/${numbered.id}`, bot.token, { in_trash: true });
    const fragment = w.a.doc(ARM).getXmlFragment('content');
    await until(
      () =>
        !fragment.toString().includes('Added after') &&
        !fragment.toArray().some((el) => (el as { nodeName?: string }).nodeName === 'orderedList'),
      'deletes on the desktop',
    );
    // Ada's desktop has the rest, as the bot wrote it.
    expect(fragment.toString()).toContain('Done again');
    expect(fragment.toString()).toContain('Deep');

    // A view-only integration reads but doesn't write.
    await w.share('view');
    expect((await v1('GET', `/blocks/${ARM}/children`, bot.token)).status).toBe(200);
    expect(
      (
        await v1('PATCH', `/blocks/${ARM}/children`, bot.token, {
          children: [{ type: 'divider', divider: {} }],
        })
      ).body.code,
    ).toBe('restricted_resource');
  });

  it('ids stay the same, and edits made live on a desktop meanwhile are kept', async () => {
    const w = await setup();
    // A block from before blocks had ids gets one, once.
    const doc = w.a.doc(ARM);
    const old = new Y.XmlElement('paragraph');
    old.insert(0, [new Y.XmlText('From long ago')]);
    doc.getXmlFragment('content').insert(0, [old]);
    await w.settled();
    const first = await w.tree(ARM);
    expect(plain(first[0]!)).toBe('From long ago');
    const again = await w.tree(ARM);
    expect(again.map((b) => b.id)).toEqual(first.map((b) => b.id));
    await until(() => old.getAttribute('id') === first[0]!.id, 'the id on the desktop');

    // Ada types while the API adds and changes blocks: both are kept.
    const intro = first[2]!;
    const introEl = [...doc.getXmlFragment('content').toArray()].find(
      (el) => el instanceof Y.XmlElement && el.getAttribute('id') === intro.id,
    ) as Y.XmlElement;
    const typing = (async () => {
      for (const word of [' one', ' two', ' three']) {
        (introEl.get(introEl.length - 1) as Y.XmlText).insert(
          (introEl.get(introEl.length - 1) as Y.XmlText).length,
          word,
        );
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    const appended = w.v1('PATCH', `/blocks/${ARM}/children`, w.bot.token, {
      children: [
        { type: 'paragraph', paragraph: { rich_text: [{ text: { content: 'From the API' } }] } },
      ],
    });
    const heading = w.v1('PATCH', `/blocks/${first[1]!.id}`, w.bot.token, {
      heading_1: { rich_text: [{ text: { content: 'Plan B' } }] },
    });
    await Promise.all([typing, appended, heading]);
    await w.settled();
    await until(async () => {
      const now = await w.tree(ARM);
      return (
        plain(now.find((b) => b.id === intro.id)!).endsWith(' one two three') &&
        now.some((b) => plain(b) === 'From the API') &&
        plain(now.find((b) => b.id === first[1]!.id)!) === 'Plan B'
      );
    }, 'both edits on the server');
    await until(
      () =>
        doc.getXmlFragment('content').toString().includes('From the API') &&
        doc.getXmlFragment('content').toString().includes('Plan B'),
      'both edits on the desktop',
    );
    // Blocks kept their ids through it all.
    const after = await w.tree(ARM);
    for (const b of first) expect(after.some((x) => x.id === b.id)).toBe(true);
  });

  it('comments: listed per page and block, started on a page, and replied to', async () => {
    const w = await setup();
    const { v1, bot, ada } = w;
    const blocks = await w.tree(ARM);
    const comments = w.a.doc(commentsDocId(ARM));
    const onPage = createThread(comments, {
      anchor: { kind: 'page' },
      author: ada.id,
      body: `Hi <@${ada.id}>`,
    });
    createThread(comments, {
      anchor: { kind: 'block', blockId: blocks[1]!.id },
      author: ada.id,
      body: 'About the intro',
    });
    const resolved = createThread(comments, {
      anchor: { kind: 'page' },
      author: ada.id,
      body: 'Old',
    });
    setResolved(comments, resolved, ada.id);
    await w.settled();

    const page = await v1('GET', `/comments?block_id=${ARM}`, bot.token);
    expect(page.body).toMatchObject({
      object: 'list',
      type: 'comment',
      results: [
        {
          object: 'comment',
          discussion_id: onPage,
          parent: { type: 'page_id', page_id: ARM },
          created_by: { object: 'user', id: ada.id },
          rich_text: [{ plain_text: 'Hi ' }, { type: 'mention', plain_text: '@ada' }],
        },
      ],
    });
    const block = await v1('GET', `/comments?block_id=${blocks[1]!.id}`, bot.token);
    expect(block.body.results).toMatchObject([
      {
        parent: { type: 'block_id', block_id: blocks[1]!.id },
        rich_text: [{ plain_text: 'About the intro' }],
      },
    ]);

    // A new discussion on the page, and a reply in Ada's.
    const started = await v1('POST', '/comments', bot.token, {
      parent: { page_id: ARM },
      rich_text: [
        { text: { content: 'Ready for review, ' } },
        { type: 'mention', mention: { type: 'user', user: { id: ada.id } } },
      ],
    });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({
      object: 'comment',
      parent: { page_id: ARM },
      created_by: { id: bot.id },
    });
    const reply = await v1('POST', '/comments', bot.token, {
      discussion_id: onPage,
      rich_text: [{ text: { content: 'On it' } }],
    });
    expect(reply.body).toMatchObject({
      discussion_id: onPage,
      rich_text: [{ plain_text: 'On it' }],
    });
    await until(
      () =>
        readThreads(comments).some(
          (t) => t.comments[0]?.body === `Ready for review, <@${ada.id}>` && t.createdBy === bot.id,
        ) && readThreads(comments).find((t) => t.id === onPage)!.comments.length === 2,
      'comments on the desktop',
    );
    expect(
      ((await v1('GET', `/comments?block_id=${ARM}`, bot.token)).body.results as Json[]).length,
    ).toBe(3);

    // Without the capabilities, refused; on pages not shared, not found.
    expect(
      (
        await v1('POST', '/comments', bot.token, {
          parent: { page_id: SECRETS },
          rich_text: [{ text: { content: 'x' } }],
        })
      ).status,
    ).toBe(404);
    await w.call('PATCH', `/api/workspaces/${w.ws}/integrations/${bot.id}`, ada.token, {
      capabilities: { readComments: false, insertComments: false },
    });
    expect((await v1('GET', `/comments?block_id=${ARM}`, bot.token)).body.code).toBe(
      'restricted_resource',
    );
  });

  it('files come as links that work without signing in, for an hour', async () => {
    const w = await setup();
    const bytes = Buffer.from('servo datasheet');
    const fileId = `${createHash('sha256').update(bytes).digest('hex')}.txt`;
    const put = await w.app.inject({
      method: 'PUT',
      url: `/api/workspaces/${w.ws}/files/${fileId}`,
      payload: bytes,
      headers: {
        authorization: `Bearer ${w.ada.token}`,
        'content-type': 'application/octet-stream',
        'x-file-name': 'datasheet.txt',
      },
    });
    expect(put.statusCode).toBe(201);
    appendContent(w.a.doc(ARM), [{ type: 'file', attrs: { fileId, name: 'datasheet.txt' } }]);
    await w.settled();
    const file = (await w.tree(ARM)).at(-1)!;
    expect(file).toMatchObject({ type: 'file', file: { type: 'file', name: 'datasheet.txt' } });
    const url = new URL(file.file.file.url as string);
    expect(url.origin).toBe('http://app.test');
    expect(Date.parse(file.file.file.expiry_time) - Date.now()).toBeGreaterThan(3500_000);
    const get = (path: string) => w.app.inject({ method: 'GET', url: path });
    const ok = await get(url.pathname + url.search);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe('servo datasheet');
    url.searchParams.set('sig', 'x'.repeat(43));
    expect((await get(url.pathname + url.search)).statusCode).toBe(403);
    url.searchParams.set('exp', String(Date.now() - 1000));
    expect((await get(url.pathname + url.search)).statusCode).toBe(403);
  });
});
