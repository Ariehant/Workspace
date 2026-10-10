/**
 * Phase 6 exit check: API conformance. The official SDK (`@notionhq/client`), pointed at
 * the server with `baseUrl`, goes through what integrations do, in both API versions:
 *
 * 1. A database with every writable property type, pages with values and content, and a
 *    query with nested filters and sorts.
 * 2. Pagination; appending, updating and deleting blocks; comments.
 * 3. Search, users, and the errors (`object_not_found` for pages not shared,
 *    `validation_error`, `rate_limited` with `Retry-After`).
 *
 * Responses are checked with the SDK's own type guards and against Notion's documented
 * shapes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  APIErrorCode,
  APIResponseError,
  Client,
  collectPaginatedAPI,
  isFullBlock,
  isFullComment,
  isFullPage,
  isFullUser,
  type PageObjectResponse,
} from '@notionhq/client';
import { createPage } from '@workspace/core';
import { PgStore } from '@workspace/storage-remote';
import { createTestDatabase } from '@workspace/storage-remote/testing';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildServer } from './app';
import { loadConfig } from './config';
import { FsStorage } from './files';
import { TestDevice } from './sync/test-client';

let dir: string;
const cleanups: (() => Promise<unknown> | void)[] = [];
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'workspace-conformance-'));
});
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

const LAB = '0e1f2a3b-0000-4000-8000-0000000000aa';
const SECRETS = '0e1f2a3b-0000-4000-8000-0000000000bb';

/** Ada's workspace: "Lab" connected to her integration, "Secrets" not. */
async function world(api = { perSecond: 1000, burst: 1000 }) {
  const store = new PgStore(await createTestDatabase(inject('pgUrl')), { max: 6 });
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
    return res.json() as Json;
  };
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/signup',
    headers: { 'x-workspace-client': 'test' },
    payload: { email: 'ada@lab.io', name: 'Ada', password: 'long password', client: 'desktop' },
  });
  const ada = { token: signup.json().token as string, id: signup.json().user.id as string };
  const ws = (await call('POST', '/api/workspaces', ada.token, { name: 'Lab' })).workspace
    .id as string;
  const T = (await call('GET', `/api/workspaces/${ws}/scopes`, ada.token)).defaultScopeId as string;
  const a = new TestDevice({
    url: `ws://127.0.0.1:${port}/api/sync/${ws}`,
    token: ada.token,
    deviceId: 'ada-1',
  });
  cleanups.push(() => a.client.stop());
  a.client.start();
  await until(() => a.client.state.state === 'live', 'live');
  createPage(a.doc('workspace'), { id: LAB, title: 'Lab' });
  createPage(a.doc('workspace'), { id: SECRETS, title: 'Secrets' });
  await until(() => a.outbox.length === 0, 'outbox sent');
  const made = await call('POST', `/api/workspaces/${ws}/integrations`, ada.token, {
    name: 'Conformance',
  });
  const bot = { id: made.integration.id as string, token: made.token as string };
  const scope = (
    await call('POST', `/api/workspaces/${ws}/pages/${LAB}/share`, ada.token, { scope: T })
  ).scope as { id: string };
  await call('PUT', `/api/workspaces/${ws}/scopes/${scope.id}/access`, ada.token, {
    principal: `user:${bot.id}`,
    role: 'edit',
  });
  return { base: `http://127.0.0.1:${port}`, ada, bot };
}

const text = (content: string) => [{ type: 'text' as const, text: { content } }];
const plain = (items: { plain_text: string }[]) => items.map((i) => i.plain_text).join('');

