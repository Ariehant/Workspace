/**
 * What an integration sees, for one API request: the pages, databases and rows shared
 * with its bot (the same `AccessService` that decides for people), read from the docs,
 * and written back through `ctx.docs.edit` as the bot, past the same checks as a
 * person's client.
 */
import {
  ApiError,
  databaseObject,
  dataSourceObject,
  notFound,
  pageObject,
  propertiesObject,
  richText,
  schemaObject,
  type ApiVersion,
  type Common,
  type FileLinks,
  type Parent,
} from '@workspace/api-model';
import {
  MEMBERS_DOC_ID,
  WORKSPACE_DOC_ID,
  getPage,
  isInTrash,
  listPages,
  userNames,
  type PageMeta,
} from '@workspace/core';
import {
  ComputedCache,
  isDatabaseDoc,
  readDatabase,
  readMeta,
  rowsMap,
  type DatabaseSnapshot,
  type DisplayContext,
  type Property,
  type Row,
} from '@workspace/database';
import type { Capabilities, Integration, Scope, ScopeRole } from '@workspace/storage-remote';
import * as Y from 'yjs';
import { atLeast } from '../access/roles';
import type { WorkspaceAccess } from '../access/service';
import type { ServerContext } from '../context';
import { EditRefused } from '../docs-edit';

export type Located =
  | { kind: 'page'; id: string; scope: Scope; tree: Y.Doc; meta: PageMeta }
  | { kind: 'database'; id: string; scope: Scope; tree: Y.Doc; meta: PageMeta; db: Y.Doc }
  | { kind: 'row'; id: string; database: Extract<Located, { kind: 'database' }>; row: Row };

export type DatabaseLocated = Extract<Located, { kind: 'database' }>;

/** Rows the API made, before the search index has them (row id → database id). */
const madeRows = new Map<string, string>();
const MAX_MADE = 10_000;

export function rememberRow(rowId: string, databaseId: string) {
  if (madeRows.size >= MAX_MADE) madeRows.delete(madeRows.keys().next().value!);
  madeRows.set(rowId, databaseId);
}

export class ApiView {
  readonly botId: string;
  readonly workspaceId: string;
  private readonly roles: ReadonlyMap<string, ScopeRole>;
  private readonly docs = new Map<string, Promise<Y.Doc | null>>();
  private readonly computed = new Map<string, DatabaseSnapshot>();
  private ctxCache: DisplayContext | null = null;

  constructor(
    readonly ctx: ServerContext,
    readonly integration: Integration,
    readonly version: ApiVersion,
    readonly access: WorkspaceAccess,
  ) {
    this.botId = integration.id;
    this.workspaceId = integration.workspaceId;
    this.roles = access.roles(integration.id);
  }

  // --- Capabilities and access ------------------------------------------------------

  /** Refuse unless the integration has this capability. */
  need(capability: Exclude<keyof Capabilities, 'userInfo'>): void {
    if (!this.integration.capabilities[capability]) {
      throw new ApiError(
        'restricted_resource',
        'Insufficient permissions for this endpoint: the integration lacks a capability.',
      );
    }
  }

  /** Scopes the bot may read. */
  readableScopes(): Scope[] {
    return [...this.roles.entries()]
      .filter(([, role]) => atLeast(role, 'view'))
      .map(([id]) => this.access.scope(id))
      .filter((s): s is Scope => s !== undefined);
  }

  // --- Docs -------------------------------------------------------------------------

  doc(docId: string): Promise<Y.Doc | null> {
    let loading = this.docs.get(docId);
    if (!loading) {
      loading = this.ctx.store.docState(this.workspaceId, docId).then((state) => {
        if (!state) return null;
        const doc = new Y.Doc();
        Y.applyUpdate(doc, state);
        return doc;
      });
      this.docs.set(docId, loading);
    }
    return loading;
  }

  /**
   * Change a doc as the bot. Refused (403 `restricted_resource`) where the bot may not;
   * the doc is read afresh afterwards.
   */
  async edit<T>(docId: string, change: (doc: Y.Doc) => T, scope?: string): Promise<T> {
    try {
      const { result } = await this.ctx.docs.edit(
        this.workspaceId,
        docId,
        { userId: this.botId },
        change,
        { scope: scope ?? null },
      );
      return result;
    } catch (error) {
      if (error instanceof EditRefused) {
        throw new ApiError(
          'restricted_resource',
          'Insufficient permissions: the integration may not edit this. Share it with the integration with edit access.',
        );
      }
      throw error;
    } finally {
      this.docs.delete(docId);
      this.computed.clear();
    }
  }

