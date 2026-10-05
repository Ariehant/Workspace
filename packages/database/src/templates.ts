import { PageField } from '@workspace/core';
import * as Y from 'yjs';
import {
  addRow,
  deleteRow,
  duplicateRow,
  getRowMap,
  readMeta,
  readRow,
  rowsMap,
  setMeta,
  setRowPageFields,
} from './doc';
import { RowField, type DatabaseSnapshot, type Row, type View } from './schema';

/** A row a view shows: not trashed and not a template. */
export const isLiveRow = (row: Row): boolean => row.trashedAt === null && !row.isTemplate;

/** The database's templates, in their order. */
export function templatesOf(snapshot: DatabaseSnapshot): Row[] {
  return snapshot.rows.filter((r) => r.isTemplate && r.trashedAt === null);
}

/** Add an empty template (its page holds the property values and content to copy). */
export function addTemplate(doc: Y.Doc, options: { actor: string | null; title?: string }): string {
  let id = '';
  doc.transact(() => {
    id = addRow(doc, { actor: options.actor, title: options.title ?? '' });
    getRowMap(doc, id).set(RowField.template, true);
  });
  return id;
}

export function duplicateTemplate(doc: Y.Doc, id: string, actor: string | null): string {
  return duplicateRow(doc, id, actor);
}

/** Delete a template for good; views that used it as default fall back to the database's. */
export function deleteTemplate(doc: Y.Doc, id: string): void {
  doc.transact(() => {
    deleteRow(doc, id);
    if (readMeta(doc).defaultTemplateId === id) setMeta(doc, { defaultTemplateId: null });
    for (const view of doc.getMap<Y.Map<unknown>>('views').values()) {
      if (view.get('defaultTemplateId') === id) view.set('defaultTemplateId', null);
    }
  });
}

/**
 * The template "New" uses in a view: the view's choice, else the database default.
 * Null for an empty page.
 */
export function defaultTemplate(snapshot: DatabaseSnapshot, view?: View | null): Row | null {
  const templates = templatesOf(snapshot);
  const choice = view?.defaultTemplateId;
  if (choice === 'none') return null;
  const byView = choice ? templates.find((t) => t.id === choice) : undefined;
  if (byView) return byView;
  const id = snapshot.meta.defaultTemplateId;
  return (id && templates.find((t) => t.id === id)) || null;
}

export interface NewRowOptions {
  actor: string | null;
  /** Values that win over the template's (e.g. the group a row is added in). */
  values?: Record<string, unknown>;
  afterId?: string;
  beforeId?: string;
}

/** Add a row, starting from a template's title, icon, cover and values when given. */
export function addRowFromTemplate(
  doc: Y.Doc,
  templateId: string | null,
  options: NewRowOptions,
): string {
  const template =
    templateId && rowsMap(doc).has(templateId) ? readRow(getRowMap(doc, templateId)) : null;
  let id = '';
  doc.transact(() => {
    id = addRow(doc, {
      actor: options.actor,
      title: template?.title,
      values: { ...(template ? structuredClone(template.values) : {}), ...options.values },
      afterId: options.afterId,
      beforeId: options.beforeId,
    });
    if (template) {
      const { icon, cover, fullWidth, smallText, font } = template;
      setRowPageFields(doc, id, { icon, cover, fullWidth, smallText, font }, options.actor);
    }
  });
  return id;
}

/**
 * Apply a template to an existing row: its title, icon, cover and the values the
 * row doesn't have yet. (The page content is copied by the caller.)
 */
export function applyTemplate(
  doc: Y.Doc,
  rowId: string,
  templateId: string,
  actor: string | null,
): void {
  const template = readRow(getRowMap(doc, templateId));
  const map = getRowMap(doc, rowId);
  const row = readRow(map);
  doc.transact(() => {
    const values = map.get(RowField.values);
    const target = (values instanceof Y.Map ? values : new Y.Map()) as Y.Map<unknown>;
    if (!(values instanceof Y.Map)) map.set(RowField.values, target);
    for (const [key, value] of Object.entries(template.values)) {
      if (!target.has(key)) target.set(key, structuredClone(value));
    }
    const fields: Parameters<typeof setRowPageFields>[2] = {};
    if (!row.icon && template.icon) fields.icon = template.icon;
    if (!row.cover && template.cover) fields.cover = template.cover;
    setRowPageFields(doc, rowId, fields, actor);
    if (!row.title && template.title) {
      (map.get(PageField.title) as Y.Text).insert(0, template.title);
    }
  });
}
