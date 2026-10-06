import { createPage, type PageId } from '@workspace/core';
import {
  OPTION_COLORS,
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addView,
  captureBundle,
  createRelation,
  deleteProperty,
  initDatabase,
  propertyKind,
  readDatabase,
  renameProperty,
  setRelation,
  type PageBundle,
  type PropertyConfig,
  type PropertyType,
  type SelectOption,
  type ViewConfig,
  type ViewType,
} from '@workspace/database';
import { appendContent, type ContentPart } from '@workspace/editor';
import * as Y from 'yjs';

export interface PropertySpec {
  name: string;
  type: PropertyType;
  /** Select-like types: option names (colors are assigned in order). */
  options?: string[];
}

export interface ViewSpec {
  name: string;
  type: ViewType;
  /** Board: group by this property. Calendar/timeline: date property. */
  by?: string;
}

export interface DatabaseSpec {
  title: string;
  icon?: string;
  /** Name of the title property (default "Name"). */
  titleName?: string;
  properties: PropertySpec[];
  /** Cells by property name, as text (the title under the title property's name). */
  rows: Record<string, string>[];
  /** Views after the first table. */
  views?: ViewSpec[];
}

const SELECT_LIKE = new Set<PropertyType>(['select', 'multiSelect']);
const COLORS = OPTION_COLORS.filter((c) => c !== 'default');

/**
 * Builds a template's pages in a scratch workspace, then packs them up as a bundle —
 * the same form "Save as template" produces from real pages.
 */
export class TemplateBuilder {
  readonly workspace = new Y.Doc();
  private readonly docs = new Map<string, Y.Doc>();

  doc(id: string): Y.Doc {
    let doc = this.docs.get(id);
    if (!doc) this.docs.set(id, (doc = new Y.Doc()));
    return doc;
  }

  page(options: {
    title: string;
    icon?: string;
    parentId?: PageId;
    content?: readonly ContentPart[];
  }): PageId {
    const id = createPage(this.workspace, {
      title: options.title,
      icon: options.icon ?? null,
      parentId: options.parentId ?? null,
    });
    if (options.content) appendContent(this.doc(id), options.content);
    return id;
  }

  /** A full-page database with its properties, rows and views. */
  database(spec: DatabaseSpec, parentId?: PageId): PageId {
    const id = createPage(this.workspace, {
      title: spec.title,
      icon: spec.icon ?? null,
      parentId: parentId ?? null,
      kind: 'database',
    });
    const doc = this.doc(id);
    initDatabase(doc, { databaseId: id });
    doc.transact(() => {
      for (const p of readDatabase(doc).properties) {
        if (p.id !== TITLE_PROPERTY_ID) deleteProperty(doc, p.id);
      }
      if (spec.titleName) renameProperty(doc, TITLE_PROPERTY_ID, spec.titleName);
      for (const p of spec.properties) {
        let config: PropertyConfig | undefined;
        if (p.options && SELECT_LIKE.has(p.type)) {
          config = {
            options: p.options.map<SelectOption>((name, i) => ({
              id: `${p.name}-${i}`,
              name,
              color: COLORS[i % COLORS.length]!,
            })),
          };
        }
        addProperty(doc, { name: p.name, type: p.type, config });
      }
      for (const cells of spec.rows) this.addRow(id, cells);
      for (const view of spec.views ?? []) this.addView(id, view);
    });
    return id;
  }

  addRow(databaseId: PageId, cells: Record<string, string>): string {
    const doc = this.doc(databaseId);
    const properties = readDatabase(doc).properties;
    const titleName = properties.find((p) => p.id === TITLE_PROPERTY_ID)!.name;
    const values: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(cells)) {
      const property = properties.find((p) => p.name === name);
      if (!property || property.id === TITLE_PROPERTY_ID || !text) continue;
      const { value } = propertyKind(property.type).parse(text, property, { users: new Map() });
      if (value !== null && value !== undefined) values[property.id] = value;
    }
    return addRow(doc, { actor: null, title: cells[titleName] ?? '', values });
  }

  addView(databaseId: PageId, view: ViewSpec): void {
    const doc = this.doc(databaseId);
    const by = view.by && readDatabase(doc).properties.find((p) => p.name === view.by)?.id;
    const config: Partial<ViewConfig> = {};
    if (by && view.type === 'board') config.groupBy = { propertyId: by };
    if (by && (view.type === 'calendar' || view.type === 'timeline')) config.dateProperty = by;
    addView(doc, { viewSet: databaseId, name: view.name, type: view.type, config });
  }

  /** A two-way relation between two databases of the template. */
  relate(
    from: { databaseId: PageId; name: string },
    to: { databaseId: PageId; name: string },
  ): { propertyId: string; syncedPropertyId: string } {
    const result = createRelation((id) => this.docs.get(id), {
      databaseId: from.databaseId,
      name: from.name,
      targetId: to.databaseId,
      twoWay: { name: to.name },
    });
    return { propertyId: result.propertyId, syncedPropertyId: result.syncedPropertyId! };
  }

  link(databaseId: PageId, rowId: string, propertyId: string, ids: string[]): void {
    setRelation((id) => this.docs.get(id), databaseId, rowId, propertyId, ids, null);
  }

  /** Text for a row's page. */
  rowContent(rowId: string, content: readonly ContentPart[]): void {
    appendContent(this.doc(rowId), content);
  }

  bundle(root: PageId): Promise<PageBundle> {
    return captureBundle(this.workspace, root, async (id, use) => use(this.doc(id)));
  }
}

/** `YYYY-MM-DD` for `days` from today (templates' sample dates follow the calendar). */
export function day(days: number, from = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