  /**
   * Change a doc that may change others too (two-way relations): `change` gets a
   * resolver; the other docs it touches are written after it, each as the bot.
   */
  async editLinked(
    docId: string,
    others: readonly string[],
    change: (doc: Y.Doc, resolve: (id: string) => Y.Doc | undefined) => void,
    scope?: string,
  ): Promise<void> {
    const scratch = new Map<string, { doc: Y.Doc; updates: Uint8Array[] }>();
    for (const id of others) {
      if (id === docId || scratch.has(id)) continue;
      const doc = new Y.Doc();
      const state = await this.ctx.store.docState(this.workspaceId, id);
      if (state) Y.applyUpdate(doc, state);
      const updates: Uint8Array[] = [];
      doc.on('update', (u: Uint8Array) => updates.push(u));
      scratch.set(id, { doc, updates });
    }
    try {
      await this.edit(
        docId,
        (doc) => change(doc, (id) => (id === docId ? doc : scratch.get(id)?.doc)),
        scope,
      );
      for (const [id, { updates }] of scratch) {
        if (updates.length === 0) continue;
        const merged = Y.mergeUpdates(updates);
        await this.edit(id, (doc) => Y.applyUpdate(doc, merged));
      }
    } finally {
      for (const { doc } of scratch.values()) doc.destroy();
    }
  }

  // --- Finding things ---------------------------------------------------------------

  /** A page, database or row the bot may read, by id; 404 otherwise. */
  async locate(id: string): Promise<Located> {
    const found = await this.find(id);
    if (!found) throw notFound(id);
    return found;
  }

  async find(id: string): Promise<Located | null> {
    // A page or database: in the tree of a scope the bot reads.
    const placed = this.access.placementOf(id);
    const scopes = this.readableScopes();
    const ordered = placed ? [...scopes].sort((a) => (a.id === placed ? -1 : 0)) : scopes;
    for (const scope of ordered) {
      const tree = await this.doc(scope.treeDoc);
      const meta = tree && getPage(tree, id);
      if (!tree || !meta) continue;
      if (meta.kind === 'database') {
        const db = await this.doc(id);
        if (!db || !isDatabaseDoc(db)) return null;
        return { kind: 'database', id, scope, tree, meta, db };
      }
      return { kind: 'page', id, scope, tree, meta };
    }
    // A row: its database (the bot must read that).
    const databaseId =
      madeRows.get(id) ??
      this.access.databaseOfRow(id) ??
      (await this.ctx.store.search.locate(this.workspaceId, id))?.databaseId ??
      null;
    if (!databaseId || databaseId === id) return this.findRow(id);
    const database = await this.find(databaseId);
    if (database?.kind !== 'database') return null;
    const row = readDatabase(database.db).rows.find((r) => r.id === id && !r.isTemplate);
    return row ? { kind: 'row', id, database, row } : null;
  }

  /** A row not known yet (just made elsewhere): looked for in the databases the bot reads. */
  private async findRow(id: string): Promise<Located | null> {
    for (const scope of this.readableScopes()) {
      const tree = await this.doc(scope.treeDoc);
      if (!tree) continue;
      for (const page of listPages(tree)) {
        if (page.kind !== 'database') continue;
        const db = await this.doc(page.id);
        if (!db || !isDatabaseDoc(db) || !rowsMap(db).has(id)) continue;
        const database = await this.find(page.id);
        if (database?.kind !== 'database') return null;
        const row = readDatabase(db).rows.find((r) => r.id === id && !r.isTemplate);
        return row ? { kind: 'row', id, database, row } : null;
      }
    }
    return null;
  }

  async database(id: string): Promise<DatabaseLocated> {
    const found = await this.locate(id);
    if (found.kind !== 'database') {
      throw new ApiError('validation_error', `${id} is a page, not a database.`);
    }
    return found;
  }

  // --- Values -----------------------------------------------------------------------

  /** Names of people and bots, for computed values (rollups of people, for one). */
  async displayContext(): Promise<DisplayContext> {
    if (!this.ctxCache) {
      const users = userNames(await this.doc(WORKSPACE_DOC_ID), await this.doc(MEMBERS_DOC_ID));
      this.ctxCache = { users, me: this.botId };
    }
    return this.ctxCache;
  }

