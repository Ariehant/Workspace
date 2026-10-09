/**
 * Pages: `POST /v1/pages` (a row in a database, or a page under a page),
 * `GET|PATCH /v1/pages/:id`, and `GET /v1/pages/:id/properties/:propertyId`.
 * A row's page is a page whose parent is its database, as in Notion.
 */
import {
  ApiError,
  findProperty,
  invalid,
  listObject,
  parseCover,
  parseIcon,
  parseId,
  parsePaging,
  parseParent,
  parseValue,
  propertyValue,
  readRichText,
  richText,
} from '@workspace/api-model';
import {
  createPage,
  newId,
  restorePage,
  setPageIcon,
  setPageOptions,
  setPageTitle,
  trashPage,
} from '@workspace/core';
import {
  TITLE_PROPERTY_ID,
  addRow,
  readDatabase,
  restoreRow,
  setCell,
  setPropertyConfig,
  setRelation,
  setRowPageFields,
  setRowTitle,
  trashRow,
  type Property,
  type SelectOption,
} from '@workspace/database';
import type { FastifyInstance } from 'fastify';
import type * as Y from 'yjs';
import { viewOf } from './plugin';
import { rememberRow, type ApiView, type DatabaseLocated, type Located } from './view';

type Body = Record<string, unknown>;

const asBody = (raw: unknown): Body => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('body should be an object.');
  return raw as Body;
};

/** Property values sent for a row, checked: what to store, and what it makes. */
interface RowChanges {
  title?: string;
  values: Map<string, unknown>;
  relations: Map<string, string[]>;
  options: Map<string, SelectOption[]>;
  /** Databases that two-way relations touch. */
  linked: string[];
}

function readRowChanges(api: ApiView, properties: readonly Property[], raw: unknown): RowChanges {
  const changes: RowChanges = {
    values: new Map(),
    relations: new Map(),
    options: new Map(),
    linked: [],
  };
  if (raw === undefined) return changes;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('body.properties should be an object.');
  }
  const ctx = { isUser: (id: string) => api.access.isMember(id) };
  for (const [key, input] of Object.entries(raw as Body)) {
    const p = findProperty(properties, key);
    if (!p) throw invalid(`${key} is not a property that exists.`);
    const parsed = parseValue(p, input, ctx);
    if (p.id === TITLE_PROPERTY_ID || p.type === 'title') changes.title = parsed.value as string;
    else if (p.type === 'relation') {
      changes.relations.set(p.id, parsed.value as string[]);
      if (p.config.syncedPropertyId) changes.linked.push(p.config.databaseId ?? '');
    } else changes.values.set(p.id, parsed.value);
    if (parsed.newOptions) changes.options.set(p.id, parsed.newOptions);
  }
  return changes;
}

/** Write a row's changes (in its database doc, and two-way relations' other side). */
function applyRowChanges(
  doc: Y.Doc,
  resolve: (id: string) => Y.Doc | undefined,
  databaseId: string,
  rowId: string,
  changes: RowChanges,
  bot: string,
) {
  const properties = readDatabase(doc).properties;
  for (const [id, made] of changes.options) {
    const p = properties.find((x) => x.id === id)!;
    setPropertyConfig(doc, id, { ...p.config, options: [...(p.config.options ?? []), ...made] });
  }
  for (const [id, value] of changes.values) setCell(doc, rowId, id, value, bot);
  if (changes.title !== undefined) setRowTitle(doc, rowId, changes.title, bot);
  for (const [id, ids] of changes.relations) setRelation(resolve, databaseId, rowId, id, ids, bot);
}

/** The title sent for a page that isn't a row (its only property). */
function readPageTitle(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid('body.properties should be an object.');
  }
  let title: string | undefined;
  for (const [key, input] of Object.entries(raw as Body)) {
    const value = input && typeof input === 'object' ? (input as Body).title : undefined;
    if (value === undefined) {
      throw invalid(
        `${key} is not a property that exists: a page outside a database only has a title.`,
      );
    }
    title = readRichText(value, `body.properties.${key}.title`);
  }
  return title;
}

function noChildren(body: Body) {
  const children = body.children ?? body.content;
  if (Array.isArray(children) && children.length > 0) {
    throw invalid('body.children: page content through the API comes in a later version.');
  }
}

async function createRow(api: ApiView, database: DatabaseLocated, body: Body) {
  const properties = readDatabase(database.db).properties;
  const changes = readRowChanges(api, properties, body.properties);
  const icon = body.icon === undefined ? undefined : parseIcon(body.icon);
  if (body.cover !== undefined) parseCover(body.cover);
  const rowId = newId();
  await api.editLinked(database.id, changes.linked, (doc, resolve) => {
    addRow(doc, { id: rowId, actor: api.botId, title: changes.title ?? '' });
    applyRowChanges(doc, resolve, database.id, rowId, { ...changes, title: undefined }, api.botId);
    if (icon !== undefined) setRowPageFields(doc, rowId, { icon }, api.botId);
  });
  rememberRow(rowId, database.id);
  return rowId;
}

