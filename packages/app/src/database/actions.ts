import { copyPageContent, type DocClient } from '@workspace/core';
import {
  addRowFromTemplate,
  applyTemplate,
  defaultTemplate,
  deleteProperty,
  deleteRelation,
  duplicateRow,
  relationIds,
  setCell,
  setRelation,
  syncTwoWayLinks,
  updateRelation,
  type DatabaseHandle,
  type DatabaseSnapshot,
  type NewRowOptions,
  type Property,
  type View,
} from '@workspace/database';
import type { DatabaseRegistry } from './registry';

/** Duplicate a row with its page content, right after it. Resolves the copy's id. */
export async function duplicateRowWithContent(
  client: DocClient,
  databases: DatabaseRegistry,
  handle: DatabaseHandle,
  rowId: string,
  actor: string,
): Promise<string> {
  const copy = duplicateRow(handle.doc, rowId, actor);
  // The copy shows up on the other side of two-way relations too.
  syncTwoWayLinks(databases.resolveDoc, handle.id, copy);
  const from = client.acquire(rowId);
  const to = client.acquire(copy);
  try {
    await Promise.all([from.ready, to.ready]);
    copyPageContent(from.doc, to.doc);
  } finally {
    from.release();
    to.release();
  }
  return copy;
}

/** Set a cell; relations go through `setRelation` so two-way links stay in sync. */
export function writeCell(
  databases: DatabaseRegistry,
  handle: DatabaseHandle,
  rowId: string,
  property: Property,
  value: unknown,
  actor: string,
): void {
  if (property.type === 'relation') {
    setRelation(databases.resolveDoc, handle.id, rowId, property.id, relationIds(value), actor);
  } else {
    setCell(handle.doc, rowId, property.id, value, actor);
  }
}

/** Delete a property; a two-way relation's other side becomes one-way. */
export function removeProperty(
  databases: DatabaseRegistry,
  handle: DatabaseHandle,
  property: Property,
): void {
  if (property.type === 'relation') deleteRelation(databases.resolveDoc, handle.id, property.id);
  else deleteProperty(handle.doc, property.id);
}

/** Before a relation changes to another type: unlink its other side. */
export function detachRelation(
  databases: DatabaseRegistry,
  handle: DatabaseHandle,
  property: Property,
): void {
  if (property.type === 'relation' && property.config.syncedPropertyId) {
    updateRelation(databases.resolveDoc, handle.id, property.id, { twoWay: null });
  }
}

/** Copy a template's page content into a row's page. */
export async function copyTemplateContent(
  client: DocClient,
  templateId: string,
  rowId: string,
): Promise<void> {
  const from = client.acquire(templateId);
  const to = client.acquire(rowId);
  try {
    await Promise.all([from.ready, to.ready]);
    copyPageContent(from.doc, to.doc);
  } finally {
    from.release();
    to.release();
  }
}

/**
 * Add a row the way "New" does: from the view's default template (or `templateId`;
 * null for an empty page), copying the template's content too. Returns the row id.
 */
export function newRow(
  client: DocClient,
  handle: DatabaseHandle,
  snapshot: DatabaseSnapshot,
  view: View | null,
  options: NewRowOptions & { templateId?: string | null },
): string {
  const templateId =
    options.templateId !== undefined
      ? options.templateId
      : (defaultTemplate(snapshot, view)?.id ?? null);
  const id = addRowFromTemplate(handle.doc, templateId, options);
  if (templateId) void copyTemplateContent(client, templateId, id);
  return id;
}

/** Apply a template to an existing (empty) row: values, icon, title and content. */
export async function applyTemplateToRow(
  client: DocClient,
  handle: DatabaseHandle,
  rowId: string,
  templateId: string,
  actor: string,
): Promise<void> {
  applyTemplate(handle.doc, rowId, templateId, actor);
  await copyTemplateContent(client, templateId, rowId);
}