  /** A database's rows with formulas, rollups and relations computed. */
  async snapshot(database: DatabaseLocated): Promise<DatabaseSnapshot> {
    const cached = this.computed.get(database.id);
    if (cached) return cached;
    const ctx = await this.displayContext();
    // Related databases the bot can't read take no part (nothing of them leaks).
    const related = new Map<string, DatabaseSnapshot>();
    for (const p of readDatabase(database.db).properties) {
      const target = p.type === 'relation' ? (p.config.databaseId ?? '') : '';
      if (!target || target === database.id || related.has(target)) continue;
      const other = await this.find(target);
      if (other?.kind === 'database') related.set(target, readDatabase(other.db));
    }
    const snapshot = new ComputedCache().apply(
      readDatabase(database.db),
      ctx,
      (id) => related.get(id),
      database.id,
    );
    this.computed.set(database.id, snapshot);
    return snapshot;
  }

  /** Properties of another database the bot reads (relations and rollups name them). */
  async propertiesOf(databaseId: string): Promise<readonly Property[] | undefined> {
    const found = await this.find(databaseId);
    return found?.kind === 'database' ? readDatabase(found.db).properties : undefined;
  }

  /** Every readable database's properties, keyed by id (for schemas of relations). */
  async schemaContext(properties: readonly Property[]) {
    const others = new Map<string, readonly Property[]>();
    for (const p of properties) {
      const id = p.type === 'relation' ? (p.config.databaseId ?? '') : '';
      if (id && !others.has(id)) {
        const list = await this.propertiesOf(id);
        if (list) others.set(id, list);
      }
    }
    return { propertiesOf: (id: string) => others.get(id) };
  }

  // --- Objects ----------------------------------------------------------------------

  get links(): FileLinks {
    const base = this.ctx.config.publicUrl;
    return {
      fileUrl: (id) => ({
        url: `${base}/api/workspaces/${this.workspaceId}/files/${id}`,
        expiry_time: new Date(Date.now() + 3600_000).toISOString(),
      }),
      pageUrl: (id) => `${base}/w/${this.workspaceId}#page=${id}`,
    };
  }

  private parentOf(meta: PageMeta): Parent {
    return meta.parentId ? { kind: 'page', id: meta.parentId } : { kind: 'workspace' };
  }

  private pageCommon(found: Extract<Located, { kind: 'page' | 'database' }>): Common {
    const { meta, tree } = found;
    return {
      id: found.id,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      createdBy: null,
      updatedBy: null,
      icon: meta.icon,
      cover: meta.cover,
      trashed: isInTrash(tree, found.id),
      parent: this.parentOf(meta),
    };
  }

  /** A page or a row, as a page object. */
  async pageJson(found: Located) {
    if (found.kind === 'row') {
      const snapshot = await this.snapshot(found.database);
      const row = snapshot.rows.find((r) => r.id === found.id) ?? found.row;
      const common: Common = {
        id: row.id,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        icon: row.icon,
        cover: row.cover,
        trashed: row.trashedAt !== null || isInTrash(found.database.tree, found.database.id),
        parent: { kind: 'database', id: found.database.id },
      };
      return pageObject(
        common,
        propertiesObject(row, snapshot.properties, this.links),
        this.version,
        this.links,
      );
    }
    if (found.kind === 'database') {
      throw new ApiError('validation_error', `${found.id} is a database, not a page.`);
    }
    const title = { id: 'title', type: 'title', title: richText(found.meta.title) };
    return pageObject(this.pageCommon(found), { title }, this.version, this.links);
  }

  /** A database object (with its schema before 2025-09-03). */
  async databaseJson(found: DatabaseLocated) {
    const properties = readDatabase(found.db).properties;
    const schema = schemaObject(properties, await this.schemaContext(properties));
    return databaseObject(
      {
        ...this.pageCommon(found),
        title: found.meta.title,
        description: readMeta(found.db).description,
        isInline: false,
      },
      schema,
      this.version,
      this.links,
    );
  }

  /** A database as a data source (2025-09-03). */
  async dataSourceJson(found: DatabaseLocated) {
    const properties = readDatabase(found.db).properties;
    const schema = schemaObject(properties, await this.schemaContext(properties));
    return dataSourceObject(
      {
        ...this.pageCommon(found),
        title: found.meta.title,
        description: readMeta(found.db).description,
      },
      schema,
      this.links,
    );
  }
}
