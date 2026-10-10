/**
 * Databases and data sources:
 *
 * - `POST /v1/databases` (under a page), `GET|PATCH /v1/databases/:id`
 * - `POST /v1/databases/:id/query`, with Notion's filters, sorts and paging
 * - from 2025-09-03, data sources: `GET|PATCH /v1/data_sources/:id` and
 *   `POST /v1/data_sources/:id/query`. Each database here has exactly one, with the
 *   database's own id; another can't be added.
 */
import {
  compileFilter,
  compileSorts,
  findProperty,
  invalid,
  listObject,
  pageObject,
  parseCover,
  parseIcon,
  parseId,
  parsePaging,
  parseParent,
  parseSchema,
  propertiesObject,
  readRichText,
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
  addProperty,
  changePropertyType,
  createRelation,
  deleteProperty,
  deleteRelation,
  initDatabase,
  readDatabase,
  renameProperty,
  setMeta,
  setPropertyConfig,
  type Property,
} from '@workspace/database';
import type { FastifyInstance } from 'fastify';
import type * as Y from 'yjs';
import { viewOf } from './plugin';
import type { ApiView, DatabaseLocated } from './view';

type Body = Record<string, unknown>;

const asBody = (raw: unknown): Body => {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw invalid('body should be an object.');
  return raw as Body;
};

const asObject = (raw: unknown, where: string): Body => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw invalid(`${where} should be an object.`);
  return raw as Body;
};

/** A schema change, checked before anything is written. */
type SchemaChange =
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; property: Property }
  | { kind: 'retype'; id: string; type: Property['type']; config: Property['config'] }
  | { kind: 'config'; id: string; config: Property['config'] }
  | { kind: 'add'; name: string; type: Property['type']; config: Property['config'] };

/** The properties sent to create or change a database, as changes to make. */
async function readSchemaChanges(
  api: ApiView,
  raw: unknown,
  current: readonly Property[],
  creating: boolean,
): Promise<{ changes: SchemaChange[]; linked: string[] }> {
  const changes: SchemaChange[] = [];
  const linked: string[] = [];
  if (raw === undefined) return { changes, linked };
  const input = asObject(raw, 'body.properties');
  const known = new Map<string, readonly Property[]>();
  for (const p of current) {
    if (p.type === 'relation' && p.config.databaseId && !known.has(p.config.databaseId)) {
      const list = await api.propertiesOf(p.config.databaseId);
      if (list) known.set(p.config.databaseId, list);
    }
  }
  // Relations first, so rollups can go through them.
  const entries = Object.entries(input).sort(([, a], [, b]) => {
    const rollup = (x: unknown) => !!x && typeof x === 'object' && 'rollup' in x;
    return Number(rollup(a)) - Number(rollup(b));
  });
  const planned: Property[] = [...current];
  for (const [key, value] of entries) {
    const where = `body.properties.${key}`;
    const existing = creating ? undefined : findProperty(current, key);
    if (value === null) {
      if (!existing) throw invalid(`${where}: no such property.`);
      if (existing.id === TITLE_PROPERTY_ID)
        throw invalid(`${where}: the title property can't be deleted.`);
      changes.push({ kind: 'delete', property: existing });
      continue;
    }
    const o = asObject(value, where);
    if (typeof o.name === 'string' && existing) {
      changes.push({ kind: 'rename', id: existing.id, name: o.name.trim() || existing.name });
    }
    const hasType = Object.keys(o).some((k) => k !== 'name' && k !== 'description');
    if (!hasType) {
      if (!existing) throw invalid(`${where} should have a property type.`);
      continue;
    }
    // A relation's target must be readable (its properties name rollups).
    const target =
      (o.relation as Body | undefined)?.database_id ??
      (o.relation as Body | undefined)?.data_source_id;
    if (target !== undefined) {
      const id = parseId(target);
      const props = id ? await api.propertiesOf(id) : undefined;
      if (!id || !props)
        throw invalid(`${where}.relation.database_id: no database shared with the integration.`);
      known.set(id, props);
    }
    const parsed = parseSchema(o, where, existing, {
      properties: planned,
      propertiesOf: (id) => known.get(id),
    });
    if (parsed.type === 'title') {
      if (existing && existing.id !== TITLE_PROPERTY_ID)
        throw invalid(`${where}: there's already a title.`);
      changes.push({ kind: 'rename', id: TITLE_PROPERTY_ID, name: existing ? existing.name : key });
      continue;
    }
    if (existing?.id === TITLE_PROPERTY_ID)
      throw invalid(`${where}: the title property keeps its type.`);
    if (existing && existing.type === parsed.type) {
      changes.push({ kind: 'config', id: existing.id, config: parsed.config });
    } else if (existing) {
      if (parsed.type === 'relation')
        throw invalid(`${where}: a property can't be turned into a relation.`);
      changes.push({ kind: 'retype', id: existing.id, type: parsed.type, config: parsed.config });
    } else {
      changes.push({ kind: 'add', name: key, type: parsed.type, config: parsed.config });
      if (parsed.type === 'relation' && (parsed.config as { twoWay?: boolean }).twoWay) {
        linked.push(parsed.config.databaseId ?? '');
      }
      // Rollups later in this request may go through it.
      planned.push({
        id: `new:${key}`,
        name: key,
        type: parsed.type,
        config: parsed.config,
        sortKey: '',
      });
    }
  }
  return { changes, linked };
}