async function createSubpage(api: ApiView, parent: Located, body: Body) {
  if (parent.kind !== 'page') {
    throw invalid(
      parent.kind === 'database'
        ? 'body.parent: to add a page to a database, use database_id.'
        : 'body.parent: pages can be added under pages, not under database rows.',
    );
  }
  const title = readPageTitle(body.properties) ?? '';
  const icon = body.icon === undefined ? null : parseIcon(body.icon);
  if (body.cover !== undefined) parseCover(body.cover);
  const id = newId();
  await api.edit(parent.scope.treeDoc, (tree) =>
    createPage(tree, { id, parentId: parent.id, title, icon }),
  );
  return id;
}

async function update(api: ApiView, found: Located, body: Body) {
  const trash = body.in_trash ?? body.archived;
  if (trash !== undefined && typeof trash !== 'boolean')
    throw invalid('body.in_trash should be a boolean.');
  const icon = body.icon === undefined ? undefined : parseIcon(body.icon);
  const cover = body.cover === undefined ? undefined : parseCover(body.cover);
  if (found.kind === 'row') {
    const { database } = found;
    const changes = readRowChanges(api, readDatabase(database.db).properties, body.properties);
    await api.editLinked(database.id, changes.linked, (doc, resolve) => {
      applyRowChanges(doc, resolve, database.id, found.id, changes, api.botId);
      if (icon !== undefined) setRowPageFields(doc, found.id, { icon }, api.botId);
      if (cover !== undefined) setRowPageFields(doc, found.id, { cover }, api.botId);
      if (trash === true) trashRow(doc, found.id);
      if (trash === false) restoreRow(doc, found.id);
    });
    return;
  }
  if (found.kind === 'database') {
    throw invalid(`${found.id} is a database: update it with PATCH /v1/databases/${found.id}.`);
  }
  const title = readPageTitle(body.properties);
  await api.edit(found.scope.treeDoc, (tree) => {
    if (title !== undefined) setPageTitle(tree, found.id, title);
    if (icon !== undefined) setPageIcon(tree, found.id, icon);
    if (cover !== undefined) setPageOptions(tree, found.id, { cover });
    if (trash === true) trashPage(tree, found.id);
    if (trash === false) restorePage(tree, found.id);
  });
}

/** One value of a property: a list for titles, text, people and relations, as Notion does. */
async function propertyItem(
  api: ApiView,
  found: Located,
  key: string,
  query: Record<string, unknown>,
) {
  let property: Property | undefined;
  let value: Record<string, unknown>;
  if (found.kind === 'row') {
    const snapshot = await api.snapshot(found.database);
    const row = snapshot.rows.find((r) => r.id === found.id) ?? found.row;
    property =
      snapshot.properties.find((p) => p.id === key) ??
      (key === 'title' ? snapshot.properties.find((p) => p.type === 'title') : undefined);
    if (!property)
      throw new ApiError('object_not_found', `Could not find property with id: ${key}`);
    value = propertyValue(row, property, api.links);
  } else if (found.kind === 'page' && key === 'title') {
    value = { id: 'title', type: 'title', title: richText(found.meta.title) };
  } else {
    throw new ApiError('object_not_found', `Could not find property with id: ${key}`);
  }
  const type = value.type as string;
  const items = (value[type] ?? []) as unknown[];
  if (!['title', 'rich_text', 'people', 'relation'].includes(type)) {
    return { object: 'property_item', id: value.id, type, [type]: value[type] };
  }
  const listed = items.map((item, i) => ({ i, item }));
  return listObject(
    listed,
    (x) => String(x.i),
    parsePaging(query),
    'property_item',
    (x) => ({ object: 'property_item', id: value.id, type, [type]: x.item }),
    { property_item: { id: value.id, next_url: null, type, [type]: {} } },
  );
}

export function pageRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/pages', async (request) => {
    const api = viewOf(request);
    api.need('insertContent');
    const body = asBody(request.body);
    noChildren(body);
    const parent = parseParent(body.parent);
    if (parent.kind === 'workspace') throw invalid('body.parent should be a page or a database.');
    const target = await api.locate(parent.id);
    let id: string;
    if (parent.kind === 'database') {
      if (target.kind !== 'database')
        throw invalid('body.parent.database_id is a page, not a database.');
      id = await createRow(api, target, body);
    } else {
      id = await createSubpage(api, target, body);
    }
    return api.pageJson(await api.locate(id));
  });

  app.get<{ Params: { id: string } }>('/pages/:id', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    const id = parseId(request.params.id);
    if (!id) throw invalid('path.page_id should be a valid uuid.');
    return api.pageJson(await api.locate(id));
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/pages/:id', async (request) => {
    const api = viewOf(request);
    api.need('updateContent');
    const id = parseId(request.params.id);
    if (!id) throw invalid('path.page_id should be a valid uuid.');
    const body = asBody(request.body);
    await update(api, await api.locate(id), body);
    return api.pageJson(await api.locate(id));
  });

  app.get<{ Params: { id: string; propertyId: string }; Querystring: Record<string, unknown> }>(
    '/pages/:id/properties/:propertyId',
    async (request) => {
      const api = viewOf(request);
      api.need('readContent');
      const id = parseId(request.params.id);
      if (!id) throw invalid('path.page_id should be a valid uuid.');
      return propertyItem(
        api,
        await api.locate(id),
        decodeURIComponent(request.params.propertyId),
        request.query,
      );
    },
  );
}
