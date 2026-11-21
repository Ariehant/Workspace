import { createPage, newId, type PageId } from '@workspace/core';
import {
  OPTION_COLORS,
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addView,
  deleteProperty,
  initDatabase,
  readDatabase,
  readViews,
  renameProperty,
  setViewType,
  updateView,
  type OptionColor,
  type PropertyConfig,
  type PropertyType,
  type SelectOption,
  type ViewType,
} from '@workspace/database';
import { appendContent, type JSONContent } from '@workspace/editor';
import type * as Y from 'yjs';
import type { ImportOptions, ImportReport, ImportTarget } from './import';
import type { LinkTarget } from './markdown';
import { mediaType } from './paths';

const COLORS = OPTION_COLORS.filter((c) => c !== 'default');

/** A database's column, with its options (select-like types) known up front. */
export interface ColumnSpec {
  name: string;
  type: PropertyType;
  /** Options in order, optionally coloured. */
  options?: { name: string; color?: OptionColor }[];
  config?: PropertyConfig;
}

/** A database being filled: its properties by name, options by name, and rows. */
export class DatabaseBuilder {
  private readonly properties = new Map<string, { id: string; type: PropertyType }>();
  private readonly options = new Map<string, Map<string, string>>();

  constructor(
    readonly id: string,
    readonly doc: Y.Doc,
    private readonly onRow: () => void,
  ) {}

  /** @internal */ define(column: ColumnSpec, title: boolean): void {
    let id = TITLE_PROPERTY_ID;
    if (title) renameProperty(this.doc, TITLE_PROPERTY_ID, column.name);
    else {
      const options: SelectOption[] | undefined = column.options?.map((o, i) => ({
        id: newId(),
        name: o.name,
        color: o.color ?? COLORS[i % COLORS.length]!,
      }));
      id = addProperty(this.doc, {
        name: column.name,
        type: column.type,
        config: options ? { ...column.config, options } : column.config,
      });
      if (options) this.options.set(column.name, new Map(options.map((o) => [o.name, o.id])));
    }
    this.properties.set(column.name, { id, type: title ? 'title' : column.type });
  }

  /** A property's id. */
  property(name: string): string {
    return this.properties.get(name)!.id;
  }

  /**
   * A row. Values by column name: text for text-like columns, option names for selects,
   * `YYYY-MM-DD[THH:mm]` (or `{ start, end }`) for dates, booleans for checkboxes, numbers for
   * numbers.
   */
  row(row: {
    id?: string;
    title: string;
    values?: Record<string, unknown>;
    /** Its created time. */
    at?: number;
  }): string {
    const values: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(row.values ?? {})) {
      const property = this.properties.get(name);
      if (!property || raw === null || raw === undefined || raw === '') continue;
      const ids = this.options.get(name);
      if (property.type === 'select' || property.type === 'status') {
        const id = ids?.get(String(raw));
        if (id) values[property.id] = id;
      } else if (property.type === 'multiSelect') {
        const list = (Array.isArray(raw) ? raw : [raw]).flatMap((n) => {
          const id = ids?.get(String(n));
          return id ? [id] : [];
        });
        if (list.length) values[property.id] = list;
      } else if (property.type === 'date') {
        values[property.id] =
          typeof raw === 'object' && 'start' in raw ? raw : { start: String(raw) };
      } else values[property.id] = raw;
    }
    const id = addRow(this.doc, {
      actor: null,
      id: row.id,
      title: row.title,
      values,
      ...(row.at !== undefined ? { now: row.at } : {}),
    });
    this.onRow();
    return id;
  }

  /** Make the first view this layout, grouped by a column (a board by list). */
  layout(type: ViewType, name: string, groupBy?: string): void {
    const [first] = readViews(this.doc);
    if (!first) addView(this.doc, { viewSet: this.id, name, type });
    const view = first ?? readViews(this.doc)[0]!;
    setViewType(this.doc, view.id, type);
    updateView(this.doc, view.id, {
      name,
      ...(groupBy ? { groupBy: { propertyId: this.property(groupBy) } } : {}),
    });
  }
}

/** Builds an import: pages, databases and rows under one new page, and the report. */
export class ImportBuilder {
  readonly rootId: PageId;
  private readonly warnings = new Set<string>();
  private readonly top: string[] = [];
  private pages = 0;
  private databases = 0;
  private rows = 0;
  private files = 0;

  constructor(
    private readonly target: ImportTarget,
    options: ImportOptions,
  ) {
    this.rootId = createPage(target.workspace, {
      title: options.title,
      parentId: options.parentId ?? null,
    });
  }

  warn(message: string): void {
    this.warnings.add(message);
  }

  /** The page made for the import, for content of its own (one document imported): counted as one. */
  usePage(): string {
    this.pages++;
    return this.rootId;
  }

  /** A new page (under the page made for the import, by default). */
  page(title: string, parentId: string | null = null, id = newId()): string {
    createPage(this.target.workspace, {
      id,
      parentId: parentId ?? this.rootId,
      title: title || 'Untitled',
    });
    if (!parentId) this.top.push(id);
    this.pages++;
    return id;
  }

  /** A new database page with these columns (the first is the title). */
  database(title: string, columns: ColumnSpec[], parentId: string | null = null): DatabaseBuilder {
    const id = newId();
    createPage(this.target.workspace, {
      id,
      parentId: parentId ?? this.rootId,
      title: title || 'Untitled',
      kind: 'database',
    });
    if (!parentId) this.top.push(id);
    this.databases++;
    const doc = this.target.doc(id);
    initDatabase(doc, { databaseId: id });
    const db = new DatabaseBuilder(id, doc, () => this.rows++);
    doc.transact(() => {
      for (const p of readDatabase(doc).properties) {
        if (p.id !== TITLE_PROPERTY_ID) deleteProperty(doc, p.id);
      }
      columns.forEach((column, i) => db.define(column, i === 0));
    });
    return db;
  }

  /** Add blocks to a page's (or row's) content. */
  content(id: string, blocks: (JSONContent | string)[]): void {
    if (!blocks.length) return;
    for (const type of appendContent(this.target.doc(id), blocks)) {
      this.warn(`Some “${type}” blocks couldn't be imported`);
    }
  }

  /** Store an attachment, as a link target for the converters. */
  file(bytes: Uint8Array, name: string, mime: string): LinkTarget {
    const fileId = this.target.storeFile(bytes, name, mime);
    if (!fileId) return { kind: 'missing' };
    this.files++;
    return { kind: 'file', fileId, name, media: mediaType(name) };
  }

  /** Finish: the page made for the import lists what it holds; the report. */
  done(): ImportReport {
    this.content(
      this.rootId,
      this.top.map((pageId) => ({ type: 'pageLink', attrs: { pageId } })),
    );
    return {
      rootId: this.rootId,
      pages: this.pages,
      databases: this.databases,
      rows: this.rows,
      files: this.files,
      warnings: [...this.warnings],
    };
  }
}