function applySchema(
  doc: Y.Doc,
  resolve: (id: string) => Y.Doc | undefined,
  databaseId: string,
  title: string,
  changes: readonly SchemaChange[],
) {
  const ids = new Map<string, string>();
  for (const change of changes) {
    switch (change.kind) {
      case 'rename':
        renameProperty(doc, change.id, change.name);
        break;
      case 'delete':
        if (change.property.type === 'relation')
          deleteRelation(resolve, databaseId, change.property.id);
        else deleteProperty(doc, change.property.id);
        break;
      case 'retype':
        changePropertyType(doc, change.id, change.type, { users: new Map() }, change.config);
        break;
      case 'config': {
        const current = readDatabase(doc).properties.find((p) => p.id === change.id)!;
        setPropertyConfig(doc, change.id, { ...current.config, ...change.config });
        break;
      }
      case 'add': {
        if (change.type === 'relation') {
          const twoWay = (change.config as { twoWay?: boolean }).twoWay;
          const made = createRelation(resolve, {
            databaseId,
            name: change.name,
            targetId: change.config.databaseId ?? '',
            twoWay: twoWay ? { name: `Related to ${title || 'Untitled'}` } : null,
          });
          ids.set(`new:${change.name}`, made.propertyId);
          break;
        }
        const config = { ...change.config };
        if (change.type === 'rollup' && config.relationId?.startsWith('new:')) {
          config.relationId = ids.get(config.relationId) ?? config.relationId;
        }
        addProperty(doc, { name: change.name, type: change.type, config });
      }
    }
  }
}

function readTitle(raw: unknown, where: string): string | undefined {
  return raw === undefined ? undefined : readRichText(raw, where);
}

async function createDatabase(api: ApiView, body: Body) {
  const parent = parseParent(body.parent);
  if (parent.kind !== 'page') throw invalid('body.parent should be a page_id.');
  const page = await api.locate(parent.id);
  if (page.kind !== 'page')
    throw invalid('body.parent.page_id should be a page, not a database or a row.');
  const title = readTitle(body.title, 'body.title') ?? '';
  const description = readTitle(body.description, 'body.description');
  const icon = body.icon === undefined ? null : parseIcon(body.icon);
  if (body.cover !== undefined) parseCover(body.cover);
  const schemaInput =
    api.version === '2025-09-03'
      ? (asObject(body.initial_data_source ?? {}, 'body.initial_data_source').properties ??
        body.properties)
      : body.properties;
  if (schemaInput === undefined) throw invalid('body.properties should be defined.');
  const titled = Object.values(asObject(schemaInput, 'body.properties')).some(
    (p) => !!p && typeof p === 'object' && ((p as Body).type === 'title' || 'title' in (p as Body)),
  );
  if (!titled) throw invalid('body.properties: a database needs one title property.');
  const id = newId();
  const { changes, linked } = await readSchemaChanges(api, schemaInput, [], true);
  await api.edit(page.scope.treeDoc, (tree) =>
    createPage(tree, { id, parentId: page.id, kind: 'database', title, icon }),
  );
  await api.editLinked(
    id,
    linked,
    (doc, resolve) => {
      initDatabase(doc, { databaseId: id });
      // Only the properties asked for (not the new database's "Tags").
      for (const p of readDatabase(doc).properties) {
        if (p.id !== TITLE_PROPERTY_ID) deleteProperty(doc, p.id);
      }
      applySchema(doc, resolve, id, title, changes);
      if (description) setMeta(doc, { description });
    },
    page.scope.id,
  );
  return api.database(id);
}

