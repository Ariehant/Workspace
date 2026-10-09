/**
 * Phase 6 M5: integrations and the public API (`/v1`). Real server, real Postgres.
 *
 * Ada (owner) has "Robots" (with a sub-page and a database "Parts") and "Secrets" in
 * the first teamspace. She makes an integration "Lab bot" and shares Robots with it.
 * Bob is a member.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createPage, getMembersMap, listPages } from '@workspace/core';
import { addOption, addProperty, addRow, initDatabase, readDatabase } from '@workspace/database';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

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
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

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

    const missing = await notion.pages.retrieve({ page_id: SECRETS }).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(APIResponseError);
    expect((missing as APIResponseError).code).toBe('object_not_found');
  });
});