describe.each(['2022-06-28', '2025-09-03'] as const)(
  'the official SDK, Notion-Version %s',
  (version) => {
    const v2025 = version === '2025-09-03';

    it('databases with every writable type, pages with content, nested filters and sorts, paging', async () => {
      const w = await world();
      const notion = new Client({
        auth: w.bot.token,
        baseUrl: w.base,
        notionVersion: version,
        retry: false,
      });
      const create = (title: string, properties: Json) =>
        notion.request<Json>({
          path: 'databases',
          method: 'post',
          body: {
            parent: { type: 'page_id', page_id: LAB },
            title: text(title),
            ...(v2025 ? { initial_data_source: { properties } } : { properties }),
          },
        });
      const query = (id: string, body: Json) =>
        notion.request<Json>({
          path: v2025 ? `data_sources/${id}/query` : `databases/${id}/query`,
          method: 'post',
          body,
        });
      const parent = (id: string) =>
        v2025
          ? { type: 'data_source_id' as const, data_source_id: id }
          : { type: 'database_id' as const, database_id: id };

      // 1. Databases.
      const suppliers = await create('Suppliers', { Name: { title: {} } });
      expect(suppliers).toMatchObject({ object: 'database', title: [{ plain_text: 'Suppliers' }] });
      if (v2025) {
        expect(suppliers.data_sources).toEqual([{ id: suppliers.id, name: 'Suppliers' }]);
        expect(suppliers.properties).toBeUndefined();
      }
      const acme = await notion.pages.create({
        parent: parent(suppliers.id),
        properties: { Name: { title: text('Acme') } },
      });
      const parts = await create('Parts', {
        Name: { title: {} },
        Notes: { rich_text: {} },
        Qty: { number: { format: 'number' } },
        Kind: {
          select: {
            options: [
              { name: 'Motor', color: 'blue' },
              { name: 'Gear', color: 'green' },
            ],
          },
        },
        Tags: { multi_select: { options: [{ name: 'arm' }, { name: 'base' }] } },
        Due: { date: {} },
        Owner: { people: {} },
        Specs: { files: {} },
        Done: { checkbox: {} },
        Link: { url: {} },
        Mail: { email: {} },
        Phone: { phone_number: {} },
        Supplier: v2025
          ? {
              relation: {
                data_source_id: suppliers.id,
                type: 'single_property',
                single_property: {},
              },
            }
          : {
              relation: { database_id: suppliers.id, type: 'single_property', single_property: {} },
            },
        Double: { formula: { expression: 'prop("Qty") * 2' } },
        Created: { created_time: {} },
        Creator: { created_by: {} },
        Edited: { last_edited_time: {} },
        Editor: { last_edited_by: {} },
        Code: { unique_id: { prefix: 'PRT' } },
      });
      const schema = v2025
        ? ((await notion.dataSources.retrieve({ data_source_id: parts.id })) as Json).properties
        : parts.properties;
      expect(
        Object.fromEntries(Object.entries(schema as Json).map(([k, p]) => [k, (p as Json).type])),
      ).toEqual({
        Name: 'title',
        Notes: 'rich_text',
        Qty: 'number',
        Kind: 'select',
        Tags: 'multi_select',
        Due: 'date',
        Owner: 'people',
        Specs: 'files',
        Done: 'checkbox',
        Link: 'url',
        Mail: 'email',
        Phone: 'phone_number',
        Supplier: 'relation',
        Double: 'formula',
        Created: 'created_time',
        Creator: 'created_by',
        Edited: 'last_edited_time',
        Editor: 'last_edited_by',
        Code: 'unique_id',
      });
      expect(schema.Kind.select.options.map((o: Json) => [o.name, o.color])).toEqual([
        ['Motor', 'blue'],
        ['Gear', 'green'],
      ]);

      // Pages with a value of every type, and content.
      const rows: [string, number, string, boolean][] = [
        ['Servo', 4, 'Motor', false],
        ['Spur gear', 40, 'Gear', false],
        ['Stepper', 12, 'Motor', true],
        ['Worm gear', 2, 'Gear', false],
      ];
      const made: PageObjectResponse[] = [];
      for (const [name, qty, kind, done] of rows) {
        const page = await notion.pages.create({
          parent: parent(parts.id),
          icon: { type: 'emoji', emoji: '⚙️' },
          properties: {
            Name: { title: text(name) },
            Notes: {
              rich_text: [
                { type: 'text', text: { content: 'Bought ' } },
                { type: 'text', text: { content: 'twice' }, annotations: { bold: true } },
              ],
            },
            Qty: { number: qty },
            Kind: { select: { name: kind } },
            Tags: { multi_select: [{ name: 'arm' }, { name: 'new tag' }] },
            Due: { date: { start: '2026-10-12', end: '2026-10-14' } },
            Owner: { people: [{ id: w.ada.id }] },
            Specs: {
              files: [
                {
                  name: 'spec.pdf',
                  type: 'external',
                  external: { url: 'https://lab.io/spec.pdf' },
                },
              ],
            },
            Done: { checkbox: done },
            Link: { url: 'https://lab.io/parts' },
            Mail: { email: 'parts@lab.io' },
            Phone: { phone_number: '+1 555 0100' },
            Supplier: { relation: [{ id: acme.id }] },
          },
          children: [
            { heading_2: { rich_text: text('Specs') } },
            { paragraph: { rich_text: text(`${name} for the arm.`) } },
            { to_do: { rich_text: text('Order spares'), checked: false } },
            { bulleted_list_item: { rich_text: text('Torque') } },
            { bulleted_list_item: { rich_text: text('Speed') } },
          ],
        });
        expect(isFullPage(page)).toBe(true);
        made.push(page as PageObjectResponse);
      }
      const first = made[0]!;
      expect(first).toMatchObject({
        object: 'page',
        icon: { type: 'emoji', emoji: '⚙️' },
        created_by: { object: 'user', id: w.bot.id },
        parent: v2025
          ? { type: 'data_source_id', data_source_id: parts.id, database_id: parts.id }
          : { type: 'database_id', database_id: parts.id },
        in_trash: false,
      });
      const p = first.properties as Json;
      expect(plain(p.Name.title)).toBe('Servo');
      // (Text properties hold plain text here: formatting in them isn't kept.)
      expect(plain(p.Notes.rich_text)).toBe('Bought twice');
      expect(p.Qty.number).toBe(4);
      expect(p.Kind.select).toMatchObject({ name: 'Motor', color: 'blue' });
      expect(p.Tags.multi_select.map((t: Json) => t.name)).toEqual(['arm', 'new tag']);
      expect(p.Due.date).toMatchObject({ start: '2026-10-12', end: '2026-10-14' });
      expect(p.Owner.people).toMatchObject([{ object: 'user', id: w.ada.id }]);
      expect(p.Specs.files).toEqual([
        { name: 'spec.pdf', type: 'external', external: { url: 'https://lab.io/spec.pdf' } },
      ]);
      expect(p.Done.checkbox).toBe(false);
      expect([p.Link.url, p.Mail.email, p.Phone.phone_number]).toEqual([
        'https://lab.io/parts',
        'parts@lab.io',
        '+1 555 0100',
      ]);
      expect(p.Supplier.relation).toEqual([{ id: acme.id }]);
      expect(p.Double.formula).toEqual({ type: 'number', number: 8 });
      expect(p.Creator.created_by).toMatchObject({ id: w.bot.id });
      expect(p.Code.unique_id).toEqual({ prefix: 'PRT', number: 1 });
      expect(Date.parse(p.Created.created_time)).toBeGreaterThan(Date.now() - 60_000);

      // A query with nested filters and sorts.
      const filter = {
        and: [
          { property: 'Done', checkbox: { equals: false } },
          {
            or: [
              { property: 'Kind', select: { equals: 'Motor' } },
              { property: 'Qty', number: { greater_than: 10 } },
            ],
          },
        ],
      };
      const sorts = [{ property: 'Qty', direction: 'descending' }];
      const all = await query(parts.id, { filter, sorts });
      const listType = v2025 ? 'page_or_data_source' : 'page_or_database';
      expect(all).toMatchObject({ object: 'list', type: listType, has_more: false });
      expect(all[listType]).toEqual({});
      const names = (list: Json[]) => list.map((r) => plain(r.properties.Name.title));
      expect(names(all.results)).toEqual(['Spur gear', 'Servo']);
      // 2. Paging, one at a time, gives the same.
      const paged: Json[] = [];
      let cursor: string | undefined;
      do {
        const page = await query(parts.id, {
          filter,
          sorts,
          page_size: 1,
          ...(cursor && { start_cursor: cursor }),
        });
        paged.push(...page.results);
        cursor = page.has_more ? page.next_cursor : undefined;
        if (page.has_more) expect(page.next_cursor).toEqual(expect.any(String));
      } while (cursor);
      expect(names(paged)).toEqual(['Spur gear', 'Servo']);
      const every = await query(parts.id, {
        sorts: [{ property: 'Name', direction: 'ascending' }],
      });
      expect(names(every.results)).toEqual(['Servo', 'Spur gear', 'Stepper', 'Worm gear']);
    });

    it('blocks appended, changed and deleted; comments; search; users; errors', async () => {
      const w = await world();
      const notion = new Client({
        auth: w.bot.token,
        baseUrl: w.base,
        notionVersion: version,
        retry: false,
      });
      const page = await notion.pages.create({
        parent: { type: 'page_id', page_id: LAB },
        properties: { title: { title: text('Arm design') } },
        children: [
          { heading_1: { rich_text: text('Arm') } },
          { paragraph: { rich_text: text('Reach is 60 cm.') } },
          { to_do: { rich_text: text('Check torque'), checked: false } },
        ],
      });
      expect(page).toMatchObject({ object: 'page', parent: { type: 'page_id', page_id: LAB } });

      // 2. Blocks.
      const listed = await collectPaginatedAPI(notion.blocks.children.list, {
        block_id: page.id,
        page_size: 2,
      });
      expect(listed.every((b) => isFullBlock(b))).toBe(true);
      expect(listed.map((b) => ('type' in b ? b.type : null))).toEqual([
        'heading_1',
        'paragraph',
        'to_do',
      ]);
      const [heading, paragraph, todo] = listed as Json[];
      expect(paragraph).toMatchObject({
        object: 'block',
        parent: { type: 'page_id', page_id: page.id },
        has_children: false,
        in_trash: false,
        paragraph: { rich_text: [{ plain_text: 'Reach is 60 cm.' }], color: 'default' },
      });
      const appended = await notion.blocks.children.append({
        block_id: page.id,
        after: paragraph!.id,
        children: [
          { quote: { rich_text: text('Keep it light.') } },
          {
            toggle: {
              rich_text: text('More'),
              children: [{ paragraph: { rich_text: text('Hidden detail') } }],
            },
          },
        ],
      });
      expect(appended.results.map((b) => ('type' in b ? b.type : null))).toEqual([
        'quote',
        'toggle',
      ]);
      const toggle = appended.results[1]!;
      const inside = await notion.blocks.children.list({ block_id: toggle.id });
      expect(inside.results).toMatchObject([
        { type: 'paragraph', parent: { type: 'block_id', block_id: toggle.id } },
      ]);
      const checked = await notion.blocks.update({
        block_id: todo!.id,
        to_do: { rich_text: text('Torque checked'), checked: true },
      });
      expect(checked).toMatchObject({ id: todo!.id, to_do: { checked: true } });
      const retrieved = await notion.blocks.retrieve({ block_id: todo!.id });
      expect(
        isFullBlock(retrieved) && retrieved.type === 'to_do' && plain(retrieved.to_do.rich_text),
      ).toBe('Torque checked');
      expect(await notion.blocks.delete({ block_id: heading!.id })).toMatchObject({
        id: heading!.id,
        in_trash: true,
      });
      const after = await collectPaginatedAPI(notion.blocks.children.list, { block_id: page.id });
      expect(after.map((b) => ('type' in b ? b.type : null))).toEqual([
        'paragraph',
        'quote',
        'toggle',
        'to_do',
      ]);

      // Comments: a discussion and a reply.
      const comment = await notion.comments.create({
        parent: { page_id: page.id },
        rich_text: text('Reach confirmed.'),
      });
      expect(isFullComment(comment)).toBe(true);
      expect(comment).toMatchObject({
        object: 'comment',
        parent: { type: 'page_id', page_id: page.id },
        created_by: { object: 'user', id: w.bot.id },
      });
      await notion.comments.create({
        discussion_id: (comment as Json).discussion_id,
        rich_text: text('And payload.'),
      });
      const comments = await notion.comments.list({ block_id: page.id });
      expect(comments.results.map((c) => plain((c as Json).rich_text))).toEqual([
        'Reach confirmed.',
        'And payload.',
      ]);

      // 3. Search and users.
      const found = await notion.search({ query: 'arm des' });
      expect(found.results.map((r) => r.id)).toEqual([page.id]);
      expect(found.type).toBe(v2025 ? 'page_or_data_source' : 'page_or_database');
      const users = await collectPaginatedAPI(notion.users.list, {});
      expect(users.every((u) => isFullUser(u))).toBe(true);
      expect(users.map((u) => [u.id, u.type])).toEqual(
        expect.arrayContaining([
          [w.ada.id, 'person'],
          [w.bot.id, 'bot'],
        ]),
      );
      const person = users.find((u) => u.id === w.ada.id) as Json;
      expect(person.person).toEqual({});
      expect(await notion.users.me({})).toMatchObject({ type: 'bot', name: 'Conformance' });

      // Errors, as the SDK knows them.
      const error = (promise: Promise<unknown>) =>
        promise.then(
          () => null,
          (e: unknown) => e,
        );
      const missing = await error(notion.pages.retrieve({ page_id: SECRETS }));
      expect(missing).toBeInstanceOf(APIResponseError);
      expect((missing as APIResponseError).code).toBe(APIErrorCode.ObjectNotFound);
      expect((missing as APIResponseError).status).toBe(404);
      const invalid = await error(
        notion.pages.update({ page_id: page.id, properties: { Nope: { checkbox: true } } }),
      );
      expect((invalid as APIResponseError).code).toBe(APIErrorCode.ValidationError);
      const unauthorized = await error(
        new Client({
          auth: 'ntn_wrong',
          baseUrl: w.base,
          notionVersion: version,
          retry: false,
        }).users.me({}),
      );
      expect((unauthorized as APIResponseError).code).toBe(APIErrorCode.Unauthorized);
    });

    it('rate limited: 429 rate_limited with Retry-After', async () => {
      const w = await world({ perSecond: 0.5, burst: 3 });
      const notion = new Client({
        auth: w.bot.token,
        baseUrl: w.base,
        notionVersion: version,
        retry: false,
      });
      for (let i = 0; i < 3; i++) await notion.users.me({});
      const limited = await notion.users.me({}).then(
        () => null,
        (e: unknown) => e,
      );
      expect((limited as APIResponseError).code).toBe(APIErrorCode.RateLimited);
      expect((limited as APIResponseError).status).toBe(429);
      const raw = await fetch(`${w.base}/v1/users/me`, {
        headers: { authorization: `Bearer ${w.bot.token}`, 'notion-version': version },
      });
      expect(raw.status).toBe(429);
      expect(Number(raw.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
      expect(await raw.json()).toMatchObject({
        object: 'error',
        status: 429,
        code: 'rate_limited',
      });
    });
  },
);