async function updateDatabase(
  api: ApiView,
  found: DatabaseLocated,
  body: Body,
  schemaToo: boolean,
) {
  const title = readTitle(body.title, 'body.title');
  const description = readTitle(body.description, 'body.description');
  const icon = body.icon === undefined ? undefined : parseIcon(body.icon);
  const cover = body.cover === undefined ? undefined : parseCover(body.cover);
  const trash = body.in_trash ?? body.archived;
  if (trash !== undefined && typeof trash !== 'boolean')
    throw invalid('body.in_trash should be a boolean.');
  const current = readDatabase(found.db).properties;
  const { changes, linked } = schemaToo
    ? await readSchemaChanges(api, body.properties, current, false)
    : { changes: [], linked: [] };
  if (title !== undefined || icon !== undefined || cover !== undefined || trash !== undefined) {
    await api.edit(found.scope.treeDoc, (tree) => {
      if (title !== undefined) setPageTitle(tree, found.id, title);
      if (icon !== undefined) setPageIcon(tree, found.id, icon);
      if (cover !== undefined) setPageOptions(tree, found.id, { cover });
      if (trash === true) trashPage(tree, found.id);
      if (trash === false) restorePage(tree, found.id);
    });
  }
  const others = [
    ...linked,
    ...changes.flatMap((c) =>
      c.kind === 'delete' && c.property.type === 'relation' && c.property.config.syncedPropertyId
        ? [c.property.config.databaseId ?? '']
        : [],
    ),
  ];
  if (changes.length || description !== undefined) {
    await api.editLinked(found.id, others, (doc, resolve) => {
      applySchema(doc, resolve, found.id, title ?? found.meta.title, changes);
      if (description !== undefined) setMeta(doc, { description });
    });
  }
  return api.database(found.id);
}

/** Rows of a database that pass a query, in its order (manual order breaks ties). */
async function query(api: ApiView, found: DatabaseLocated, body: Body, filterProperties: string[]) {
  const snapshot = await api.snapshot(found);
  const test = compileFilter(body.filter, snapshot.properties);
  const sort = compileSorts(body.sorts, snapshot.properties);
  const inTrash = body.in_trash === true || body.archived === true;
  const rows = snapshot.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !row.isTemplate && (row.trashedAt !== null) === inTrash && test(row))
    .sort((a, b) => sort(a.row, b.row) || a.index - b.index);
  const shown = filterProperties.length
    ? snapshot.properties.filter(
        (p) => filterProperties.includes(p.id) || filterProperties.includes(p.name),
      )
    : snapshot.properties;
  const links = api.links;
  return listObject(
    rows,
    (r) => r.row.id,
    parsePaging(body),
    // (From 2025-09-03, lists of pages and data sources.)
    api.version === '2025-09-03' ? 'page_or_data_source' : 'page_or_database',
    ({ row }) =>
      pageObject(
        {
          id: row.id,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          createdBy: row.createdBy,
          updatedBy: row.updatedBy,
          icon: row.icon,
          cover: row.cover,
          trashed: row.trashedAt !== null,
          parent: { kind: 'database', id: found.id },
        },
        propertiesObject(row, shown, links),
        api.version,
        links,
      ),
  );
}

const listParam = (raw: unknown): string[] =>
  raw === undefined ? [] : (Array.isArray(raw) ? raw : [raw]).map(String);

const pathId = (raw: string, name: string) => {
  const id = parseId(raw);
  if (!id) throw invalid(`path.${name} should be a valid uuid.`);
  return id;
};

export function databaseRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>('/databases', async (request) => {
    const api = viewOf(request);
    api.need('insertContent');
    const found = await createDatabase(api, asBody(request.body));
    return api.databaseJson(found);
  });

  app.get<{ Params: { id: string } }>('/databases/:id', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    return api.databaseJson(await api.database(pathId(request.params.id, 'database_id')));
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/databases/:id', async (request) => {
    const api = viewOf(request);
    api.need('updateContent');
    const found = await api.database(pathId(request.params.id, 'database_id'));
    const updated = await updateDatabase(api, found, asBody(request.body), true);
    return api.databaseJson(updated);
  });

  app.post<{ Params: { id: string }; Body: unknown; Querystring: Record<string, unknown> }>(
    '/databases/:id/query',
    async (request) => {
      const api = viewOf(request);
      api.need('readContent');
      const found = await api.database(pathId(request.params.id, 'database_id'));
      return query(api, found, asBody(request.body), listParam(request.query['filter_properties']));
    },
  );

  // --- Data sources (2025-09-03) -----------------------------------------------------

  app.post('/data_sources', async () => {
    throw invalid('A database here has exactly one data source: create a database instead.');
  });

  app.get<{ Params: { id: string } }>('/data_sources/:id', async (request) => {
    const api = viewOf(request);
    api.need('readContent');
    return api.dataSourceJson(await api.database(pathId(request.params.id, 'data_source_id')));
  });

  app.patch<{ Params: { id: string }; Body: unknown }>('/data_sources/:id', async (request) => {
    const api = viewOf(request);
    api.need('updateContent');
    const found = await api.database(pathId(request.params.id, 'data_source_id'));
    const updated = await updateDatabase(api, found, asBody(request.body), true);
    return api.dataSourceJson(updated);
  });

  app.post<{ Params: { id: string }; Body: unknown; Querystring: Record<string, unknown> }>(
    '/data_sources/:id/query',
    async (request) => {
      const api = viewOf(request);
      api.need('readContent');
      const found = await api.database(pathId(request.params.id, 'data_source_id'));
      return query(api, found, asBody(request.body), listParam(request.query['filter_properties']));
    },
  );
}
